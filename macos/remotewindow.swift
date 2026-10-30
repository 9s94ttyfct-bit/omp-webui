import AppKit
import CoreServices
import WebKit

// The windows onto another Mac (#614). A remote window is a real window of its own, like a subagent's pop-out
// (`popout.swift`): closing it closes it, never the app, whose own window is the whole app. It shows the page that Mac serves,
// the same page a phone's browser gets, in a web view of its own: its own data store (cookies, sign-in, page storage: one per
// Cloudflare team, shared by the Macs of that team so that one Access sign-in covers them all, and one per Mac whose team is
// not known), a content blocker that keeps it away from this Mac and its network, and bridges to the app that answer only that
// Mac's own page. Above the page, a bar the page cannot paint over says whose window it is: REMOTE, the Mac's name, its host
// and where the sign-in stands. What the window follows is decided by `remoteNavigationVerdict` (remotepolicy.swift).
//
// The data store needs macOS 14, so nothing here exists before it (`remotemenu.swift` is the one place that asks). The list of
// Macs is not here: the local server keeps it (`remotemacs.swift` reads it and asks the server to change it).

// MARK: - The bar

/// The line above the page: a tinted bar with an icon, text and Disconnect. The tint says which Mac at a glance and the words
/// say the rest, so nothing depends on colour.
///
/// The text is three labels, not one line cut off at its end: the tag (`REMOTE`, never cut), where the sign-in stands (`Signing in
/// at login.example-idp.com`: the host that has the page, which keeps its room before anything else; a long host is cut in its
/// middle and shown by its end, see `displayHost`) and who (`Mac A · omp.example.com`, which gives way first, and goes when
/// there is no room for a few letters of it: the title says the name too). A tooltip has all of each.
final class RemoteStrip: NSView {
	static let height: CGFloat = 26
	/// The room the "who" label needs to be worth showing.
	static let whoWorth: CGFloat = 60
	private let hue: Double
	private let icon = NSImageView()
	private let tagLabel = NSTextField(labelWithString: "")
	private let who = NSTextField(labelWithString: "")
	private let state = NSTextField(labelWithString: "")
	private let button = NSButton(title: "", target: nil, action: nil)
	private let line = NSBox()
	var onDisconnect: (() -> Void)?

