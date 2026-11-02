import AppKit
import WebKit

/// The app's CEF as the server's browser engine (docs/agents/browser.md, server/browser/cef.ts): a WebSocket to the server's
/// `/browser-engine`, with the token the app started it with. On it the app says hello (this run of CEF, its version, the
/// pages there are), tells every page that appears, changes or closes, and carries each page's DevTools channel both ways;
/// the server asks it to make and close pages. Connected whenever the server is up, again after it restarted or the socket
/// dropped. Without CEF running, nothing is connected (the Browser tab then says the browser is not there).
final class BrowserLink: NSObject, URLSessionWebSocketDelegate {
	/// This run of CEF: the server keeps the app's pages across its own restarts while it is the same.
	private let run = UUID().uuidString
	private let token: String
	private var origin: URL?
	private var session: URLSession?
	private var task: URLSessionWebSocketTask?
	private var retry: DispatchWorkItem?

	init(token: String) {
		self.token = token
	}

	/// The server is up at `origin`: connect to it, unless this is the server the link is on already.
	func connect(to origin: URL?) {
		guard CEFHost.running(), let origin else { return }
		if origin == self.origin, task != nil { return }
		self.origin = origin
		open()
	}

	/// The server is stopping (the app quits): no more connections.
	func stop() {
		origin = nil
		retry?.cancel()
		task?.cancel(with: .goingAway, reason: nil)
		task = nil
		CEFHost.setCdpObserver(nil)
		CEFHost.setPageObserver(nil)
	}

	private func open() {
		retry?.cancel()
		task?.cancel(with: .goingAway, reason: nil)
		task = nil
		guard let origin, var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return }
		parts.scheme = "ws"
		parts.path = "/browser-engine"
		guard let url = parts.url else { return }
		var request = URLRequest(url: url)
		request.setValue(token, forHTTPHeaderField: "x-omp-webui-token")
		let session = self.session ?? URLSession(configuration: .ephemeral, delegate: self, delegateQueue: .main)
		self.session = session
		let task = session.webSocketTask(with: request)
		// A page's screenshot or a large script comes as one message.
		task.maximumMessageSize = 256 << 20
		self.task = task
		CEFHost.setCdpObserver { [weak self] target, json in
			self?.send(["t": "cdp", "targetId": target, "message": json])
		}
		CEFHost.setPageObserver { [weak self] target, info in
			if let info { self?.send(["t": "page", "page": info]) } else { self?.send(["t": "closed", "targetId": target]) }
		}
		task.resume()
		// First on the connection (sent once it is open): what is there now. What changes after comes as it happens.
		send(["t": "hello", "run": run, "version": BrowserEngine.version ?? "", "pages": CEFHost.pages()])
		receive(on: task)
	}

	private func send(_ message: [String: Any]) {
		guard let task, let data = try? JSONSerialization.data(withJSONObject: message),
			let text = String(data: data, encoding: .utf8)
		else { return }
		// A send that fails is the connection failing, which the receive loop sees and connects again for.
		task.send(.string(text)) { _ in }
	}

	private func receive(on task: URLSessionWebSocketTask) {
		task.receive { [weak self] result in
			guard let self, task === self.task else { return }
			switch result {
			case .success(.string(let text)):
				self.handle(text)
				self.receive(on: task)
			case .success:
				self.receive(on: task)
			case .failure:
				self.again()
			}
		}
	}

	/// What the server asks (`ServerToApp` of server/browser/cef.ts).
	private func handle(_ text: String) {
		guard let data = text.data(using: .utf8),
			let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
			let type = message["t"] as? String
		else { return }
		switch type {
		case "create":
			guard let req = message["req"] as? Int, let url = message["url"] as? String else { return }
			CEFHost.createPage(url) { [weak self] targetId in
				self?.send(["t": "created", "req": req, "targetId": targetId ?? NSNull()])
			}
		case "close":
			if let targetId = message["targetId"] as? String { CEFHost.closePage(targetId) }
		case "cdp":
			if let targetId = message["targetId"] as? String, let json = message["message"] as? String {
				CEFHost.sendCdp(targetId, message: json)
			}
		default:
			break
		}
	}

	/// The connection failed or closed: connect again in a second, while the server is meant to be up.
	private func again() {
		task = nil
		guard origin != nil else { return }
		let work = DispatchWorkItem { [weak self] in
			guard let self, self.task == nil else { return }
			self.open()
		}
		retry = work
		DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: work)
	}

	func urlSession(
		_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
		reason: Data?
	) {
		if webSocketTask === task { again() }
	}
}

/// What lays a page's view over the tab: flipped, so a page's rectangle is placed as the page measures it. The view is
/// the size the page is shown at; a page laid out larger than the tab (desktop, phone) is scaled down by CEF itself, told
/// the scale by the server (`fit`, server/browser/screen.ts), so that it is drawn sharp and clicks land where they look.
/// CEF still draws a frame the size of the layout, the page scaled into its corner: what lies outside the view is cut off.
private final class BrowserHolder: NSView {
	override var isFlipped: Bool { true }

