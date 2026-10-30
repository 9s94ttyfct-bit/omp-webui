import AppKit
import WebKit

// Harness for macos/popout.swift and `isPopOutRequest` (macos/navigation.swift): the windows a page pops out, in real
// windows with real web views, next to a main window that behaves as the app's does (its close button asks to quit).
// Prints one JSON object.
//
//   harness <url of the UI's page>      the page sets `window.popOut()`, `window.plain()` and `window.fsEvents`
//
// Nothing is put in native full screen (that takes the user's screen over): what is checked is that the window can go
// there (the green button), and that the page hears of it when the window says so.

/// The app's own window: closing it is a request to quit, which this counts instead of making.
@MainActor final class Main: NSObject, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate {
	let popOuts: PopOutWindows
	var quitRequests = 0
	var loaded: CheckedContinuation<Void, Never>?
	init(popOuts: PopOutWindows) { self.popOuts = popOuts }

	func windowShouldClose(_ sender: NSWindow) -> Bool {
		quitRequests += 1
		return false
	}

	func webView(
		_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
		windowFeatures: WKWindowFeatures
	) -> WKWebView? {
		popOuts.webView(for: action, configuration: configuration, features: windowFeatures, opener: webView)
	}

	func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
		loaded?.resume()
		loaded = nil
	}
}

@MainActor func until(_ seconds: Double = 10, _ done: () async -> Bool) async -> Bool {
	let deadline = Date().addingTimeInterval(seconds)
	while Date() < deadline {
		if await done() { return true }
		try? await Task.sleep(nanoseconds: 20_000_000)
	}
	return await done()
}

@MainActor func js(_ web: WKWebView, _ body: String) async -> Any {
	(try? await web.callAsyncJavaScript(body, contentWorld: .page)) ?? "script failed"
}

/// What `isPopOutRequest` says of an address, for the origin the UI is served at.
func pure(_ origin: URL) -> [String: Bool] {
	func asks(_ address: String, _ at: URL? = origin) -> Bool { isPopOutRequest(URL(string: address), origin: at) }
	return [
		"popOut": asks("http://127.0.0.1:7878/?popout#/s/%2Fa.jsonl/agent/Scout"),
		"withOtherParameters": asks("http://127.0.0.1:7878/?token=x&popout#/live/L/agent/S"),
		"withValue": asks("http://127.0.0.1:7878/?popout=1#/s/a/agent/b"),
		"noFlag": asks("http://127.0.0.1:7878/#/s/a/agent/b"),
		"flagInHash": asks("http://127.0.0.1:7878/#/s/a?popout"),
		"otherPath": asks("http://127.0.0.1:7878/api/meta?popout"),
		"otherPort": asks("http://127.0.0.1:7879/?popout#/s/a/agent/b"),
		"otherHost": asks("http://example.com:7878/?popout#/s/a/agent/b"),
		"aboutBlank": asks("about:blank?popout"),
		"fileScheme": asks("file:///?popout"),
		"similarName": asks("http://127.0.0.1:7878/?popouts"),
		"noUrl": isPopOutRequest(nil, origin: origin),
		"noOrigin": asks("http://127.0.0.1:7878/?popout", nil),
		"frameOfThePage": isWindowRequestAllowed(isMainFrame: true, scheme: "http", host: "127.0.0.1", port: 7878, origin: origin),
		"subframe": isWindowRequestAllowed(isMainFrame: false, scheme: "http", host: "127.0.0.1", port: 7878, origin: origin),
		"messageOtherPort": isWindowRequestAllowed(isMainFrame: true, scheme: "http", host: "127.0.0.1", port: 7879, origin: origin),
		"messageOtherHost": isWindowRequestAllowed(isMainFrame: true, scheme: "http", host: "localhost", port: 7878, origin: origin),
		"messageOtherScheme": isWindowRequestAllowed(isMainFrame: true, scheme: "https", host: "127.0.0.1", port: 7878, origin: origin),
		"messageNoOrigin": isWindowRequestAllowed(isMainFrame: true, scheme: "http", host: "127.0.0.1", port: 7878, origin: nil),
	]
}