	init(hue: Double) {
		self.hue = hue
		super.init(frame: .zero)
		wantsLayer = true
		icon.image = NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: nil)
		icon.contentTintColor = .labelColor
		for (label, weight, mode) in [
			(tagLabel, NSFont.Weight.bold, NSLineBreakMode.byClipping), (who, .medium, .byTruncatingMiddle),
			(state, .medium, .byTruncatingMiddle),
		] {
			label.font = NSFont.systemFont(ofSize: 12, weight: weight)
			label.textColor = .labelColor
			label.lineBreakMode = mode
			label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
		}
		button.bezelStyle = .rounded
		button.controlSize = .small
		button.font = NSFont.systemFont(ofSize: 11)
		button.target = self
		button.action = #selector(disconnectPressed)
		line.boxType = .separator
		for view in [icon, tagLabel, who, state, button, line] as [NSView] { addSubview(view) }
	}

	required init?(coder: NSCoder) { fatalError("not from a nib") }

	@objc private func disconnectPressed() { onDisconnect?() }

	func set(parts: (tag: String, who: String, status: String, statusFull: String), disconnect: String, accessibility: String) {
		tagLabel.stringValue = parts.tag
		who.stringValue = "· \(parts.who)"
		who.toolTip = parts.who
		state.stringValue = "· \(parts.status)"
		state.toolTip = parts.statusFull
		button.title = disconnect
		button.sizeToFit()
		setAccessibilityLabel(accessibility)
		setAccessibilityRole(.group)
		needsLayout = true
		relayout()
	}

	/// What each label shows and where it is, for the tests: the "who" label is hidden when there is no room for it.
	var shown: (tag: String, who: String, whoHidden: Bool, status: String) {
		(tagLabel.stringValue, who.stringValue, who.isHidden, state.stringValue)
	}
	var labelFrames: (tag: NSRect, who: NSRect, status: NSRect, button: NSRect) {
		(tagLabel.frame, who.frame, state.frame, button.frame)
	}
	/// The state label has the room for all it says (it is the last to be cut, and the host in it is already cut to its end).
	var statusFits: Bool { state.frame.width + 0.5 >= state.intrinsicContentSize.width }

	override var wantsUpdateLayer: Bool { true }

	override func updateLayer() {
		let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
		layer?.backgroundColor = NSColor(
			hue: CGFloat(hue / 360), saturation: dark ? 0.55 : 0.28, brightness: dark ? 0.42 : 0.97, alpha: 1
		).cgColor
	}

	override func viewDidChangeEffectiveAppearance() {
		super.viewDidChangeEffectiveAppearance()
		needsDisplay = true
	}

	override func resizeSubviews(withOldSize oldSize: NSSize) { relayout() }

	/// Icon, tag, who, state, button, from the left: the room goes first to the tag, then to the state, and what is left to who.
	private func relayout() {
		let h = bounds.height, w = bounds.width
		icon.frame = NSRect(x: 10, y: (h - 16) / 2, width: 16, height: 16)
		let buttonWidth = max(button.frame.width, 70)
		button.frame = NSRect(x: w - buttonWidth - 8, y: (h - 20) / 2, width: buttonWidth, height: 20)
		let labelHeight = tagLabel.intrinsicContentSize.height
		let y = (h - labelHeight) / 2
		let gap: CGFloat = 6
		var x: CGFloat = 32
		let right = button.frame.minX - 10
		let tagWidth = min(ceil(tagLabel.intrinsicContentSize.width) + 2, max(0, right - x))
		tagLabel.frame = NSRect(x: x, y: y, width: tagWidth, height: labelHeight)
		x += tagWidth + gap
		let stateWidth = min(ceil(state.intrinsicContentSize.width) + 2, max(0, right - x))
		let whoWidth = max(0, right - x - stateWidth - gap)
		let showWho = whoWidth >= RemoteStrip.whoWorth
		who.isHidden = !showWho
		let used = showWho ? min(whoWidth, ceil(who.intrinsicContentSize.width) + 2) : 0
		who.frame = NSRect(x: x, y: y, width: used, height: labelHeight)
		x += used + (showWho ? gap : 0)
		state.frame = NSRect(x: x, y: y, width: min(stateWidth, max(0, right - x)), height: labelHeight)
		line.frame = NSRect(x: 0, y: 0, width: w, height: 1)
	}
}

/// What a remote window's content is: the page and, above it, the bar. (The View menu finds the page through this: the
/// content view of a window is not the web view itself.)
final class RemoteContentView: NSView {
	let web: WKWebView
	let strip: RemoteStrip
	/// What ⌘R does (the window reloads the page, or tries the Mac again).
	var reload: (() -> Void)?

	init(web: WKWebView, strip: RemoteStrip) {
		self.web = web
		self.strip = strip
		super.init(frame: .zero)
		addSubview(web)
		addSubview(strip)
	}

	required init?(coder: NSCoder) { fatalError("not from a nib") }

	override func resizeSubviews(withOldSize oldSize: NSSize) { relayout() }
	override func viewDidMoveToWindow() { relayout() }

	private func relayout() {
		let h = RemoteStrip.height
		strip.frame = NSRect(x: 0, y: max(0, bounds.height - h), width: bounds.width, height: h)
		web.frame = NSRect(x: 0, y: 0, width: bounds.width, height: max(0, bounds.height - h))
	}
}

// MARK: - A window

