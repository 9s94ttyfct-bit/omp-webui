import AppKit
import UserNotifications
import WebKit

// Harness for macos/notifications.swift: what the page may ask of the bridge (the permission, and nothing that shows a
// notification: the app shows those itself), what macOS is given for a notification and what a click on it opens, and the
// bridge inside a real WKWebView, loaded the way the app loads its UI (the default data store, the handler in the page's world).
// Prints one JSON object.
//
//   harness <url of a page that has `window.run()`> <origin the bridge trusts>
//
// The process is a bare executable, not an app bundle, so UNUserNotificationCenter is not touched (it would trap): the
// bridge answers "unsupported", which is also what a page is told in that case. Nothing is shown and no permission asked.

/// The page's message handler gets the same fixed set of requests whatever the window's state is.
func pure() -> [String: Any] {
	let status = ["notDetermined": 0, "denied": 1, "authorized": 2, "provisional": 3]
		.mapValues { permissionName(UNAuthorizationStatus(rawValue: $0)!) }
	func parsed(_ body: Any) -> String {
		switch parseNotifyRequest(body) {
		case .none: return "nil"
		case .status: return "status"
		case .request: return "request"
		case .viewing(let shown): return "viewing:\(shown?.liveId ?? "-")|\(shown?.file ?? "-")"
		}
	}
	/// The notification macOS is given for a banner, and what a click on it tells the page (`notificationRequest`, `openEvent`).
	func banner(_ id: String, file: String?) -> [String: Any] {
		let request = notificationRequest(for: Banner(id: id, title: "Fix the build", body: "Finished", liveId: "live-\(id)", file: file))
		return [
			"id": request.identifier, "title": request.content.title, "body": request.content.body,
			"sound": request.content.sound != nil, "immediate": request.trigger == nil,
			"click": openEvent(from: request.content.userInfo) ?? "nil",
		]
	}
	/// A conversation of another Mac (#656): that Mac's name under the title, and which Mac it is in what a click carries.
	func remoteBanner() -> [String: Any] {
		let banner = Banner(id: "r", title: "Fix", body: "Needs your input", liveId: "L", file: "/f", subtitle: "Studio", macId: "mac-1")
		let request = notificationRequest(for: banner)
		return [
			"id": request.identifier, "subtitle": request.content.subtitle, "macId": request.content.userInfo["macId"] as? String ?? "nil",
			"liveId": request.content.userInfo["liveId"] as? String ?? "nil",
		]
	}
	/// The rule, on the cases `tests/unit/macos-notify.test.ts` holds to `isLookingAt` of shared/attention.ts.
	func looking() -> [Bool] {
		let cases: [(Bool, Shown?, String, String?)] = [
			(true, Shown(liveId: "a", file: "/a"), "a", "/a"),
			(true, Shown(liveId: "a", file: nil), "a", "/a"),
			(true, Shown(liveId: nil, file: "/a"), "a", "/a"),
			(true, Shown(liveId: "b", file: "/b"), "a", "/a"),
			(true, nil, "a", "/a"),
			(false, Shown(liveId: "a", file: "/a"), "a", "/a"),
			(true, Shown(liveId: "m", file: nil), "n", nil),
			(true, Shown(liveId: nil, file: nil), "n", nil),
			(true, Shown(liveId: "n", file: nil), "n", nil),
		]
		return cases.map { isLooking(focused: $0.0, shown: $0.1, liveId: $0.2, file: $0.3) }
	}
	let origin = URL(string: "http://127.0.0.1:7878/")
	/// What a click on a notification carries (the notification's userInfo), and what the page is told of it.
	func opened(_ liveId: String?, _ file: String?) -> Any {
		var info: [AnyHashable: Any] = [:]
		if let liveId { info["liveId"] = liveId }
		if let file { info["file"] = file }
		return openEvent(from: info) ?? "nil"
	}
	return [
		"status": status,
		"parse": [
			parsed(["type": "status"]), parsed(["type": "request"]),
			// The app shows notifications itself: a page can no longer ask it to.
			parsed(["type": "show", "id": "a", "title": "T", "body": "B", "liveId": "a", "file": "/f"]),
			parsed(["type": "other"]), parsed(["type": 1]), parsed("status"), parsed([1, 2]),
			parsed(["type": "viewing", "liveId": "a", "file": "/f"]), parsed(["type": "viewing", "liveId": "a"]),
			parsed(["type": "viewing", "file": "/f"]), parsed(["type": "viewing", "liveId": "", "file": ""]),
			parsed(["type": "viewing"]), parsed(["type": "viewing", "liveId": 5, "file": false]),
		],
		"ownPage": [
			isOwnPage(scheme: "http", host: "127.0.0.1", port: 7878, origin: origin),
			isOwnPage(scheme: "http", host: "127.0.0.1", port: 7879, origin: origin),
			isOwnPage(scheme: "http", host: "localhost", port: 7878, origin: origin),
			isOwnPage(scheme: "https", host: "127.0.0.1", port: 7878, origin: origin),
			isOwnPage(scheme: "http", host: "127.0.0.1", port: 7878, origin: nil),
		],
		"open": [opened("L", "/f"), opened("L", nil), opened(nil, "/f"), opened(nil, nil)],
		"banners": [banner("a", file: "/s/a.jsonl"), banner("b", file: nil)],
		"remoteBanner": remoteBanner(),
		"looking": looking(),
	]
}