	override init(frame: NSRect) {
		super.init(frame: frame)
		wantsLayer = true
		layer?.masksToBounds = true
	}

	required init?(coder: NSCoder) { fatalError("not from a nib") }
}

/// The Browser tab of the app's windows (web/src/components/BrowserTab.tsx, `ompwBrowser`): the page is CEF's own view,
/// laid over the tab's frame area instead of the page drawing the screencast. The main window has this handler, and so do
/// its pop-outs (made with its configuration); windows onto other Macs show the screencast. One view is shown at a time,
/// in the window that placed it last: a tab of another window that hides or is covered does not take it away. A view the
/// tab no longer shows, or whose window closes, goes back to the hidden window, where the page runs on (and is still seen
/// by the screencasts of other windows).
final class BrowserBridge: NSObject, WKScriptMessageHandler {
	static let handlerName = "ompwBrowser"

	private let origin: () -> URL?
	private var holder: BrowserHolder?
	private var shown: String?
	private var covered = false
	/// The web view whose tab placed the view last.
	private weak var owner: WKWebView?
	/// The close of the window the view is in.
	private var closing: NSObjectProtocol?

	init(origin: @escaping () -> URL?) {
		self.origin = origin
	}

	func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
		let sender = message.frameInfo.securityOrigin
		guard message.frameInfo.isMainFrame,
			isOwnPage(scheme: sender.protocol, host: sender.host, port: sender.port, origin: origin()),
			let body = message.body as? [String: Any], let type = body["type"] as? String
		else { return }
		switch type {
		case "place":
			guard let web = message.webView, let targetId = body["targetId"] as? String,
				let rect = body["rect"] as? [String: Any], let size = body["size"] as? [String: Any]
			else { return }
			place(targetId, in: web, rect: rect, size: size)
		case "cover":
			guard message.webView === owner else { return }
			covered = body["covered"] as? Bool ?? false
			holder?.isHidden = covered || shown == nil
		case "hide":
			if let owner, message.webView !== owner { return }
			hide()
		case "devtools":
			if let targetId = body["targetId"] as? String { CEFHost.showDevTools(targetId) }
		default:
			break
		}
	}

	/// The tab shows no page: the view goes back to the hidden window.
	func hide() {
		CEFHost.parkAll()
		holder?.isHidden = true
		shown = nil
	}

	private func place(_ targetId: String, in web: WKWebView, rect: [String: Any], size: [String: Any]) {
		func number(_ object: [String: Any], _ key: String) -> CGFloat { CGFloat((object[key] as? NSNumber)?.doubleValue ?? 0) }
		guard let container = web.superview, let view = CEFHost.view(forTarget: targetId) else { return hide() }
		if owner !== web { covered = false }
		owner = web
		let holder: BrowserHolder
		if let existing = self.holder, existing.superview === container {
			holder = existing
		} else {
			self.holder?.removeFromSuperview()
			holder = BrowserHolder()
			container.addSubview(holder, positioned: .above, relativeTo: web)
			self.holder = holder
			if let closing { NotificationCenter.default.removeObserver(closing) }
			closing = NotificationCenter.default.addObserver(
				forName: NSWindow.willCloseNotification, object: container.window, queue: .main
			) { [weak self] _ in
				guard let self, self.holder === holder else { return }
				self.hide()
				holder.removeFromSuperview()
				self.holder = nil
				self.owner = nil
			}
		}
		if shown != targetId || view.superview !== holder {
			CEFHost.parkAll()
			view.removeFromSuperview()
			holder.addSubview(view)
			shown = targetId
		}
		// CSS pixels of the page's viewport to points of the web view (a pop-out's does not fill its window's content).
		let zoom = web.pageZoom
		let area = NSRect(
			x: number(rect, "x") * zoom, y: number(rect, "y") * zoom, width: number(rect, "w") * zoom,
			height: number(rect, "h") * zoom)
		let page = NSSize(width: max(1, number(size, "w")), height: max(1, number(size, "h")))
		// Never larger than the page is; scaled down when the page is larger than the area, at the top, in the middle.
		let scale = min(1, area.width / page.width, area.height / page.height)
		let shownSize = NSSize(width: page.width * scale, height: page.height * scale)
		let y = web.isFlipped ? area.minY : web.bounds.height - area.minY - shownSize.height
		let spot = NSRect(
			x: area.minX + (area.width - shownSize.width) / 2, y: y, width: shownSize.width, height: shownSize.height)
		holder.frame = container.convert(spot, from: web)
		holder.bounds = NSRect(origin: .zero, size: shownSize)
		view.autoresizingMask = []
		view.frame = holder.bounds
		holder.isHidden = covered
	}
}