@available(macOS 14.0, *)
final class RemoteWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
	private weak var session: RemoteMacSession?
	let window: NSWindow
	let web: WKWebView
	private let content: RemoteContentView
	let isPopOut: Bool
	/// What the window makes of its page's navigations (see `RemoteNavigator`); `phase` is where it is.
	private var navigator = RemoteNavigator() {
		didSet { web.allowsBackForwardNavigationGestures = navigator.phase == .signingIn }
	}
	var phase: RemotePhase { navigator.phase }
	private(set) var status = RemoteStatus.connecting
	private var titleObservation: NSKeyValueObservation?
	/// A page's alert or question is open (one at a time: a page that asks again meanwhile is answered "no").
	private var dialogOpen = false
	/// The narrowest a remote window goes: the bar needs this much to name the host that has the page.
	static let minWidth: CGFloat = 640
	/// What the person does in this window (see `RemoteGesture`), and the monitor that feeds it.
	private(set) var gesture = RemoteGesture()
	private var gestureMonitor: Any?
	/// What this window's page says it shows (`ompwView`, the same `viewing` as the app's own page tells): nil when it shows no conversation,
	/// or has not said since it loaded.
	var shown: Shown?
	/// The page has said what it shows since it loaded: it is up, and a click on a notification can be handed to it.
	var pageUp = false

	init(
		session: RemoteMacSession, configuration: WKWebViewConfiguration, popOut: Bool, features: WKWindowFeatures?, near: NSWindow?
	) {
		self.session = session
		isPopOut = popOut
		let web = WKWebView(frame: .zero, configuration: configuration)
		self.web = web
		let strip = RemoteStrip(hue: remoteHues[remoteHueIndex(for: session.mac.id)])
		content = RemoteContentView(web: web, strip: strip)
		// No narrower than the bar needs to say whose window it is and where the sign-in stands.
		let width = (features?.width?.doubleValue).map { min(max($0, RemoteWindow.minWidth), 4000) } ?? (popOut ? 1100 : 1280)
		let height = (features?.height?.doubleValue).map { min(max($0, 360), 3000) } ?? (popOut ? 800 : 840)
		window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: width, height: height),
			styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
		super.init()
		web.navigationDelegate = self
		web.uiDelegate = self
		web.allowsMagnification = true
		web.setValue(false, forKey: "drawsBackground")
		// Covered by another window, the page must still hear what streams in (see the same switch for the app's own window).
		if web.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) {
			web.setValue(false, forKey: "windowOcclusionDetectionEnabled")
		}
		strip.onDisconnect = { [weak self] in self?.session?.disconnect() }
		content.reload = { [weak self] in self?.reloadOrRetry() }

		// The green button is full screen (a window of its own Space), as in a pop-out.
		window.collectionBehavior.insert(.fullScreenPrimary)
		window.tabbingMode = .disallowed
		window.delegate = self
		// Held by the session until it closes; AppKit must not free it under the list.
		window.isReleasedWhenClosed = false
		window.minSize = NSSize(width: RemoteWindow.minWidth, height: 480)
		window.backgroundColor = near?.backgroundColor ?? NSColor.windowBackgroundColor
		window.contentView = content
		window.center()
		if popOut {
			session.cascade = window.cascadeTopLeft(from: session.cascade)
		} else {
			// One window of its own size and place for each Mac.
			if session.rememberFrames { window.setFrameAutosaveName("remote-\(session.mac.id.uuidString)") }
		}
		titleObservation = web.observe(\.title, options: [.initial, .new]) { [weak self] _, _ in self?.refreshTitle() }
		// What the person really does in this window, as far as the app can tell: a link counts as clicked only while one of these
		// is a moment old (see `RemoteGesture`).
		gestureMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .keyDown]) { [weak self] event in
			let mouse = event.type == .leftMouseDown || event.type == .leftMouseUp
			let real = RemoteGesture.counts(isMouse: mouse, keyCode: mouse ? 0 : event.keyCode, isRepeat: !mouse && event.isARepeat)
			if let self, real, event.window === self.window { self.gesture.noteEvent(at: ProcessInfo.processInfo.systemUptime) }
			return event
		}
		refreshStrip()
	}

	private var words: RemoteWords { RemoteWords(session?.language() ?? .en) }
	private var site: RemoteSite { session?.site ?? RemoteSite(host: "") }

	func show() {
		window.makeKeyAndOrderFront(nil)
		NSApp.activate(ignoringOtherApps: true)
	}

	func close() { window.close() }

	func start() {
		navigator.reset()
		setStatus(.connecting)
		web.load(URLRequest(url: site.url))
	}

	// MARK: Label

	func refreshTitle() {
		guard let session else { return }
		window.title = remoteWindowTitle(name: session.mac.name, pageTitle: web.title, language: session.language())
	}

	func refreshStrip() {
		guard let session else { return }
		let language = session.language()
		let w = RemoteWords(language)
		content.strip.set(
			parts: remoteStripParts(name: session.mac.name, host: session.mac.host, status: status, language: language),
			disconnect: w.disconnect, accessibility: w.accessibility(name: session.mac.name, host: session.mac.host, status: status))
	}

	private func setStatus(_ next: RemoteStatus) {
		status = next
		refreshStrip()
	}

	/// The bar says what the page on screen is (after a load that did not happen, or was stopped): the host that has it while
	/// signing in. An error page is left as it is.
	private func syncStatus() {
		if case .failed = status { return }
		switch phase {
		case .connected: setStatus(.connected)
		case .signingIn: setStatus(.signingIn(host: (web.url?.host ?? "").lowercased()))
		case .loading: setStatus(.connecting)
		}
	}

	/// The Mac was renamed.
	func renamed() {
		refreshTitle()
		refreshStrip()
	}

	// MARK: Failure

	private func show(_ problem: RemoteProblem, host: String? = nil) {
		guard let session else { return }
		// The error page is the window's own: nothing of the Mac's is on screen, so the next load starts from the beginning.
		navigator.reset()
		setStatus(.failed(problem))
		web.loadHTMLString(
			remoteErrorPage(name: session.mac.name, host: host ?? session.mac.host, problem: problem, language: session.language()),
			baseURL: nil)
	}

	/// Load the Mac's address again, from the start: it may answer with a sign-in.
	func retry() {
		start()
	}

	func reloadOrRetry() {
		if case .failed = status { retry() } else if web.url?.scheme == "https" { web.reload() } else { retry() }
	}

	// MARK: Navigation

	func webView(
		_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
		decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
	) {
		let url = action.request.url
		// The "try again" link of the window's own error page.
		if url?.scheme == remoteRetryScheme {
			decisionHandler(.cancel)
			retry()
			return
		}
		let mainFrame = action.targetFrame?.isMainFrame ?? true
		if action.shouldPerformDownload {
			// A download the page asked for goes through the save panel, and only from the Mac itself.
			decisionHandler(remoteIsOwn(url, site: site) ? .download : .cancel)
			return
		}
		// A link counts as clicked only when it is one and the person really did something in this window a moment ago.
		let now = ProcessInfo.processInfo.systemUptime
		let clicked = action.navigationType == .linkActivated && gesture.isFresh(at: now)
		let verdict = navigator.decide(url: url, site: site, mainFrame: mainFrame, clicked: clicked)
		switch verdict {
		case .allow, .signIn, .signInStep:
			// Allowed; nothing changes on screen until the page is committed (`didCommit`).
			decisionHandler(.allow)
		case .openExternally:
			// A real click opens one link, once; never one the blocker refuses (the verdict has seen to that).
			if let url, gesture.consumeForExternalOpen(at: now) { NSWorkspace.shared.open(url) }
			decisionHandler(.cancel)
		case .cancel:
			decisionHandler(.cancel)
		case .teamMismatch(let host):
			decisionHandler(.cancel)
			show(.teamMismatch(host: host, pinned: site.team), host: host)
		}
	}

	/// A main-frame load starts. If the chain had let an address through as a possible redirect and no redirect was reported for
	/// it, this is a load of its own: the page navigated by itself, to somewhere the sign-in did not send it. It is stopped before
	/// the other site can answer, and the page that was on screen stays.
	func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
		guard navigator.started() else { return }
		webView.stopLoading()
		syncStatus()
	}

	func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
		navigator.redirected()
	}

	func webView(
		_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
		decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
	) {
		// The Mac itself answered, and would not serve the page (it refused this sign-in, or nothing runs behind the tunnel): said
		// in the window, not left to whatever it printed.
		if response.isForMainFrame, let http = response.response as? HTTPURLResponse, remoteIsOwn(http.url, site: site),
			let problem = remoteProblem(httpStatus: http.statusCode)
		{
			decisionHandler(.cancel)
			show(problem)
			return
		}
		let own = remoteIsOwn(response.response.url, site: site)
		// What the Mac's file transfer sends says it is to be saved: it goes through the save panel whatever its type, so a text
		// file or a picture is not shown in the window in place of the page.
		if own, remoteIsAttachment(response.response) {
			decisionHandler(.download)
			return
		}
		decisionHandler(response.canShowMIMEType ? .allow : (own ? .download : .cancel))
	}

	func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
		download.delegate = session?.downloads
	}

	func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
		download.delegate = session?.downloads
	}

	func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
		// A page is committed: the one before it is gone, and so is what it said of what it shows.
		shown = nil
		pageUp = false
		// The window's own pages (an error page, `about:blank`) change nothing: only the Mac's pages and its sign-in do.
		guard let url = webView.url else { return }
		let host = (url.host ?? "").lowercased()
		switch navigator.committed(url, site: site) {
		case .ignored:
			return
		case .unexpected:
			// A page that nothing led to is not left under the bar.
			show(.unexpected(host: host), host: host)
		case .moved(let next, let pin):
			if let pin { session?.pin(team: pin) }
			switch next {
			case .connected:
				if status != .connected { setStatus(.connected) }
				session?.noteConnected()
			case .signingIn:
				setStatus(.signingIn(host: host))
			case .loading:
				break
			}
		}
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		report(fullScreen: window.styleMask.contains(.fullScreen))
	}

	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		let failure = error as NSError
		// Whatever the chain was doing is over; the phase is what the page on screen is (only a commit moves it), the bar says so.
		navigator.ended()
		// What the window cancelled itself (a verdict, a download, a stopped load) is no failure.
		if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return syncStatus() }
		if failure.domain == "WebKitErrorDomain" && (failure.code == 101 || failure.code == 102) { return syncStatus() }
		let host = (failure.userInfo[NSURLErrorFailingURLErrorKey] as? URL)?.host?.lowercased()
		let problem =
			failure.domain == NSURLErrorDomain
			? remoteProblem(urlErrorCode: failure.code, description: failure.localizedDescription)
			: .other(failure.localizedDescription)
		show(problem, host: host)
	}

	/// The web content process died (memory pressure, crash): load again instead of a blank window.
	func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { reloadOrRetry() }

	// MARK: The page's windows and questions

	/// Links with `target=_blank` and `window.open`: the page's own request for a subagent's window (`/?popout#/s/…`) opens
	/// a window of this Mac's; a link the person clicked goes to the default browser; anything else is ignored.
	func webView(
		_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
		windowFeatures: WKWindowFeatures
	) -> WKWebView? {
		let url = action.request.url
		if phase == .connected, isRemotePopOutRequest(url, host: site.host) {
			return session?.openPopOut(configuration: configuration, features: windowFeatures, near: window)
		}
		// As for a navigation: a link the person really clicked, one a second, never for an address the blocker refuses.
		let now = ProcessInfo.processInfo.systemUptime
		let clicked = action.navigationType == .linkActivated && gesture.isFresh(at: now)
		if let url, remoteNavigationVerdict(url: url, site: site, phase: phase, userInitiated: clicked) == .openExternally,
			gesture.consumeForExternalOpen(at: now)
		{
			NSWorkspace.shared.open(url)
		}
		return nil
	}

	/// The page asked for full screen: only while the person is using this window (it is the key one, the app is active and
	/// something was clicked or Return or Space pressed in it a moment ago, which this uses up), so that a page cannot pull the
	/// person away to another Space by itself.
	func allowFullScreenForPage() -> Bool {
		window.isKeyWindow && NSApp.isActive && gesture.consume(at: ProcessInfo.processInfo.systemUptime)
	}

	/// `window.close()` in the page.
	func webViewDidClose(_ webView: WKWebView) { window.close() }

	/// `<input type=file>` (a file or an image attached to a prompt, a file or a folder sent to the Mac's folder): the person picks
	/// in the system's panel, which says where it goes; the page gets what was picked. A folder only for an input that asks for one.
	func webView(
		_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
		completionHandler: @escaping ([URL]?) -> Void
	) {
		guard phase == .connected, frame.isMainFrame else { return completionHandler(nil) }
		let panel = NSOpenPanel()
		panel.canChooseFiles = true
		panel.allowsMultipleSelection = parameters.allowsMultipleSelection
		panel.canChooseDirectories = parameters.allowsDirectories
		panel.message = words.openMessage(mac: session?.mac.name ?? site.host)
		panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
	}

	/// A page's alert or question says whose it is: "Mac A says". One at a time.
	private func ask(_ message: String, frame: WKFrameInfo, buttons: [String], done: @escaping (Int) -> Void) {
		guard !dialogOpen, window.isVisible else { return done(-1) }
		dialogOpen = true
		let host = frame.securityOrigin.host.lowercased()
		let alert = NSAlert()
		alert.messageText = host == site.host || host.isEmpty ? words.pageSays(session?.mac.name ?? host) : words.pageSays(host)
		alert.informativeText = String(message.prefix(2000))
		for title in buttons { alert.addButton(withTitle: title) }
		alert.beginSheetModal(for: window) { [weak self] response in
			self?.dialogOpen = false
			done(response.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue)
		}
	}

	func webView(
		_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
		completionHandler: @escaping () -> Void
	) {
		ask(message, frame: frame, buttons: [words.ok]) { _ in completionHandler() }
	}

	func webView(
		_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
		completionHandler: @escaping (Bool) -> Void
	) {
		ask(message, frame: frame, buttons: [words.ok, words.cancel]) { completionHandler($0 == 0) }
	}

	/// No microphone, no camera, no screen for a page of another Mac.
	func webView(
		_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
		type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void
	) {
		decisionHandler(.deny)
	}

	// MARK: The window

	func windowDidEnterFullScreen(_ notification: Notification) { report(fullScreen: true) }
	func windowDidExitFullScreen(_ notification: Notification) { report(fullScreen: false) }

	/// What the page is told when its window enters or leaves full screen (as in a pop-out).
	private func report(fullScreen: Bool) {
		web.evaluateJavaScript(
			"window.dispatchEvent(new CustomEvent('ompw-fullscreen', { detail: \(fullScreen) }))", completionHandler: nil)
	}

	/// Closing the window ends it: the page goes, and with it its socket. The red button and ⌘W close this window only.
	func windowWillClose(_ notification: Notification) {
		titleObservation = nil
		if let gestureMonitor { NSEvent.removeMonitor(gestureMonitor) }
		gestureMonitor = nil
		web.stopLoading()
		web.navigationDelegate = nil
		web.uiDelegate = nil
		// The page unloads, which closes its socket now rather than whenever the web view is freed.
		web.load(URLRequest(url: URL(string: "about:blank")!))
		window.delegate = nil
		window.contentView = nil
		session?.windowClosed(self)
	}
}

