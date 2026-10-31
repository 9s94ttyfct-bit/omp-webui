import AppKit
import WebKit

/// The windows the page pops out (a subagent's live view, `window.open("/?popout#/s/…/agent/…")`): each a real window of
/// its own, with a web view of its own on the same data store and the same page handlers, that can go to native full
/// screen (its own Space) with the green button or from the page (`ompwWindow`, `{ type: "toggleFullScreen" }`; the page
/// is told when the window enters or leaves it, by an `ompw-fullscreen` event on `window`).
///
/// The window of the app is the whole app: its close button quits. A pop-out is not: it has its own delegate, closing it
/// (the red button, ⌘W, `window.close()` in the page) closes that window and nothing else, and the app goes on with the
/// window it has.
final class PopOutWindows: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
	/// The name of the page's message handler for the window it is in.
	static let handlerName = "ompwWindow"

	/// Where the UI is served (nil before the server is up): the only place a pop-out shows.
	private let origin: () -> URL?
	/// The pop-outs that are open, in the order they were opened.
	private(set) var windows: [NSWindow] = []
	/// What each window's title follows: the page's own, so that the window says which subagent it shows.
	private var titles: [ObjectIdentifier: NSKeyValueObservation] = [:]
	/// Where the last window was put, so that the next one is not exactly over it.
	private var cascade = NSPoint.zero
	/// The size the last pop-out was left at: the next one opens at it (they cascade, so only their size is kept).
	private var sizes: [ObjectIdentifier: WindowFrameMemory] = [:]

	/// What the page's request for full screen does to its window (a test passes a counter: native full screen takes the screen over).
	private let toggle: (NSWindow) -> Void

	init(origin: @escaping () -> URL?, toggle: @escaping (NSWindow) -> Void = { $0.toggleFullScreen(nil) }) {
		self.origin = origin
		self.toggle = toggle
	}

	/// The web view for a new-window request, when the request is the page's own for a window of its own (see
	/// `isPopOutRequest`); nil for any other, which is not this class's to answer. `configuration` is the one WebKit hands
	/// over, as it has to be used for the web view it gets back; `opener` is the web view that asked.
	func webView(
		for action: WKNavigationAction, configuration: WKWebViewConfiguration, features: WKWindowFeatures, opener: WKWebView
	) -> WKWebView? {
		guard isPopOutRequest(action.request.url, origin: origin()) else { return nil }
		return open(configuration: configuration, features: features, near: opener.window)
	}

	/// A window with a web view made from `configuration`; WebKit loads the requested address into it.
	func open(configuration: WKWebViewConfiguration, features: WKWindowFeatures, near: NSWindow?) -> WKWebView {
		let web = WKWebView(frame: .zero, configuration: configuration)
		web.navigationDelegate = self
		web.uiDelegate = self
		prepareWebView(web)

		let width = (features.width?.doubleValue).map { min(max($0, 480), 4000) } ?? 1100
		let height = (features.height?.doubleValue).map { min(max($0, 360), 3000) } ?? 800
		let window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: width, height: height),
			styleMask: [.titled, .closable, .miniaturizable, .resizable],
			backing: .buffered, defer: false)
		// The green button is full screen (a window of its own Space), not a zoom.
		window.collectionBehavior.insert(.fullScreenPrimary)
		window.tabbingMode = .disallowed
		window.delegate = self
		// Held here until it closes; AppKit must not free it under the array.
		window.isReleasedWhenClosed = false
		window.minSize = NSSize(width: 420, height: 360)
		window.backgroundColor = near?.backgroundColor ?? NSColor.windowBackgroundColor
		window.contentView = web
		// The size the person last left a pop-out at (its whole frame), else what the page asked for.
		if let kept = WindowFrameMemory(key: "popout").savedSize(), kept.width >= 420, kept.height >= 360 {
			let size = NSSize(width: min(kept.width, 4000), height: min(kept.height, 3000))
			window.setFrame(NSRect(origin: .zero, size: size), display: false)
		}
		window.center()
		cascade = window.cascadeTopLeft(from: cascade)
		titles[ObjectIdentifier(window)] = web.observe(\.title, options: [.initial, .new]) { [weak window] web, _ in
			if let title = web.title, !title.isEmpty { window?.title = title }
		}
		windows.append(window)
		let memory = WindowFrameMemory(key: "popout")
		memory.follow(window)
		sizes[ObjectIdentifier(window)] = memory
		window.makeKeyAndOrderFront(nil)
		return web
	}

	/// Close every pop-out (the app is quitting).
	func closeAll() {
		for window in windows { window.close() }
	}

	// MARK: Window

	func windowWillClose(_ notification: Notification) {
		guard let window = notification.object as? NSWindow else { return }
		titles[ObjectIdentifier(window)] = nil
		sizes[ObjectIdentifier(window)] = nil
		windows.removeAll { $0 === window }
		window.delegate = nil
		window.contentView = nil
	}

	func windowDidEnterFullScreen(_ notification: Notification) { tell(notification, fullScreen: true) }
	func windowDidExitFullScreen(_ notification: Notification) { tell(notification, fullScreen: false) }

	private func tell(_ notification: Notification, fullScreen: Bool) {
		guard let web = (notification.object as? NSWindow)?.contentView as? WKWebView else { return }
		report(web, fullScreen: fullScreen)
	}

	/// What the page is told when its window enters or leaves full screen.
	private func report(_ web: WKWebView, fullScreen: Bool) {
		web.evaluateJavaScript(
			"window.dispatchEvent(new CustomEvent('ompw-fullscreen', { detail: \(fullScreen) }))", completionHandler: nil)
	}

	// MARK: The page

	func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
		// Only the UI's own page, in its main frame, may take its window to full screen (as the notification bridge says
		// of its own handler): a frame of another page, or another origin, is refused.
		let sender = message.frameInfo.securityOrigin
		guard message.name == PopOutWindows.handlerName,
			isWindowRequestAllowed(
				isMainFrame: message.frameInfo.isMainFrame, scheme: sender.protocol, host: sender.host, port: sender.port,
				origin: origin()),
			let body = message.body as? [String: Any], body["type"] as? String == "toggleFullScreen",
			let window = message.webView?.window
		else { return }
		toggle(window)
	}

	/// A page that was loaded while its window is in full screen (a reload) says so too.
	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		report(webView, fullScreen: webView.window?.styleMask.contains(.fullScreen) ?? false)
	}

	/// A pop-out shows the UI and nothing else, as the app's window does (see `navigationVerdict`).
	func webView(
		_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
		decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
	) {
		guard let url = action.request.url else { return decisionHandler(.allow) }
		switch navigationVerdict(for: url, origin: origin()) {
		case .allow: decisionHandler(.allow)
		case .openExternally:
			NSWorkspace.shared.open(url)
			decisionHandler(.cancel)
		case .cancel: decisionHandler(.cancel)
		}
	}

	/// `window.close()` in the page closes its window.
	func webViewDidClose(_ webView: WKWebView) { webView.window?.close() }

	/// A link or `window.open` from a pop-out: the default browser gets what a navigation would hand it, as in the app's window.
	func webView(
		_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
		windowFeatures: WKWindowFeatures
	) -> WKWebView? {
		if let url = externalURL(forNewWindow: action.request.url, origin: origin()) { NSWorkspace.shared.open(url) }
		return nil
	}

	/// The web content process died (memory pressure, crash): reload instead of a blank window.
	func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}

/// Whether a message from a page's handler comes from the UI's own page, in its main frame (`origin`: nil before the server is up).
func isWindowRequestAllowed(isMainFrame: Bool, scheme: String, host: String, port: Int, origin: URL?) -> Bool {
	guard isMainFrame, let origin, let ownHost = origin.host, let ownPort = origin.port else { return false }
	return scheme == origin.scheme && host == ownHost && port == ownPort
}

/// The web view a menu command (Reload) acts on: the one in the window in front, a pop-out's or the
/// app's own; the app's own when no window is.
func targetWebView(keyWindow: NSWindow?, fallback: WKWebView) -> WKWebView {
	(keyWindow?.contentView as? WKWebView) ?? fallback
}
