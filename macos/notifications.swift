// Notifications of the app. The app shows them itself, from what the server tells it on its own (`shellevents.swift`): the
// page shows none, and nothing depends on one being there, which is what lets the app run without a window (#627). The
// window's WKWebView gives a page no usable `Notification` (it reports no permission that can be asked for, and constructing
// one shows nothing), so what is left for the page is Settings › Notifications: it asks this bridge (see
// web/src/lib/shell-notify.ts, which has the protocol) what macOS allows and for macOS to allow it, a script message handler
// answering from UNUserNotificationCenter. A click on a notification opens the window on the conversation: the page is told which
// one to open once it is up.
import AppKit
import UserNotifications
import WebKit

// MARK: - What the page may ask

/// What a page is told about the permission: the browser's own words, so the page has one vocabulary for both.
func permissionName(_ status: UNAuthorizationStatus) -> String {
	switch status {
	case .authorized, .provisional: return "granted"
	case .denied: return "denied"
	default: return "default"
	}
}

/// A notification to show: what the server said needs somebody (`ShellMessage.attention`).
struct Banner: Equatable {
	/// Showing another with the same id replaces it: one per conversation.
	var id: String
	var title: String
	var body: String
	/// What a click opens: the conversation's process, and its saved file when it has one.
	var liveId: String
	var file: String?
	/// Which Mac's conversation it is, for one of another Mac (`remotenotify.swift`): its name, shown under the title.
	var subtitle: String? = nil
	/// The id of that Mac in the list, so that a click opens its window and not this app's own.
	var macId: String? = nil
}

/// What a window shows of the conversations (what the page tells the shell, see web/src/lib/shell-notify.ts): the one on screen, by
/// its process and by its file (a view may know only one of the two). Nil: it shows no conversation.
struct Shown: Equatable {
	var liveId: String?
	var file: String?
}

/// Whether somebody is looking at a conversation, which is the only time a notification of it is not wanted: the window is the
/// one in use (`focused`: the app is the active one and the window its key window) and the conversation is the one on screen in it.
/// The same rule as `isLookingAt` of shared/attention.ts, which tests/unit/macos-notify.test.ts holds this to.
func isLooking(focused: Bool, shown: Shown?, liveId: String, file: String?) -> Bool {
	guard focused, let shown else { return false }
	if let id = shown.liveId, id == liveId { return true }
	if let shownFile = shown.file, let file, shownFile == file { return true }
	return false
}

enum NotifyRequest: Equatable {
	case status
	case request
	/// The conversation the page shows now (nil: none).
	case viewing(Shown?)
}