// MARK: - A Mac's windows

/// The bridges the page may call, which a window wires to the session instead of to itself: a web view keeps its handlers
/// strongly, so a session that named itself would never be freed.
@available(macOS 14.0, *)
private final class WeakHandler: NSObject, WKScriptMessageHandler {
	weak var target: RemoteMacSession?
	init(_ target: RemoteMacSession) { self.target = target }
	func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
		target?.received(message)
	}
}

/// Everything open on one remote Mac: its window, and the pop-outs the page asked for. They share one configuration, so one
/// data store, one content blocker and the same bridges.
@available(macOS 14.0, *)
final class RemoteMacSession: NSObject {
	static let maxWindows = 8

	private(set) var mac: RemoteMac
	let language: () -> ShellLanguage
	private weak var owner: RemoteMacsController?
	private(set) var windows: [RemoteWindow] = []
	private var configuration: WKWebViewConfiguration?
	/// Where the last pop-out was put, so that the next one is not exactly over it.
	var cascade = NSPoint.zero
	/// Each Mac's window comes back at the size and place it was left in (a test turns it off: it would write to the defaults).
	var rememberFrames = true
	private var connectedNoted = false
	/// Windows are put in front when they open (a test turns it off, so that none is ever on the screen).
	private var showsWindows = true

