// omp-webui macOS shell: starts the bundled omp-webui server and shows it in a
// native WebKit window. The server binary (Bun runtime included) and the built
// web UI live in Contents/Resources; omp itself is the one installed on this Mac.
import AppKit
import WebKit

let appName = "omp-webui"

// MARK: - Environment

/// `#rgb` or `#rrggbb`, as a page's theme-color gives it.
extension NSColor {
	convenience init?(cssHex css: String) {
		var hex = css.trimmingCharacters(in: .whitespaces)
		guard hex.hasPrefix("#") else { return nil }
		hex.removeFirst()
		if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
		guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
		self.init(
			srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
			blue: CGFloat(value & 0xff) / 255, alpha: 1)
	}
}

func randomToken() -> String {
	var bytes = [UInt8](repeating: 0, count: 24)
	_ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
	return bytes.map { String(format: "%02x", $0) }.joined()
}

/// The app's data directory: `OMP_WEBUI_DATA_DIR` in the environment the app was started with (a terminal, a test) names another
/// one, as `OMP_WEBUI_PORT` names another port; otherwise it is ~/Library/Application Support/omp-webui. The server keeps its
/// files there, among them the list of other Macs (`remote-macs.json`), which the server alone writes and the app reads.
func appDataDirectory() -> URL {
	ProcessInfo.processInfo.environment["OMP_WEBUI_DATA_DIR"].map { URL(fileURLWithPath: $0) }
		?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(appName)
}