@main struct Harness {
	/// Not `static func main() async`: that is run by Swift's own drain of the main queue, which is one `CFRunLoopRun` and
	/// then `exit(0)`. `NSWindow.performClose` (the red button, below) runs a nested event loop and stops it with a
	/// `CFRunLoopStop` that is queued as a block; when the nested loop has ended first (a window server that is slow to
	/// answer: other harnesses running at once), the block runs in the outer loop instead and ends it, and the process
	/// exits 0 half way through with nothing printed. This loop starts again whenever it is stopped, and the process ends
	/// when the report is made.
	static func main() {
		Task { @MainActor in
			await report()
			exit(0)
		}
		while true { RunLoop.main.run(mode: .default, before: .distantFuture) }
	}

	@MainActor static func report() async {
		_ = NSApplication.shared
		NSApp.setActivationPolicy(.accessory)
		let url = URL(string: CommandLine.arguments[1])!
		var origin = URLComponents(url: url, resolvingAgainstBaseURL: false)!
		origin.path = "/"
		// `pure` asks about addresses of a UI served at 7878, whatever port the harness's own page is on.
		var report: [String: Any] = ["pure": pure(URL(string: "http://127.0.0.1:7878/")!)]

		var toggles = 0
		let popOuts = PopOutWindows(origin: { origin.url }, toggle: { _ in toggles += 1 })
		let main = Main(popOuts: popOuts)
		let config = WKWebViewConfiguration()
		config.websiteDataStore = .nonPersistent()
		// `window.open` from a script that no click started (a harness has no clicks).
		config.preferences.javaScriptCanOpenWindowsAutomatically = true
		config.userContentController.add(popOuts, name: PopOutWindows.handlerName)
		let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 600, height: 400), configuration: config)
		web.navigationDelegate = main
		web.uiDelegate = main
		let window = NSWindow(
			contentRect: NSRect(x: 100, y: 100, width: 600, height: 400),
			styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
		window.isReleasedWhenClosed = false
		window.delegate = main
		window.contentView = web
		window.makeKeyAndOrderFront(nil)
		await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
			main.loaded = c
			web.load(URLRequest(url: url))
		}

		// The page asks for a window of its own: one opens, with the page loaded in it.
		let asked = await js(web, "return window.popOut() !== null")
		let opened = await until { popOuts.windows.count == 1 }
		var popped: [String: Any] = ["windowOpenReturned": asked, "opened": opened]
		if let popup = popOuts.windows.first, let view = popup.contentView as? WKWebView {
			_ = await until { !view.isLoading && view.url != nil }
			_ = await until { (await js(view, "return document.title")) as? String == "popout-page" }
			popped["url"] = view.url?.absoluteString ?? ""
			popped["title"] = popup.title
			popped["closable"] = popup.styleMask.contains(.closable)
			popped["resizable"] = popup.styleMask.contains(.resizable)
			// What makes the green button enter native full screen.
			popped["fullScreenPrimary"] = popup.collectionBehavior.contains(.fullScreenPrimary)
			popped["width"] = Int(popup.contentView?.frame.width ?? 0)
			popped["height"] = Int(popup.contentView?.frame.height ?? 0)
			popped["isOtherWindow"] = popup !== window
			popped["hasHandler"] = await js(view, "return typeof window.webkit.messageHandlers.ompwWindow.postMessage")
			// A page that has loaded is told its window is not in full screen (it would be, if it were reloaded there).
			_ = await until { (await js(view, "return window.fsEvents.length")) as? Int == 1 }
			popped["loadedEvents"] = await js(view, "return window.fsEvents")
			// The window says it is in full screen (as AppKit does when it is): the page hears it, and again when it leaves.
			popOuts.windowDidEnterFullScreen(Notification(name: NSWindow.didEnterFullScreenNotification, object: popup))
			_ = await until { (await js(view, "return window.fsEvents.length")) as? Int == 2 }
			popOuts.windowDidExitFullScreen(Notification(name: NSWindow.didExitFullScreenNotification, object: popup))
			_ = await until { (await js(view, "return window.fsEvents.length")) as? Int == 3 }
			popped["fullScreenEvents"] = await js(view, "return window.fsEvents")
			// A message that is not the page's request changes nothing (given time to be delivered).
			_ = await js(view, "window.webkit.messageHandlers.ompwWindow.postMessage({ type: 'nothing' }); return true")
			try? await Task.sleep(nanoseconds: 300_000_000)
			popped["strayMessageWindows"] = popOuts.windows.count
			popped["strayFullScreen"] = popup.styleMask.contains(.fullScreen)
		}
		report["popped"] = popped

		// Any other window request of the UI (its own address, not flagged) is no window; neither is a file or script.
		let plain = await js(web, "return window.plain() === null")
		let none = await js(web, "return window.open('file:///etc/hosts') === null")
		report["others"] = ["plainIsNull": plain, "fileIsNull": none, "windowsAfter": popOuts.windows.count]

		// `window.close()` in the pop-out closes it, and only it: the app's window stays, and nothing asked to quit.
		if let view = popOuts.windows.first?.contentView as? WKWebView { _ = await js(view, "window.close(); return true") }
		let closedByPage = await until { popOuts.windows.isEmpty }
		report["closeByPage"] = [
			"closed": closedByPage, "mainVisible": window.isVisible, "quitRequests": main.quitRequests,
			"windows": popOuts.windows.count,
		]

		// The red button / ⌘W on a pop-out: the same.
		_ = await js(web, "return window.popOut() !== null")
		_ = await until { popOuts.windows.count == 1 }
		let second = popOuts.windows.first
		second?.performClose(nil)
		let closedByButton = await until { popOuts.windows.isEmpty }
		report["closeByButton"] = [
			"closed": closedByButton, "windowIsVisible": second?.isVisible ?? false, "mainVisible": window.isVisible,
			"quitRequests": main.quitRequests,
		]

		// The control: a window with the app's own delegate asks to quit when it is closed, which is why a pop-out has its own.
		let asks = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled, .closable], backing: .buffered, defer: false)
		asks.isReleasedWhenClosed = false
		asks.delegate = main
		asks.makeKeyAndOrderFront(nil)
		asks.performClose(nil)
		report["control"] = ["quitRequests": main.quitRequests, "stillVisible": asks.isVisible]
		asks.delegate = nil
		asks.close()

		// The app quitting closes every pop-out.
		_ = await js(web, "return window.popOut() !== null")
		_ = await js(web, "return window.popOut() !== null")
		_ = await until { popOuts.windows.count == 2 }
		let two = popOuts.windows.count

		// The View menu acts on the window in front: a pop-out's web view when it is, the app's own otherwise.
		let front = popOuts.windows.last
		report["menuTarget"] = [
			"popout": front.map { targetWebView(keyWindow: $0, fallback: web) === ($0.contentView as? WKWebView) } ?? false,
			"main": targetWebView(keyWindow: window, fallback: web) === web,
			"none": targetWebView(keyWindow: nil, fallback: web) === web,
		]

		// The page's request for full screen reaches the window from the page's own main frame, and from nowhere else.
		if let view = front?.contentView as? WKWebView {
			let post = "window.webkit.messageHandlers.ompwWindow.postMessage({ type: 'toggleFullScreen' }); return true"
			_ = await js(view, post)
			_ = await until { toggles == 1 }
			report["toggle"] = ["fromPage": toggles]
		}
		popOuts.closeAll()
		report["closeAll"] = ["before": two, "after": popOuts.windows.count]

		let json = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
		print(String(decoding: json, as: UTF8.self))
	}
}