	/// The compiled blocker, once (it does not change while the app runs).
	private static var rules: WKContentRuleList?

	var site: RemoteSite { RemoteSite(host: mac.host, team: mac.team) }

	init(mac: RemoteMac, language: @escaping () -> ShellLanguage, owner: RemoteMacsController) {
		self.mac = mac
		self.language = language
		self.owner = owner
	}

	/// Where the Mac's downloads are saved: the person picks, and the file is marked as downloaded.
	lazy var downloads = DownloadSaver(
		choose: { [weak self] name, done in
			guard let self, let anchor = self.anchorWindow else { return done(nil) }
			let panel = NSSavePanel()
			panel.nameFieldStringValue = name
			panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
			panel.message = RemoteWords(self.language()).saveMessage(file: name, mac: self.mac.name)
			panel.beginSheetModal(for: anchor) { r in done(r == .OK ? panel.url : nil) }
		},
		saved: { [weak self] url in
			markDownloaded(url, from: self?.mac.host ?? "")
			NSWorkspace.shared.activateFileViewerSelecting([url])
		},
		failed: { [weak self] title, detail in
			DispatchQueue.main.async {
				guard let self, let anchor = self.anchorWindow else { return }
				let alert = NSAlert()
				alert.alertStyle = .warning
				alert.messageText = title
				alert.informativeText = detail
				alert.beginSheetModal(for: anchor)
			}
		})