/// The other running copy of this app that started before this one, if any. When two copies start together
/// the earlier stays and the later leaves, so exactly one remains. Launch dates only exist for copies started
/// through LaunchServices; the process id orders the rest (`NSRunningApplication.current` has none yet at
/// startup, hence `ProcessInfo`).
func runningInstance() -> NSRunningApplication? {
	guard let id = Bundle.main.bundleIdentifier else { return nil }
	let me = NSRunningApplication.current
	let myPid = ProcessInfo.processInfo.processIdentifier
	return NSRunningApplication.runningApplications(withBundleIdentifier: id)
		.filter { $0.processIdentifier != myPid && !$0.isTerminated }
		.filter { other in
			if let theirs = other.launchDate, let mine = me.launchDate, theirs != mine { return theirs < mine }
			return other.processIdentifier < myPid
		}
		.min { ($0.launchDate ?? .distantFuture) < ($1.launchDate ?? .distantFuture) }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
	/// The app's window and the page in it: made when there is one to show, and gone while the app runs in the background (see
	/// `MainWindow`).
	lazy var mainWindow = MainWindow(make: { [unowned self] drafts in self.buildWindow(drafts: drafts) })
	var window: NSWindow? { mainWindow.window }
	var webView: WKWebView? { mainWindow.webView }
	/// Where the main window was left: each window made is put there and followed (see `WindowFrameMemory`).
	let mainFrame = WindowFrameMemory(key: "main")
	/// The server, kept running while the app is (see `ServerSupervisor`).
	var supervisor: ServerSupervisor?
	var origin: URL?
	/// The server is being stopped because the app is quitting.
	var stoppingServer = false
	/// This launch's access token: the server is started with it and the web view signs in with it.
	let token = randomToken()
	/// The server stopped (or never started): there are no conversations left to ask about when quitting.
	var serverGone = false
	/// A quit is waiting for the server's answer or the user's.
	var askingToQuit = false
	/// The server's update has been handed to its helper and the app was asked to quit for it (`quitForUpdate`).
	var quittingForUpdate = false
	/// Run in Background: the app has no window and is not a regular app, and its menu bar icon is what is left of it (see
	/// `BackgroundMode`). The server and its conversations run on.
	var background: BackgroundMode!
	var inBackground: Bool { background?.isActive ?? false }
	/// The system announced the end of the session (log out, restart, shut down): the question that is open goes (see `SessionEnd`).
	lazy var sessionEnd = SessionEnd { [unowned self] in
		if self.askingToQuit && NSApp.modalWindow != nil { NSApp.abortModal() }
	}
	/// Run in Background was asked while the window was in native full screen: the window is closed once it is out (a window in a
	/// Space of its own would leave an empty one behind), or after 3 s if it does not come out.
	var leavingFullScreen = false
	/// Run in Background is under way: the server is being told, and the page asked for what must outlive it (`enterBackground`).
	/// The window opened again meanwhile cancels it.
	var enteringBackground = false
	/// What the server tells the app on its own: the menu bar icon's counts and the notifications (see `ShellEventStream`).
	lazy var shellEvents = ShellEventStream(
		token: token, language: { [unowned self] in self.shellLanguage }, onMessage: { [unowned self] in self.hear($0) })
	/// Reads the server's request to quit for an update.
	var updateQuit: UpdateQuit?
	/// Notifications are the app's own, from the server's stream (`hear`); what the page keeps of them is Settings' permission
	/// question, answered here, and a click on one, which opens the window and tells the page which conversation to show.
	lazy var notifications = NotificationBridge(
		origin: { [unowned self] in self.origin }, open: { [unowned self] in self.showWindow() })
	/// Where the files dropped on the window are: the page cannot know, so the window's web view keeps them for it (see `DropPaths`).
	lazy var drops = DropPaths(origin: { [unowned self] in self.origin })
	/// The windows the page pops out for a subagent: real windows of their own, which close without closing the app.
	lazy var popOuts = PopOutWindows(origin: { [unowned self] in self.origin })
	/// The other Macs this app can open a window onto, from macOS 14 on (see `RemoteMacsController`). The list is the local
	/// server's (it is the only writer; the app reads its file and asks it for changes). Held as an `AnyObject`: its type does not
	/// exist before then.
	var remoteMacs: AnyObject?
	/// The page's saved language (`ompw.lang`) as the server last said it: nil until asked, or when none is saved.
	var storedLanguage: String?
	/// The language of the app's own words: the page's saved language, else the Mac's first (see `ShellLanguage`).
	var shellLanguage: ShellLanguage { ShellLanguage(stored: storedLanguage, preferred: Locale.preferredLanguages) }

	@available(macOS 14.0, *)
	var remote: RemoteMacsController {
		if let made = remoteMacs as? RemoteMacsController { return made }
		let made = RemoteMacsController(
			directory: appDataDirectory(), server: { [unowned self] in self.origin.map { ($0, self.token) } },
			language: { [unowned self] in self.shellLanguage }, refreshLanguage: { [unowned self] in self.refreshLanguage() },
			notifications: notifications)
		remoteMacs = made
		return made
	}

	/// The windows onto other Macs go: they belong to those Macs, whose conversations run on there.
	func closeRemoteWindows() {
		if #available(macOS 14.0, *) { (remoteMacs as? RemoteMacsController)?.closeAll() }
	}

	/// Read the page's saved language from the local server, as a quit does: it is what the app words things in the next time.
	func refreshLanguage() {
		guard let origin else { return }
		var request = URLRequest(url: origin.appendingPathComponent("api/prefs"))
		request.setValue(token, forHTTPHeaderField: "x-omp-webui-token")
		request.timeoutInterval = 2
		URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
			guard let data, (response as? HTTPURLResponse)?.statusCode == 200,
				let values = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["values"] as? [String: Any]
			else { return }
			let stored = values[languageKey] as? String
			DispatchQueue.main.async { self?.storedLanguage = stored }
		}.resume()
	}
	/// Where downloads (an exported conversation) are saved: the user picks, and is told when it did not work.
	lazy var downloads = DownloadSaver(
		choose: { [unowned self] name, done in
			let panel = NSSavePanel()
			panel.nameFieldStringValue = name
			panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
			let finished = { (response: NSApplication.ModalResponse) in done(response == .OK ? panel.url : nil) }
			if let window = self.window { panel.beginSheetModal(for: window, completionHandler: finished) } else { panel.begin(completionHandler: finished) }
		},
		saved: { url in NSWorkspace.shared.activateFileViewerSelecting([url]) },
		failed: { [unowned self] title, detail in
			DispatchQueue.main.async {
				let alert = NSAlert()
				alert.alertStyle = .warning
				alert.messageText = title
				alert.informativeText = self.scrubbed(detail)
				if let window = self.window { alert.beginSheetModal(for: window) } else { alert.runModal() }
			}
		})

	func applicationWillFinishLaunching(_ notification: Notification) {
		// One window, never a tab bar: this keeps "Show Tab Bar" and "Show All Tabs" out of the View menu.
		NSWindow.allowsAutomaticWindowTabbing = false
	}

	func applicationDidFinishLaunching(_ notification: Notification) {
		buildMenu()
		background = BackgroundMode(
			status: StatusMenu(
				language: { [unowned self] in self.shellLanguage }, open: { [unowned self] in self.showWindow() },
				quit: { NSApp.terminate(nil) }, pauseAll: { [unowned self] in self.pauseAll(false) },
				resumeAll: { [unowned self] in self.pauseAll(true) }, opening: { [unowned self] in self.readQuota() },
				questions: { [unowned self] in self.showQuestions() }))
		// Listening from the start: the announcement of a logout comes before any quit.
		_ = sessionEnd
		showWindow()
		startServer()
	}

	/// The window is closed only by `runInBackground`, and the app ends only through a quit: a window that closes while the app
	/// runs in the background does not end it. (Nothing makes a window of the app come back by itself: the app opens one when
	/// the person asks for it, from the menu bar icon, a notification or the app being opened again.)
	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { !inBackground }

	/// Quitting asks first, unless the person chose an answer for good: run in the background (the window closes; the app,
	/// its server, its conversations and remote access run on) or quit. A real quit stops the server and every conversation it
	/// runs, except the ones that outlive it: paused ones stay frozen in the background for the next launch, and ones waiting
	/// out a usage limit stay there running, where omp's own timer retries the turn at the reset. It asks first while any is
	/// still working, and says so while any stays.
	///
	/// Some quits never ask, and never leave the app running without a window: the end of the session (log out, restart, shut
	/// down: nobody is there to answer, and a question holds the logout up), the quit for an app update, a server that is gone
	/// or not yet up (`origin == nil`; an app that runs on without its server is of no use to anyone), and, in `readQuitContext`,
	/// a server that does not answer within two seconds.
	func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
		let endingSession = sessionEnd.isEnding(by: NSAppleEventManager.shared().currentAppleEvent)
		// A second quit while one is under way (the question is open, the server is stopping) changes nothing. The end of the
		// session is no quit to refuse: the one under way is made the one that ends the app, and the question goes. (AppKit
		// does not show a second quit event to this method while one is pending; `sessionEnd` is what hears of it then.)
		if stoppingServer || askingToQuit {
			guard endingSession else { return .terminateCancel }
			if askingToQuit && NSApp.modalWindow != nil { NSApp.abortModal() }
			return .terminateLater
		}
		if quittingForUpdate || endingSession || serverGone || origin == nil {
			guard supervisor != nil else { return .terminateNow }
			stopServerAndQuit()
			return .terminateLater
		}
		askingToQuit = true
		readQuitContext { context in
			let finish = { (quit: Bool) in
				self.askingToQuit = false
				if quit || self.sessionEnd.isEnding {
					self.stopServerAndQuit()
				} else {
					NSApp.reply(toApplicationShouldTerminate: false)
					// Cancelled in the background (Quit from the menu bar icon): the question activated the app, and it goes back.
					if self.inBackground { self.background.yieldScreen() }
				}
			}
			if self.sessionEnd.isEnding { return finish(true) }
			switch quitFirst(action: context.action, inBackground: self.inBackground, reachable: context.reachable) {
			case .runInBackground:
				self.askingToQuit = false
				NSApp.reply(toApplicationShouldTerminate: false)
				self.runInBackground()
			case .askBackgroundOrQuit:
				self.answer(quitDialog(context, offersBackground: true), finish)
			case .quit:
				if context.running.needsWarning { self.answer(quitDialog(context, offersBackground: false), finish) } else { finish(true) }
			}
		}
		return .terminateLater
	}

	/// The window is the whole app: its close button quits, with the same question as ⌘Q.
	func windowShouldClose(_ sender: NSWindow) -> Bool {
		NSApp.terminate(nil)
		return false
	}

	/// Opening the app again — its Dock icon, Finder, a second copy of it, the menu bar icon in the background — brings its window.
	func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
		showWindow()
		return false
	}

	/// The app is the active one, which is its window coming to the front: the person looks, and the runs that finished until now
	/// are seen (the icon's ✓ goes).
	func applicationDidBecomeActive(_ notification: Notification) {
		background?.status.look()
	}

	/// The window in front on the Questions page, made if the app has none (the menu bar icon's line "N questions waiting").
	func showQuestions() {
		mainWindow.route(to: "#/questions")
		showWindow()
	}

	/// The window in front, made if the app has none (back from the background: a fresh page), and the app active.
	func showWindow() {
		// The notice the server was given (see `announceBackground`) lapses by itself after 10 s: a window opened again within that
		// time says it does not close now, so that a browser tab of this computer that closes then is not taken for it.
		let away = enteringBackground || inBackground
		leavingFullScreen = false
		enteringBackground = false
		if inBackground { background.leave() }
		if away { announceBackground(cancel: true) {} }
		mainWindow.open()
		guard let window else { return }
		if NSApp.isHidden { NSApp.unhide(nil) }
		if window.isMiniaturized { window.deminiaturize(nil) }
		window.makeKeyAndOrderFront(nil)
		NSApp.activate(ignoringOtherApps: true)
	}

	/// The window is closed (and a subagent's pop-outs with it) and the app runs on without it: the server, its conversations and
	/// remote access are untouched, there is no Dock icon, and the menu bar icon, a notification or opening the app again
	/// brings the window back (`showWindow`). The page goes with the window: nothing in the background depends on one (see
	/// `shellevents.swift`). A window in native full screen leaves it first (it would leave a Space of its own behind).
	func runInBackground() {
		guard !inBackground, !leavingFullScreen, !enteringBackground else { return }
		guard let window, window.styleMask.contains(.fullScreen) else { return enterBackground() }
		leavingFullScreen = true
		window.toggleFullScreen(nil)
		// A window that does not come out of full screen is closed all the same.
		DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.enterBackgroundOutOfFullScreen() }
	}

	func windowDidExitFullScreen(_ notification: Notification) { enterBackgroundOutOfFullScreen() }

	private func enterBackgroundOutOfFullScreen() {
		guard leavingFullScreen else { return }
		leavingFullScreen = false
		enterBackground()
	}

	/// What the window's page leaves, before it goes (each is waited for 1.5 s at most: a server or a page that does not answer must
	/// not hold the app up): the server is told that the page's socket closes on purpose, so that the page's terminals are held for
	/// the page of the window that opens again (see `PtyManager.expectDetach`); and the page's unsent drafts and the view it is on,
	/// which are in the page alone, are read and kept for it (see `MainWindow.remember`).
	private func enterBackground() {
		guard !inBackground, !enteringBackground else { return }
		enteringBackground = true
		// The menu of the icon is worded in the page's language: the one that is saved now.
		refreshLanguage()
		let group = DispatchGroup()
		group.enter()
		announceBackground { group.leave() }
		group.enter()
		mainWindow.remember(timeout: 1.5) { group.leave() }
		group.notify(queue: .main) { [self] in
			// The window was opened again meanwhile (the icon, a notification, the app opened again): nothing is closed.
			guard enteringBackground else { return }
			enteringBackground = false
			guard !inBackground else { return }
			popOuts.closeAll()
			closeRemoteWindows()
			background.enter {
				mainWindow.close()
				notifications.pageGone()
			}
		}
	}

	/// Tell the server the window is about to close for Run in Background (`POST /api/shell/background`), or, with `cancel`, that it
	/// will not (`DELETE`); `done` runs once it answered or after 1.5 s.
	func announceBackground(cancel: Bool = false, _ done: @escaping () -> Void) {
		guard let origin else { return done() }
		var request = URLRequest(url: origin.appendingPathComponent("api/shell/background"))
		request.httpMethod = cancel ? "DELETE" : "POST"
		request.setValue(token, forHTTPHeaderField: "x-omp-webui-token")
		request.setValue("1", forHTTPHeaderField: "x-omp-webui")
		request.timeoutInterval = 1.5
		URLSession.shared.dataTask(with: request) { _, _, _ in DispatchQueue.main.async(execute: done) }.resume()
	}

	/// Pause every conversation whose turn is open, or resume every paused one (the menu bar icon's Pause all and Resume all):
	/// the server does it as each one's own Pause and Resume, and its stream then says what changed.
	func pauseAll(_ resume: Bool) {
		guard let origin else { return }
		var request = URLRequest(url: origin.appendingPathComponent(resume ? "api/shell/resume-all" : "api/shell/pause-all"))
		request.httpMethod = "POST"
		request.setValue(token, forHTTPHeaderField: "x-omp-webui-token")
		request.setValue("1", forHTTPHeaderField: "x-omp-webui")
		request.timeoutInterval = 30
		URLSession.shared.dataTask(with: request).resume()
	}

	/// When, and in which language, the menu bar icon's quota lines were last asked for: again when the menu opens a minute
	/// later, or in another language (every ask may start an `omp usage`, which asks each provider).
	var quotaAsked: (at: Date, language: ShellLanguage)?

	/// Ask the server what is left of each provider's quota (`GET /api/shell/quota`) for the menu bar icon, unless it was asked
	/// less than a minute ago in the same language. The lines arrive in the menu while it is open.
	func readQuota() {
		guard let origin else { return }
		let language = shellLanguage
		if let asked = quotaAsked, asked.language == language, Date().timeIntervalSince(asked.at) < 60 { return }
		quotaAsked = (Date(), language)
		guard var url = URLComponents(url: origin.appendingPathComponent("api/shell/quota"), resolvingAgainstBaseURL: false)
		else { return }
		url.queryItems = [URLQueryItem(name: "lang", value: language == .zh ? "zh-CN" : "en")]
		guard let address = url.url else { return }
		var request = URLRequest(url: address)
		request.setValue(token, forHTTPHeaderField: "x-omp-webui-token")
		request.timeoutInterval = 30
		URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
			guard let data, (response as? HTTPURLResponse)?.statusCode == 200,
				let lines = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["lines"] as? [String]
			else { return }
			DispatchQueue.main.async { self?.background.status.update(quota: lines) }
		}.resume()
	}

	/// The server's stream says something (see `ShellMessage`): the menu bar icon's counts and whether it is wanted beside the
	/// window, or a conversation that needs somebody, which is a notification unless somebody is looking at it: the window is
	/// the one in use (the app is the active one and its window the key one) and its page shows that conversation (`isLooking`).
	func hear(_ message: ShellMessage) {
		switch message {
		case .state(let state, let epoch):
			background.status.update(state, epoch: epoch)
			background.showAlways(state.menuIcon)
		case .attention(let banner, _):
			let focused = NSApp.isActive && window?.isKeyWindow == true
			notifications.present(banner, watching: notifications.isLooked(at: banner, focused: focused))
		}
	}

	/// What a quit needs to know of the server (see `QuitContext`), asked together; `done` runs on the main queue. A server
	/// that does not answer counts as none: quitting must never hang on it.
	func readQuitContext(_ done: @escaping (QuitContext) -> Void) {
		guard let origin else { return done(QuitContext()) }
		let group = DispatchGroup()
		let answers = Answers()
		for path in ["api/lives", "api/omp", "api/prefs", "api/remote"] {
			var request = URLRequest(url: origin.appendingPathComponent(path))
			request.setValue(token, forHTTPHeaderField: "x-omp-webui-token")
			request.timeoutInterval = 2
			group.enter()
			URLSession.shared.dataTask(with: request) { data, response, _ in
				if let data, (response as? HTTPURLResponse)?.statusCode == 200, let json = try? JSONSerialization.jsonObject(with: data) {
					answers.set(path, json)
				}
				group.leave()
			}.resume()
		}
		group.notify(queue: .main) {
			done(
				quitContext(
					lives: answers.get("api/lives"), omp: answers.get("api/omp"), prefs: answers.get("api/prefs"),
					remote: answers.get("api/remote"), preferredLanguages: Locale.preferredLanguages))
		}
	}

	/// The server's answers to one `readQuitContext`, gathered from the queues of the requests.
	private final class Answers: @unchecked Sendable {
		private let lock = NSLock()
		private var values: [String: Any] = [:]
		func set(_ path: String, _ json: Any) { lock.lock(); values[path] = json; lock.unlock() }
		func get(_ path: String) -> Any? { lock.lock(); defer { lock.unlock() }; return values[path] }
	}

	/// Ends every conversation that outlives the server (paused ones would stay frozen in the background, waiting ones
	/// would go on waiting there); `done` runs once the server has, or has not answered within two seconds: quitting must
	/// never hang on it.
	func endKeptConversations(_ done: @escaping () -> Void) {
		guard let origin else { return done() }
		var request = URLRequest(url: origin.appendingPathComponent("api/lives/end-kept"))
		request.httpMethod = "POST"
		request.setValue(token, forHTTPHeaderField: "x-omp-webui-token")
		request.setValue("1", forHTTPHeaderField: "x-omp-webui")
		request.timeoutInterval = 2
		URLSession.shared.dataTask(with: request) { _, _, _ in done() }.resume()
	}

	/// Make an answer the standing one ("Don't ask again"): the preference Settings shows, kept by the server like the page's
	/// others. `done` runs once the server has answered, or two seconds have passed.
	func rememberQuitAction(_ action: QuitAction, done: @escaping () -> Void = {}) {
		guard let origin else { return done() }
		var request = URLRequest(url: origin.appendingPathComponent("api/prefs"))
		request.httpMethod = "POST"
		request.setValue(token, forHTTPHeaderField: "x-omp-webui-token")
		request.setValue("1", forHTTPHeaderField: "x-omp-webui")
		request.setValue("application/json", forHTTPHeaderField: "content-type")
		request.httpBody = try? JSONSerialization.data(withJSONObject: ["changes": [quitActionKey: action.rawValue]])
		request.timeoutInterval = 2
		URLSession.shared.dataTask(with: request) { _, _, _ in DispatchQueue.main.async(execute: done) }.resume()
	}

	/// Show the question and act on the answer. `finish(true)` goes on with the quit that is under way; `finish(false)` ends it
	/// and the app stays as it is. Running in the background is a third thing: the quit is cancelled and the window goes.
	func answer(_ dialog: QuitDialog, _ finish: @escaping (Bool) -> Void) {
		let (choice, remember) = ask(dialog)
		switch choice {
		case .cancel:
			finish(false)
		case .runInBackground:
			if remember { rememberQuitAction(.background) }
			askingToQuit = false
			NSApp.reply(toApplicationShouldTerminate: false)
			runInBackground()
		case .quit:
			if remember { rememberQuitAction(.quit) { finish(true) } } else { finish(true) }
		case .quitEndingKept:
			endKeptConversations { DispatchQueue.main.async { finish(true) } }
		}
	}

	/// Show `dialog` and say which answer was chosen, and whether "Don't ask again" was ticked with an answer it applies to. A
	/// question that is closed some other way (the end of the session takes it away) is a Cancel.
	func ask(_ dialog: QuitDialog) -> (choice: QuitChoice, remember: Bool) {
		NSApp.activate(ignoringOtherApps: true)
		let alert = NSAlert()
		alert.alertStyle = dialog.informational ? .informational : .warning
		alert.messageText = dialog.message
		alert.informativeText = dialog.detail
		for spec in dialog.buttons {
			alert.addButton(withTitle: spec.title).hasDestructiveAction = spec.destructive
		}
		if let title = dialog.remember {
			alert.showsSuppressionButton = true
			alert.suppressionButton?.title = title
		}
		// Escape cancels in every language and wherever Cancel stands in the row: AppKit only knows the English "Cancel" by its title.
		let cancel = dialog.buttons.firstIndex { $0.choice == .cancel }.map { alert.buttons[$0] }
		let escape = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
			guard event.keyCode == 53, let cancel else { return event }
			cancel.performClick(nil)
			return nil
		}
		defer { escape.map(NSEvent.removeMonitor) }
		let reply = alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
		let choice = dialog.buttons.indices.contains(reply) ? dialog.buttons[reply].choice : .cancel
		return (choice, alert.suppressionButton?.state == .on && QuitDialog.rememberable.contains(choice))
	}

	// MARK: Server

	func startServer() {
		// Where omp and the tools are is the server's business (see `OMP_WEBUI_LOGIN_SHELL` below).
		guard let resources = Bundle.main.resourceURL else { return }
		let dataDir = appDataDirectory()
		try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)

		var env = ProcessInfo.processInfo.environment
		// The server takes the environment of the user's login shell itself (server/omp/login-env.ts): PATH exactly as a
		// terminal has it, and what `.zshrc` exports, at start and again on the first-run screen's "Look again". It also
		// looks for omp, which the web UI offers to install when there is none.
		env["OMP_WEBUI_LOGIN_SHELL"] = env["SHELL"] ?? "/bin/zsh"
		env["OMP_WEBUI_DATA_DIR"] = dataDir.path
		env["OMP_WEBUI_DIST"] = resources.appendingPathComponent("web").path
		env["OMP_WEBUI_PORT"] = env["OMP_WEBUI_PORT"] ?? "7878"
		env["OMP_WEBUI_AUTO_PORT"] = "1"
		env["OMP_WEBUI_TOKEN"] = token
		env["OMP_WEBUI_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
		// The server replaces this app with a newer one only when it is run as a bundle: this is the path it replaces.
		env["OMP_WEBUI_APP_BUNDLE"] = Bundle.main.bundlePath
		updateQuit = UpdateQuit(dataDir: dataDir) { [weak self] in self?.quitForUpdate() }
		updateQuit?.start()

		let supervisor = ServerSupervisor(
			launch: .init(
				executable: resources.appendingPathComponent("omp-webui-server"), environment: env,
				directory: FileManager.default.homeDirectoryForCurrentUser)
		) { [weak self] event in
			guard let self, !self.stoppingServer else { return }
			switch event {
			case .ready(let port):
				self.origin = URL(string: "http://127.0.0.1:\(port)")
				self.refreshLanguage()
				self.shellEvents.connect(to: self.origin)
				// The token link stores the access cookie and redirects to the UI. After a restart of the server too: the
				// page loads again and signs in with the same token, on whatever port the new server took. (No window: the
				// next one opens on it.)
				if let url = self.takePageURL() { self.webView?.load(URLRequest(url: url)) }
			case .failed(let title, let detail):
				self.fail(title, detail)
			}
		}
		self.supervisor = supervisor
		supervisor.start()
	}

	/// Quit once the server is gone. The window goes at once; the main thread stays free (`terminateLater`) while the
	/// server closes its omp processes, which takes seconds when a conversation is busy: the app does not hang, and a
	/// stalled server is still killed after the supervisor's deadline (#375).
	func stopServerAndQuit() {
		stoppingServer = true
		shellEvents.stop()
		background?.status.remove()
		window?.orderOut(nil)
		popOuts.closeAll()
		closeRemoteWindows()
		guard let supervisor else { return NSApp.reply(toApplicationShouldTerminate: true) }
		supervisor.stop { NSApp.reply(toApplicationShouldTerminate: true) }
	}

	/// The server has handed an update to its helper and asks the app to quit (see `UpdateQuit`). It quits the way ⌘Q does,
	/// without the question: the web page asked about the conversations that are replying before the update was started, and
	/// paused ones stay in the background as they do on any quit. The helper swaps the app once this process is gone.
	func quitForUpdate() {
		// A quit that is already under way (the question is open, the server is stopping) is not changed by it.
		guard !stoppingServer, !askingToQuit else { return }
		quittingForUpdate = true
		NSApp.terminate(nil)
	}

	/// The server stopped for good (see `ServerSupervisor`), or could not be started.
	func fail(_ title: String, _ detail: String) {
		serverGone = true
		// The app may be running without a window (see `runInBackground`): the alert must be seen, not wait behind other apps.
		NSApp.activate(ignoringOtherApps: true)
		let alert = NSAlert()
		alert.messageText = title
		alert.informativeText = scrubbed(detail)
		alert.alertStyle = .critical
		alert.addButton(withTitle: "Quit")
		alert.runModal()
		NSApp.terminate(nil)
	}

	/// The server's output goes into alerts, and its start-up banner, a logged URL or an error can carry the
	/// access token: nothing an alert shows includes it.
	func scrubbed(_ text: String) -> String {
		let hidden = text.replacingOccurrences(of: token, with: "…")
		return hidden.replacingOccurrences(of: "token=[^\\s&\"']+", with: "token=…", options: .regularExpression)
	}

	// MARK: Window

	/// The page the window shows: the token link of the server that is up (nil before it is), with the view the last page was on
	/// when the window was closed for Run in Background, once.
	func takePageURL() -> URL? {
		guard let base = origin.flatMap({ URL(string: "\($0.absoluteString)/?token=\(token)") }) else { return nil }
		return pageURL(base, hash: mainWindow.takeHash())
	}

	/// The window and its page, not shown yet: `MainWindow` makes them when there are none, `showWindow` orders them in. `drafts`:
	/// what the last page held unsent, put back in the new one before its scripts run.
	func buildWindow(drafts: String?) -> MainWindow.Parts {
		let config = WKWebViewConfiguration()
		config.websiteDataStore = .default()
		config.preferences.setValue(true, forKey: "developerExtrasEnabled")
		config.userContentController.add(self, name: "ompwTheme")
		config.userContentController.add(popOuts, name: PopOutWindows.handlerName)
		config.userContentController.addScriptMessageHandler(
			notifications, contentWorld: .page, name: NotificationBridge.handlerName)
		config.userContentController.addScriptMessageHandler(drops, contentWorld: .page, name: DropPaths.handlerName)
		// The page's switcher of Macs asks the app to open a saved Mac's window or to show the sheet that adds one (macOS 14 and
		// later, where the Macs menu is). Only this window's page has it: a remote window's configuration is made in remotewindow.swift.
		if #available(macOS 14.0, *) {
			let macs = remote
			config.userContentController.addScriptMessageHandler(
				MacsBridge(origin: { [unowned self] in self.origin }, open: { macs.open($0) }, add: { macs.presentAdd() }),
				contentWorld: .page, name: MacsBridge.handlerName)
		}
		config.userContentController.addUserScript(
			WKUserScript(source: AppDelegate.themeScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
		if let drafts { config.userContentController.addUserScript(restoreDraftsScript(drafts)) }
		// What the page last said its colour is (a valid `#rgb`/`#rrggbb`), else the dark default.
		let savedTheme = UserDefaults.standard.string(forKey: "themeColor").flatMap { NSColor(cssHex: $0) == nil ? nil : $0 } ?? "#1a1918"
		let web = DropWebView(frame: .zero, configuration: config)
		web.drops = drops
		web.navigationDelegate = self
		web.uiDelegate = self
		notifications.webView = web
		web.allowsMagnification = true
		web.setValue(false, forKey: "drawsBackground")
		// WebKit holds back a page whose window other windows cover: its timers coarsen to seconds and what arrives over its
		// sockets is handled late, in bursts, so a transcript that is partly in view beside another app's window goes stale (#381).
		// The app turns that detection off for its web views. A WebKit without the switch just keeps its behaviour.
		if web.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) {
			web.setValue(false, forKey: "windowOcclusionDetectionEnabled")
		}
		if let url = takePageURL() {
			web.load(URLRequest(url: url))
		} else {
			web.loadHTMLString(
				"""
				<html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
				background:\(savedTheme);color:#8a8a8a;font:14px -apple-system">Starting omp…</body></html>
				""", baseURL: nil)
		}

		let window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
			// A regular title bar: the web UI's header sits below it, never under the window buttons.
			styleMask: [.titled, .closable, .miniaturizable, .resizable],
			backing: .buffered, defer: false)
		window.title = appName
		window.delegate = self
		window.tabbingMode = .disallowed
		window.backgroundColor = NSColor(cssHex: savedTheme) ?? NSColor(red: 0.102, green: 0.098, blue: 0.094, alpha: 1)
		window.minSize = NSSize(width: 420, height: 480)
		window.contentView = web
		// Where the last window was, else the middle of the screen. Not AppKit's autosave: a new window under a name the one
		// before still held kept neither its frame nor the next one's (windowframe.swift).
		if !mainFrame.restore(window, legacyName: "main") { window.center() }
		mainFrame.follow(window)
		return (window, web)
	}

	func buildMenu() {
		let main = NSMenu()
		func submenu(_ title: String, _ items: [NSMenuItem]) {
			let item = NSMenuItem()
			let menu = NSMenu(title: title)
			items.forEach(menu.addItem)
			item.submenu = menu
			main.addItem(item)
		}
		func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
			let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
			i.keyEquivalentModifierMask = mods
			return i
		}
		submenu(appName, [
			item("About \(appName)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
			.separator(),
			item("Hide \(appName)", #selector(NSApplication.hide(_:)), "h"),
			item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
			item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
			.separator(),
			item("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"),
		])
		// Standard editing commands: WebKit text fields need these for ⌘C / ⌘V / ⌘Z.
		submenu("Edit", [
			item("Undo", Selector(("undo:")), "z"),
			item("Redo", Selector(("redo:")), "z", [.command, .shift]),
			.separator(),
			item("Cut", #selector(NSText.cut(_:)), "x"),
			item("Copy", #selector(NSText.copy(_:)), "c"),
			item("Paste", #selector(NSText.paste(_:)), "v"),
			item("Select All", #selector(NSText.selectAll(_:)), "a"),
		])
		submenu("View", [
			item("Reload", #selector(reload), "r"),
			item("Actual Size", #selector(zoomReset), "0"),
			item("Zoom In", #selector(zoomIn), "+"),
			item("Zoom Out", #selector(zoomOut), "-"),
			.separator(),
			item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
		])
		// The Macs menu: the other Macs this app opens a window onto (macOS 14 and later; before it there is no such menu).
		if #available(macOS 14.0, *) { main.addItem(remote.menuItem) }
		submenu("Window", [
			item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
			item("Close", #selector(NSWindow.performClose(_:)), "w"),
		])
		// From macOS 14 the Window menu also lists the windows by their titles, which is how a window onto another Mac is found
		// by its name; before it the menu is what it was.
		if #available(macOS 14.0, *) { NSApp.windowsMenu = main.items.first { $0.submenu?.title == "Window" }?.submenu }
		NSApp.mainMenu = main
	}

	/// The web view the View menu acts on: the one of the window in front (a pop-out's too); none while the app has no window.
	var frontWebView: WKWebView? {
		(NSApp.keyWindow?.contentView as? RemoteContentView)?.web
			?? webView.map { targetWebView(keyWindow: NSApp.keyWindow, fallback: $0) }
	}
	@objc func reload() {
		// A window onto another Mac reloads its page, or tries the Mac again when there is none.
		if let remote = NSApp.keyWindow?.contentView as? RemoteContentView, let reload = remote.reload { return reload() }
		frontWebView?.reload()
	}
	@objc func zoomReset() { frontWebView?.pageZoom = 1 }
	@objc func zoomIn() { if let web = frontWebView { web.pageZoom = min(web.pageZoom + 0.1, 3) } }
	@objc func zoomOut() { if let web = frontWebView { web.pageZoom = max(web.pageZoom - 0.1, 0.5) } }

	// MARK: Navigation

	func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { notifications.pageLoading() }

	func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
		if action.shouldPerformDownload { return decisionHandler(.download) }
		guard let url = action.request.url else { return decisionHandler(.allow) }
		switch navigationVerdict(for: url, origin: origin) {
		case .allow:
			decisionHandler(.allow)
		case .openExternally:
			NSWorkspace.shared.open(url)
			decisionHandler(.cancel)
		case .cancel:
			// A file dropped on the page, a data: URL…: showing it would replace the UI, with no way back.
			decisionHandler(.cancel)
		}
	}

	func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
		decisionHandler(response.canShowMIMEType ? .allow : .download)
	}

	func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = downloads }
	func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = downloads }

	/// Links with target=_blank / window.open: the page's own request for a window of its own (a subagent's live view,
	/// see `PopOutWindows`) opens one; for anything else the default browser gets what a navigation would hand it (see
	/// `externalURL`).
	func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
		if let popped = popOuts.webView(for: action, configuration: configuration, features: windowFeatures, opener: webView) { return popped }
		if let url = externalURL(forNewWindow: action.request.url, origin: origin) { NSWorkspace.shared.open(url) }
		return nil
	}

	/// <input type=file> (image attachments).
	func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
		guard let window = webView.window else { return completionHandler(nil) }
		let panel = NSOpenPanel()
		panel.allowsMultipleSelection = parameters.allowsMultipleSelection
		panel.canChooseDirectories = parameters.allowsDirectories
		panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
	}

	func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
		guard let window = webView.window else { return completionHandler() }
		let a = NSAlert()
		a.messageText = message
		a.beginSheetModal(for: window) { _ in completionHandler() }
	}

	func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
		guard let window = webView.window else { return completionHandler(false) }
		let a = NSAlert()
		a.messageText = message
		a.addButton(withTitle: "OK")
		a.addButton(withTitle: "Cancel")
		a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
	}

	/// The web content process died (memory pressure, crash): reload instead of a blank window.
	func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

	// MARK: Theme

	/// The page's `<meta name="theme-color">` (the web UI sets it from its palette and light/dark choice) is the colour
	/// of the window behind it and of what shows while it resizes or reloads, so a light palette never flashes dark.
	static let themeScript = """
		(function () {
			var last = null;
			function report() {
				var meta = document.querySelector('meta[name="theme-color"]');
				var color = meta && meta.getAttribute("content");
				if (color && color !== last) { last = color; window.webkit.messageHandlers.ompwTheme.postMessage(color); }
			}
			report();
			new MutationObserver(report).observe(document.head, { subtree: true, childList: true, attributes: true, attributeFilter: ["content"] });
		})();
		"""

	func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
		guard message.name == "ompwTheme", let css = message.body as? String, let color = NSColor(cssHex: css) else { return }
		// The page that said it is in the app's window or in a pop-out: that window takes the colour.
		let page = message.webView ?? webView
		(page?.window ?? window)?.backgroundColor = color
		if #available(macOS 12.0, *) { page?.underPageBackgroundColor = color }
		// The next start shows it from the first frame.
		UserDefaults.standard.set(css, forKey: "themeColor")
	}
}

let app = NSApplication.shared

// A second copy of the app (another path, `open -n`, a build next to the installed one) must not start a
// server of its own: it asks the running copy to come forward, as opening the app again does, and leaves.
// After `NSApplication.shared`, so that two copies started together have both registered and see each other.
if let running = runningInstance() {
	if let url = running.bundleURL {
		let configuration = NSWorkspace.OpenConfiguration()
		configuration.activates = true
		var asked = false
		NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, _ in asked = true }
		let deadline = Date().addingTimeInterval(2)
		while !asked && Date() < deadline { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
	}
	exit(0)
}

let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