/// The request a page's message is, or nil for anything else.
func parseNotifyRequest(_ body: Any) -> NotifyRequest? {
	guard let message = body as? [String: Any], let type = message["type"] as? String else { return nil }
	switch type {
	case "status": return .status
	case "request": return .request
	case "viewing":
		let liveId = (message["liveId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
		let file = (message["file"] as? String).flatMap { $0.isEmpty ? nil : $0 }
		return .viewing(liveId == nil && file == nil ? nil : Shown(liveId: liveId, file: file))
	default: return nil
	}
}

/// The notification macOS is given for a banner: it carries what a click needs (`openEvent`), sounds, and has the conversation's
/// id, so that the next one of the same conversation replaces it.
func notificationRequest(for banner: Banner) -> UNNotificationRequest {
	let content = UNMutableNotificationContent()
	content.title = banner.title
	if let subtitle = banner.subtitle { content.subtitle = subtitle }
	content.body = banner.body
	content.sound = .default
	var info = ["liveId": banner.liveId]
	if let file = banner.file { info["file"] = file }
	if let macId = banner.macId { info["macId"] = macId }
	content.userInfo = info
	return UNNotificationRequest(identifier: banner.id, content: content, trigger: nil)
}

/// Only the UI this app serves may use the bridge: the page in the main frame, at the server's own origin. The web view
/// never shows another site (see `navigationVerdict`), but a frame inside the page would carry the handler too.
func isOwnPage(scheme: String, host: String, port: Int, origin: URL?) -> Bool {
	guard let origin, let ownHost = origin.host, let ownPort = origin.port else { return false }
	return scheme == origin.scheme && host == ownHost && port == ownPort
}

/// What a click on a notification tells the page: which conversation to open. Nil when it names none (the notification
/// is not one of this bridge's).
func openEvent(from userInfo: [AnyHashable: Any]) -> [String: Any]? {
	let liveId = userInfo["liveId"] as? String
	let file = userInfo["file"] as? String
	guard liveId != nil || file != nil else { return nil }
	return ["type": "open", "liveId": liveId ?? NSNull(), "file": file ?? NSNull()]
}

// MARK: - Bridge

final class NotificationBridge: NSObject, WKScriptMessageHandlerWithReply, UNUserNotificationCenterDelegate {
	static let handlerName = "ompwNotify"

	weak var webView: WKWebView?
	private let origin: () -> URL?
	private let open: () -> Void
	/// Nil outside an app bundle (a bare executable): `UNUserNotificationCenter` has no app to speak for and traps.
	private let center: UNUserNotificationCenter?
	/// The page has said it is up (`status`) since it was last loaded: events can be handed to it.
	private var pageReady = false
	/// What the page says it shows (`viewing`): the one it said last since it was loaded, nil when it shows no conversation or has
	/// not said (a page that is not up shows nothing anyone is looking at).
	private(set) var shown: Shown?
	/// A click that came before the page could be told: the one that opened the window (the app has none while it runs in the
	/// background, and a page of its own is a fresh one), or started the app, while the server was still starting.
	private var pending: [String: Any]?
	/// A click on a notification of another Mac's conversation (`Banner.macId`): the app opens that Mac's window and hands the click
	/// over there (`remotemenu.swift`); the window of this app has nothing to do with it. Unset before macOS 14, which has no such Macs.
	var onRemoteClick: ((UUID, [String: Any]) -> Void)?

	/// `open`: shows the app's window, as a click on a notification must.
	init(origin: @escaping () -> URL?, open: @escaping () -> Void) {
		self.origin = origin
		self.open = open
		center = Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
		super.init()
		// Before the app has finished launching: a click that started the app is delivered right after.
		center?.delegate = self
		// The person may have changed the setting in System Settings and come back.
		NotificationCenter.default.addObserver(
			forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
		) { [weak self] _ in self?.tellPermission() }
	}

	/// The web view starts loading a page: the one that was up is gone, and so is what it knew.
	func pageLoading() {
		pageReady = false
		shown = nil
	}

	/// The window and its page are gone (Run in Background): so is what the page knew, and nothing can be told to it.
	func pageGone() {
		pageReady = false
		shown = nil
	}

	/// Whether somebody is looking at this window's conversation: `focused` (the app is the active one and its window the key one)
	/// and the page shows it (`isLooking`).
	func isLooked(at banner: Banner, focused: Bool) -> Bool {
		isLooking(focused: focused, shown: shown, liveId: banner.liveId, file: banner.file)
	}

	/// A notification for a conversation that needs somebody, shown by the app itself. Not while somebody is looking at it
	/// (`watching`: the window is the one in use and shows that conversation, see `isLooking`), and not unless macOS allows
	/// notifications.
	func present(_ banner: Banner, watching: Bool) {
		guard !watching else { return }
		permission { [self] granted in
			guard granted == "granted", let center else { return }
			center.add(notificationRequest(for: banner)) { _ in }
		}
	}

	/// Ask macOS to allow notifications (a prompt the first time), then say what it allows now, in the page's words. A request it
	/// refuses outright (an error, and still undecided) is as good as a no: System Settings is where to look.
	func requestPermission(_ done: @escaping (String) -> Void) {
		guard let center else { return done("unsupported") }
		center.requestAuthorization(options: [.alert, .sound]) { [self] _, error in
			permission { allowed in done(error != nil && allowed == "default" ? "denied" : allowed) }
		}
	}

	/// What macOS allows this app now, in the page's words; `unsupported` without an app bundle.
	private func permission(_ done: @escaping (String) -> Void) {
		guard let center else { return done("unsupported") }
		center.getNotificationSettings { settings in
			DispatchQueue.main.async { done(permissionName(settings.authorizationStatus)) }
		}
	}

	func userContentController(
		_ controller: WKUserContentController, didReceive message: WKScriptMessage,
		replyHandler: @escaping (Any?, String?) -> Void
	) {
		let sender = message.frameInfo.securityOrigin
		guard message.frameInfo.isMainFrame, isOwnPage(scheme: sender.protocol, host: sender.host, port: sender.port, origin: origin())
		else { return replyHandler(nil, "Not available to this page.") }
		guard let request = parseNotifyRequest(message.body) else { return replyHandler(nil, "Unknown request.") }
		let answer = { (permission: String) in replyHandler(["permission": permission], nil) }
		switch request {
		case .status:
			pageReady = true
			permission { [self] granted in
				answer(granted)
				// The page listens by now: it asked before it started to wait for an answer.
				if let click = pending {
					pending = nil
					deliver(click) { [self] in pending = click }
				}
			}
		case .request:
			// The system asks the person only while they have not decided; either way the answer is what it allows after.
			requestPermission(answer)
		case .viewing(let nowShown):
			shown = nowShown
			replyHandler([:], nil)
		}
	}

	/// The page is told, as an event on `window` (see `onShellEvent`); `failed` runs when it could not be.
	private func deliver(_ event: [String: Any], failed: @escaping () -> Void = {}) {
		guard pageReady, let webView else { return failed() }
		webView.callAsyncJavaScript(
			"window.dispatchEvent(new CustomEvent('ompw-notification', { detail }))",
			arguments: ["detail": event], in: nil, in: .page
		) { result in
			if case .failure = result { failed() }
		}
	}

	private func tellPermission() {
		guard pageReady else { return }
		permission { [self] granted in deliver(["type": "permission", "permission": granted]) }
	}

	/// A click on a notification: the window opens (it is a fresh page when the app had none) and the page opens the conversation
	/// (once it is up). One of another Mac's conversations opens that Mac's window instead.
	func clicked(_ userInfo: [AnyHashable: Any]) {
		if let macId = (userInfo["macId"] as? String).flatMap(UUID.init(uuidString:)) {
			if let event = openEvent(from: userInfo) { onRemoteClick?(macId, event) }
			return
		}
		open()
		if let click = openEvent(from: userInfo) { deliver(click) { [self] in pending = click } }
	}

	// MARK: UNUserNotificationCenterDelegate

	/// A notification is only added while nobody is looking at the window, and that can still be while this app is the active
	/// one (a minimized window): macOS would hold it back then.
	func userNotificationCenter(
		_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
		withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
	) {
		completionHandler([.banner, .list, .sound])
	}

	func userNotificationCenter(
		_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
		withCompletionHandler completionHandler: @escaping () -> Void
	) {
		let userInfo = response.notification.request.content.userInfo
		let isClick = response.actionIdentifier == UNNotificationDefaultActionIdentifier
		DispatchQueue.main.async { [self] in
			if isClick { clicked(userInfo) }
			completionHandler()
		}
	}
}