	/// The window a sheet of this Mac hangs from.
	var anchorWindow: NSWindow? {
		windows.first { $0.window.isKeyWindow }?.window ?? windows.first { $0.window.isVisible }?.window
	}

	/// The data store a window of this session uses, made from the identifier `mac.storeIdentifier` gives: the Mac's team's
	/// (shared with the other Macs of the team) or its own. A test replaces it (a store of the real identifier lives on disk).
	var makeDataStore: (UUID) -> WKWebsiteDataStore = { WKWebsiteDataStore(forIdentifier: $0) }

	/// Compile the blocker if it is not yet, then make the configuration and open the window. `done(false)`: the blocker could
	/// not be made, and nothing was opened (a page that nothing keeps off this Mac is not shown).
	///
	/// `show` is for the tests (the window is put in front, which the app wants): a window that is not shown is never on the
	/// screen of whoever runs them.
	func start(show: Bool = true, done: @escaping (Bool) -> Void) {
		RemoteMacSession.loadRules { [weak self] rules in
			guard let self, let rules else { return done(false) }
			let configuration = self.makeConfiguration(rules: rules, dataStore: self.makeDataStore(self.mac.storeIdentifier))
			self.configuration = configuration
			self.showsWindows = show
			let window = RemoteWindow(session: self, configuration: configuration, popOut: false, features: nil, near: nil)
			self.windows.append(window)
			if show { window.show() }
			window.start()
			done(true)
		}
	}