@MainActor final class Loader: NSObject, WKNavigationDelegate {
	var onStart: () -> Void = {}
	var finished: CheckedContinuation<Void, Never>?
	func webView(_ w: WKWebView, didStartProvisionalNavigation n: WKNavigation!) { onStart() }
	func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
		finished?.resume()
		finished = nil
	}
}

@MainActor final class Page {
	let loader = Loader()
	let webView: WKWebView
	let bridge: NotificationBridge
	var forwarded = 0

	init(trusting origin: URL) {
		var forward: () -> Void = {}
		bridge = NotificationBridge(origin: { origin }, open: { forward() })
		let config = WKWebViewConfiguration()
		config.websiteDataStore = .default()
		config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: NotificationBridge.handlerName)
		webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 300, height: 200), configuration: config)
		webView.navigationDelegate = loader
		bridge.webView = webView
		loader.onStart = { [bridge] in bridge.pageLoading() }
		forward = { [unowned self] in forwarded += 1 }
	}

	func load(_ url: URL) async {
		await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
			loader.finished = c
			webView.load(URLRequest(url: url))
		}
	}

	func js(_ body: String) async -> Any {
		(try? await webView.callAsyncJavaScript(body, contentWorld: .page)) ?? "script failed"
	}

	/// The events the page has heard so far, once there are `count` of them (the bridge hands them over asynchronously).
	func events(_ count: Int) async -> Any {
		let deadline = Date().addingTimeInterval(10)
		while Date() < deadline {
			if let n = await js("return window.events.length") as? Int, n >= count { break }
			try? await Task.sleep(nanoseconds: 20_000_000)
		}
		return await js("return window.events")
	}
}

@main struct Harness {
	@MainActor static func main() async {
		_ = NSApplication.shared
		NSApp.setActivationPolicy(.accessory)
		let url = URL(string: CommandLine.arguments[1])!
		var report: [String: Any] = ["pure": pure()]

		// The page is at the origin the bridge trusts.
		let own = Page(trusting: url)
		// A click that came before the page was up: the one that started the app.
		own.bridge.clicked(["liveId": "L-cold", "file": "/s/cold.jsonl"])
		await own.load(url)
		var mine: [String: Any] = ["messages": await own.js("return await window.run()")]
		mine["afterStatus"] = await own.events(1)
		own.bridge.clicked(["liveId": "L-live"])
		mine["afterLiveClick"] = await own.events(2)
		NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
		mine["afterActivation"] = await own.events(3)
		// A click while a page is loading waits for the page that is loaded next.
		own.loader.onStart = { [bridge = own.bridge] in
			bridge.pageLoading()
			bridge.clicked(["file": "/s/reload.jsonl"])
		}
		await own.load(url)
		mine["reloadedMessages"] = await own.js("return await window.run()")
		mine["reloadedEvents"] = await own.events(1)
		mine["forwarded"] = own.forwarded

		// Run in Background closes the window and its page: what the page knew is gone, nothing is told to it, and a click that
		// opens the window waits for the fresh page that comes.
		own.loader.onStart = { [bridge = own.bridge] in bridge.pageLoading() }
		await own.load(url)
		_ = await own.js("return await window.run()")
		own.bridge.pageGone()
		own.bridge.clicked(["liveId": "L-away", "file": "/s/away.jsonl"])
		mine["whileGone"] = await own.js("return window.events")
		await own.load(url)
		_ = await own.js("return await window.run()")
		mine["afterFresh"] = await own.events(1)
		mine["forwardedAfterGone"] = own.forwarded
		report["own"] = mine

		// The page is at another origin than the bridge trusts.
		let other = Page(trusting: URL(string: "http://127.0.0.1:1/")!)
		other.bridge.clicked(["liveId": "L-cold"])
		await other.load(url)
		report["other"] = [
			"messages": await other.js("return await window.run()"),
			"events": await other.js("return window.events"),
		]

		let data = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
		print(String(decoding: data, as: UTF8.self))
		exit(0)
	}
}