	private static func loadRules(_ done: @escaping (WKContentRuleList?) -> Void) {
		if let rules { return done(rules) }
		WKContentRuleListStore.default().compileContentRuleList(
			forIdentifier: "ompw-remote-1", encodedContentRuleList: remoteContentRules()
		) { list, _ in
			DispatchQueue.main.async {
				rules = list
				done(list)
			}
		}
	}

	private func makeConfiguration(rules: WKContentRuleList, dataStore: WKWebsiteDataStore) -> WKWebViewConfiguration {
		let configuration = WKWebViewConfiguration()
		// The store of this Mac's team (or its own, while the team is not known): the cookies and sign-in of the Macs of other teams
		// are in no other window's, and the token cookie of this app's own server (in the default store) is in none of them.
		configuration.websiteDataStore = dataStore
		configuration.userContentController.add(rules)
		let handler = WeakHandler(self)
		configuration.userContentController.add(handler, name: "ompwTheme")
		configuration.userContentController.add(handler, name: "ompwWindow")
		configuration.userContentController.add(handler, name: "ompwView")
		configuration.userContentController.addUserScript(
			WKUserScript(source: AppDelegate.themeScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
		configuration.mediaTypesRequiringUserActionForPlayback = .all
		return configuration
	}

	/// A message from a page's bridge: only the Mac's own page, in its main frame, once signed in.
	func received(_ message: WKScriptMessage) {
		guard let web = message.webView, let window = windows.first(where: { $0.web === web }) else { return }
		let origin = message.frameInfo.securityOrigin
		guard
			isRemotePage(
				isMainFrame: message.frameInfo.isMainFrame, scheme: origin.protocol, host: origin.host, port: origin.port,
				site: site, phase: window.phase)
		else { return }
		switch message.name {
		case "ompwTheme":
			// The window behind the page takes the page's colour (as the app's own does); nothing is remembered for the next start.
			guard let css = message.body as? String, let color = NSColor(cssHex: css) else { return }
			window.window.backgroundColor = color
			web.underPageBackgroundColor = color
		case "ompwWindow":
			guard let body = message.body as? [String: Any], body["type"] as? String == "toggleFullScreen",
				window.allowFullScreenForPage()
			else { return }
			window.window.toggleFullScreen(nil)
		case "ompwView":
			// What the page shows, and that it is up: what a notification of this Mac needs to be wanted only when nobody is looking, and a
			// click on one to be handed over.
			guard case .viewing(let nowShown)? = parseNotifyRequest(message.body) else { return }
			window.shown = nowShown
			window.pageUp = true
			deliverPending(to: window)
		default:
			break
		}
	}

	/// A click on a notification of this Mac's conversation that came before its window's page could be told (the window was closed, or
	/// is loading): the one that opened it.
	private var pending: [String: Any]?

	/// Hand a click on a notification to this Mac's own window, which is open (see `bringForward`): the page opens the conversation
	/// at once if it is up, else as soon as it says what it shows.
	func hand(_ event: [String: Any]) {
		pending = event
		if let main = windows.first(where: { !$0.isPopOut }), main.pageUp { deliverPending(to: main) }
	}

	private func deliverPending(to window: RemoteWindow) {
		guard !window.isPopOut, let event = pending else { return }
		pending = nil
		window.web.callAsyncJavaScript(
			"window.dispatchEvent(new CustomEvent('ompw-notification', { detail }))",
			arguments: ["detail": event], in: nil, in: .page
		) { [weak self] result in
			if case .failure = result { self?.pending = event }
		}
	}

	/// Whether somebody is looking at this conversation of the Mac: a window of it is the one in use (the app is the active one and the
	/// window its key window) and its page shows the conversation (`isLooking`).
	func isLooked(at banner: Banner) -> Bool {
		windows.contains {
			isLooking(
				focused: NSApp.isActive && $0.window.isKeyWindow, shown: $0.shown, liveId: banner.liveId, file: banner.file)
		}
	}

	func openPopOut(configuration: WKWebViewConfiguration, features: WKWindowFeatures, near: NSWindow?) -> WKWebView? {
		guard windows.count < RemoteMacSession.maxWindows else { return nil }
		let window = RemoteWindow(session: self, configuration: configuration, popOut: true, features: features, near: near)
		windows.append(window)
		if showsWindows { window.show() }
		return window.web
	}

	/// The Mac's own window in front: the one that is open, or, when only a pop-out is left, a new one (the page loads again, in
	/// the store it was signed in with), so that choosing the Mac in the menu always gets to its page.
	func bringForward() {
		if let main = windows.first(where: { !$0.isPopOut }) {
			let window = main.window
			if window.isMiniaturized { window.deminiaturize(nil) }
			window.makeKeyAndOrderFront(nil)
			NSApp.activate(ignoringOtherApps: true)
		} else if let configuration {
			let window = RemoteWindow(session: self, configuration: configuration, popOut: false, features: nil, near: nil)
			windows.append(window)
			if showsWindows { window.show() }
			window.start()
		}
	}

	/// Close every window of this Mac, which ends the session.
	func disconnect() {
		for window in windows { window.close() }
	}

	func windowClosed(_ window: RemoteWindow) {
		windows.removeAll { $0 === window }
		guard windows.isEmpty else { return }
		// The last window went: the configuration lets go of the bridges (it holds them strongly) and the session is over.
		if let controller = configuration?.userContentController {
			controller.removeScriptMessageHandler(forName: "ompwTheme")
			controller.removeScriptMessageHandler(forName: "ompwWindow")
			controller.removeScriptMessageHandler(forName: "ompwView")
			controller.removeAllUserScripts()
		}
		configuration = nil
		owner?.sessionEnded(mac.id)
	}

	/// The first time the Mac's own page is up in this session: its last-connected time is kept.
	func noteConnected() {
		guard !connectedNoted else { return }
		connectedNoted = true
		owner?.connected(mac.id)
	}

	/// The sign-in's team was seen: kept for the Mac when it had none (the server keeps the first one it is told). This window
	/// keeps the store it has: the team's store is not switched to in the middle of a session, which would drop the sign-in the
	/// page is using. The next window of this Mac, opened after the server wrote the team, uses the team's store, which holds no
	/// sign-in yet unless another Mac of that team made one: the person signs in once more there, once for the whole team.
	func pin(team: String) {
		guard mac.team == nil, isTeamName(team) else { return }
		mac.team = team
		owner?.pinned(mac.id, team: team)
	}

	func renamed(to name: String) {
		mac.name = name
		for window in windows { window.renamed() }
	}
}

/// A file a remote Mac's page had saved here is marked as downloaded (the quarantine attribute), unless it already is: the
/// system then asks before opening what the Mac sent, as it does for a browser's downloads.
func markDownloaded(_ file: URL, from host: String) {
	var url = file
	guard let existing = try? url.resourceValues(forKeys: [.quarantinePropertiesKey]), existing.quarantineProperties == nil else { return }
	var values = URLResourceValues()
	values.quarantineProperties = [
		kLSQuarantineTypeKey as String: kLSQuarantineTypeOtherDownload as String,
		kLSQuarantineAgentNameKey as String: appName,
		kLSQuarantineDataURLKey as String: "https://\(host)/",
	]
	try? url.setResourceValues(values)
}
