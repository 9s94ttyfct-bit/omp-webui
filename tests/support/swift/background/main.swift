import AppKit
import WebKit

// Harness for macos/background.swift and macos/mainwindow.swift (Run in Background, #627): the app has no window at all while it
// runs in the background. Prints one JSON line. See tests/unit/macos-background.test.ts.
//
//   harness model     the menu bar icon's menu and title for each count, in both languages (no window server needed)
//   harness window    `MainWindow`: a real window with a real page is made, closed and made again; once closed neither is kept
//                     (a window server session; nothing is ordered in, so nothing shows)
//   harness mode      `BackgroundMode` with the real application: the activation policy, the menu bar icon and its menu, with
//                     the window closed and opened as the app does (puts an icon in the menu bar and a Dock icon on the screen for a
//                     moment: opt-in, OMPW_GUI_TESTS=1)

/// `main.swift` of the app names the app.
let appName = "omp-webui"

setvbuf(stdout, nil, _IOLBF, 0)

func json(_ value: Any) -> String {
	String(data: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
}

func spin(_ seconds: TimeInterval, until done: () -> Bool = { false }) {
	let end = Date().addingTimeInterval(seconds)
	while Date() < end && !done() { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
}

func name(_ role: StatusLine.Role) -> String {
	switch role {
	case .open: return "open"
	case .info: return "info"
	case .pauseAll: return "pauseAll"
	case .resumeAll: return "resumeAll"
	case .quit: return "quit"
	case .separator: return "separator"
	case .questions: return "questions"
	}
}

// MARK: model

func model() -> [String: Any] {
	func lines(
		_ working: Int, _ asking: Int, _ language: ShellLanguage, paused: Int = 0, quota: [String] = [], questions: Int = 0,
		unseen: Int = 0
	) -> [[String: String]] {
		statusMenu(
			state: ShellState(working: working, asking: asking, paused: paused, questions: questions), quota: quota,
			language: language, unseenFinished: unseen
		).map { ["role": name($0.role), "title": $0.title] }
	}
	var out: [String: Any] = [:]
	for (key, language) in [("en", ShellLanguage.en), ("zh", ShellLanguage.zh)] {
		out[key] = [
			"none": lines(0, 0, language), "one": lines(1, 0, language), "many": lines(3, 0, language),
			"waiting": lines(0, 1, language), "both": lines(2, 2, language), "paused": lines(0, 0, language, paused: 2),
			"mixed": lines(1, 0, language, paused: 1), "quota": lines(0, 0, language, quota: ["anthropic: 62% left", "zai: 30% left"]),
			"question": lines(0, 0, language, questions: 1), "questions": lines(1, 0, language, questions: 3),
			"finishedOne": lines(0, 0, language, unseen: 1), "finishedMany": lines(0, 0, language, unseen: 4),
			"everything": lines(1, 1, language, paused: 1, quota: ["zai: 30% left"], questions: 2, unseen: 2),
		]
	}
	out["titles"] = [
		statusTitle(asking: 0), statusTitle(asking: 1), statusTitle(asking: 12), statusTitle(asking: 0, questions: 2),
		statusTitle(asking: 2, questions: 3), statusTitle(asking: 0, questions: 0, finished: 1),
		statusTitle(asking: 1, questions: 1, finished: 4),
	]
	// What the person has seen of the runs that finished: the first count of a server's run is what there was, later ones are news
	// until the person looks, and a server that began again starts it over. A state that names no epoch is of the one before.
	var watch = FinishedWatch()
	var unseen: [Int] = []
	watch.hear(finished: 3, epoch: "E1")
	unseen.append(watch.unseen)
	watch.hear(finished: 5, epoch: "E1")
	unseen.append(watch.unseen)
	watch.hear(finished: 5, epoch: "E1")
	unseen.append(watch.unseen)
	watch.look()
	unseen.append(watch.unseen)
	watch.hear(finished: 6, epoch: "E1")
	unseen.append(watch.unseen)
	watch.hear(finished: 1, epoch: "E2")
	unseen.append(watch.unseen)
	watch.hear(finished: 2, epoch: "E2")
	unseen.append(watch.unseen)
	watch.hear(finished: 4, epoch: nil)
	unseen.append(watch.unseen)
	out["watch"] = unseen
	// The window that is closed keeps the view the menu bar icon's questions line asks for, for the page it opens next.
	let closed = MainWindow(make: parts)
	closed.route(to: "#/questions")
	out["route"] = [orNull(closed.takeHash()), orNull(closed.takeHash())]
	return out
}

// MARK: window

/// A page and a window as the app makes them, minus everything that is the app's own (script handlers, delegates); with the
/// drafts of the last page put back, as the app does.
func parts(_ drafts: String? = nil) -> MainWindow.Parts {
	let config = WKWebViewConfiguration()
	if let drafts { config.userContentController.addUserScript(restoreDraftsScript(drafts)) }
	let web = WKWebView(frame: .zero, configuration: config)
	let window = NSWindow(
		contentRect: NSRect(x: 120, y: 120, width: 640, height: 420), styleMask: [.titled, .closable, .miniaturizable, .resizable],
		backing: .buffered, defer: false)
	window.contentView = web
	return (window, web)
}

/// Windows of the application that are the app's own: the status bar's and a menu's are AppKit's. Looking at the list does not
/// keep it (`NSApp.windows` is autoreleased, and a script's one pool is never drained: a list kept by it would keep every window).
func appWindows() -> Int { autoreleasepool { NSApp.windows.filter { type(of: $0) == NSWindow.self }.count } }

/// What every window of the application is, for a message when the count is not what it should be.
func kinds() -> [String] { autoreleasepool { NSApp.windows.map { "\(type(of: $0)):\($0.title):\($0.isVisible)" } } }

final class Loaded: NSObject, WKNavigationDelegate {
	var done = false
	func webView(_ w: WKWebView, didFinish n: WKNavigation!) { done = true }
}

func windowReport() -> [String: Any] {
	_ = NSApplication.shared
	// Not a regular app: nothing here shows (no Dock icon), and nothing is ordered in.
	NSApp.setActivationPolicy(.accessory)
	let main = MainWindow(make: parts)
	var out: [String: Any] = ["openBefore": main.isOpen, "windowsBefore": appWindows()]

	weak var firstWeb: WKWebView?
	weak var firstWindow: NSWindow?
	autoreleasepool {
		out["made"] = main.open()
		firstWeb = main.webView
		firstWindow = main.window
		out["madeAgain"] = main.open()
		out["sameWindow"] = main.window === firstWindow
		out["releasedWhenClosed"] = main.window?.isReleasedWhenClosed as Any
		out["windowsOpen"] = appWindows()
		// A page that is up, as the app's is: what is released is a loaded one.
		let loaded = Loaded()
		main.webView?.navigationDelegate = loaded
		main.webView?.loadHTMLString("<html><body>page</body></html>", baseURL: nil)
		spin(10) { loaded.done }
		out["pageLoaded"] = loaded.done
		main.close()
	}
	out["openAfterClose"] = main.isOpen
	out["windowNil"] = main.window == nil
	out["webViewNil"] = main.webView == nil
	out["windowsClosed"] = appWindows()
	// What the app held is let go: a few turns of the run loop for what AppKit and WebKit release on their own.
	spin(3) { firstWeb == nil && firstWindow == nil }
	out["webViewReleased"] = firstWeb == nil
	out["windowReleased"] = firstWindow == nil
	// Closing what is not open does nothing; opening again makes new ones.
	main.close()
	out["madeNew"] = main.open()
	out["differentWindow"] = main.window !== firstWindow
	out["windowsReopened"] = appWindows()
	main.close()
	return out
}

// MARK: mode

func modeReport() -> [String: Any] {
	let app = NSApplication.shared
	app.setActivationPolicy(.regular)
	var language = ShellLanguage.en
	var opened = 0
	var quit = 0
	var out: [String: Any] = [:]
	let main = MainWindow(make: parts)
	var background: BackgroundMode!
	let showWindow = {
		if background.isActive { background.leave() }
		main.open()
		main.window?.makeKeyAndOrderFront(nil)
		opened += 1
	}
	var paused = 0
	var resumed = 0
	var asked = 0
	let status = StatusMenu(
		language: { language }, open: showWindow, quit: { quit += 1 }, pauseAll: { paused += 1 }, resumeAll: { resumed += 1 },
		questions: { asked += 1 })
	// No other app to give the screen to: the harness touches no app but itself.
	background = BackgroundMode(status: status, handoff: ScreenHandoff(otherApp: { nil }))

	func policy() -> String {
		switch NSApp.activationPolicy() {
		case .regular: return "regular"
		case .accessory: return "accessory"
		default: return "prohibited"
		}
	}

	// Each step is one turn of the app's run loop, as the app's own are: what a turn autoreleases is let go at its end. (A script
	// has one pool that is never drained, which would hold a window that was on the screen for ever.)
	weak var shownWindow: NSWindow?
	weak var shownPage: WKWebView?
	autoreleasepool {
		main.open()
		main.window?.makeKeyAndOrderFront(nil)
		shownWindow = main.window
		shownPage = main.webView
	}
	spin(0.5)
	out["front"] = ["policy": policy(), "windows": appWindows(), "icon": status.isInstalled, "active": background.isActive]

	var closing = 0
	autoreleasepool {
		background.enter {
			closing += 1
			main.close()
		}
	}
	// What AppKit and WebKit let go of on their own, a window that was on the screen included.
	spin(5) { shownWindow == nil && shownPage == nil }
	out["background"] = [
		"policy": policy(), "windows": appWindows(), "window": main.window == nil, "page": main.webView == nil, "icon": status.isInstalled,
		"active": background.isActive, "closing": closing, "titles": status.titles, "buttonTitle": status.buttonTitle as Any,
		"windowReleased": shownWindow == nil, "pageReleased": shownPage == nil, "kinds": kinds(),
	]
	// A second Run in Background changes nothing.
	background.enter { closing += 1 }
	out["againClosing"] = closing

	status.update(ShellState(working: 2, asking: 1))
	spin(0.2)
	out["counts"] = ["titles": status.titles, "buttonTitle": status.buttonTitle as Any]
	// The menu is worded in the language of the moment it opens in.
	language = .zh
	status.menuNeedsUpdate(NSMenu())
	out["chinese"] = ["titles": status.titles]
	language = .en

	// Questions that wait and runs that finished (#705). The icon counts dialogs and questions together, and a ✓ says that a run
	// finished since the person looked: opening the menu is looking, and the menu goes on saying it until it closes. A server's
	// first state says what the person has seen already.
	status.update(ShellState(working: 0, asking: 1, questions: 2, finished: 5), epoch: "E1")
	let first = ["titles": status.titles, "buttonTitle": status.buttonTitle as Any] as [String: Any]
	status.update(ShellState(working: 0, asking: 1, questions: 2, finished: 7), epoch: "E1")
	let ran = ["titles": status.titles, "buttonTitle": status.buttonTitle as Any] as [String: Any]
	status.menuNeedsUpdate(NSMenu())
	let looked = ["titles": status.titles, "buttonTitle": status.buttonTitle as Any] as [String: Any]
	status.update(ShellState(working: 0, asking: 1, questions: 2, finished: 7), epoch: "E1")
	let whileOpen = ["titles": status.titles, "buttonTitle": status.buttonTitle as Any] as [String: Any]
	status.menuDidClose(NSMenu())
	status.update(ShellState(working: 0, asking: 1, questions: 2, finished: 7), epoch: "E1")
	let closed = ["titles": status.titles, "buttonTitle": status.buttonTitle as Any] as [String: Any]
	// One more, and the app becomes the active one: that is looking too.
	status.update(ShellState(working: 0, asking: 1, questions: 2, finished: 8), epoch: "E1")
	let one = ["titles": status.titles, "buttonTitle": status.buttonTitle as Any] as [String: Any]
	status.look()
	let active = ["titles": status.titles, "buttonTitle": status.buttonTitle as Any] as [String: Any]
	// A server that began again counts from nothing, and what the person has seen starts over with it.
	status.update(ShellState(working: 0, asking: 0, questions: 0, finished: 1), epoch: "E2")
	let epoch = ["titles": status.titles, "buttonTitle": status.buttonTitle as Any] as [String: Any]
	status.update(ShellState(working: 0, asking: 0, questions: 1, finished: 3), epoch: "E2")
	language = .zh
	status.menuNeedsUpdate(NSMenu())
	let chineseFinished = ["titles": status.titles, "buttonTitle": status.buttonTitle as Any] as [String: Any]
	status.menuDidClose(NSMenu())
	language = .en
	status.choose(.questions)
	out["attention"] = [
		"first": first, "ran": ran, "looked": looked, "whileOpen": whileOpen, "closed": closed, "one": one, "active": active,
		"epoch": epoch, "chineseFinished": chineseFinished, "asked": asked, "opened": opened,
	]

	// A click on a line that says something does nothing; Pause all and Resume all are the app's; Open is the app's `showWindow`.
	status.choose(.info)
	status.choose(.separator)
	out["afterInfo"] = ["opened": opened, "quit": quit, "paused": paused, "resumed": resumed]
	status.choose(.pauseAll)
	status.choose(.resumeAll)
	out["pauseResume"] = ["paused": paused, "resumed": resumed, "opened": opened, "quit": quit]
	status.choose(.open)
	spin(0.5)
	out["reopened"] = [
		"policy": policy(), "windows": appWindows(), "window": main.window != nil, "icon": status.isInstalled, "active": background.isActive,
		"opened": opened,
	]

	// Back in the background, Quit is the app's own quit (counted here, not run).
	background.enter { main.close() }
	spin(0.3)
	status.choose(.quit)
	out["quit"] = ["quit": quit, "policy": policy(), "icon": status.isInstalled]
	background.leave()
	main.close()
	out["end"] = ["policy": policy(), "icon": status.isInstalled, "active": background.isActive]

	// Settings' "Always show the menu bar icon": it is there beside the window, stays when the app comes back from the
	// background, and goes when it is turned off (but never while the app is in the background: it is the way back).
	main.open()
	background.showAlways(true)
	let beside = status.isInstalled
	background.enter { main.close() }
	background.leave()
	main.open()
	let afterLeave = status.isInstalled
	background.enter { main.close() }
	background.showAlways(false)
	let offInBackground = status.isInstalled
	background.leave()
	main.close()
	out["always"] = ["beside": beside, "afterLeave": afterLeave, "offInBackground": offInBackground, "end": status.isInstalled]
	return out
}

/// A value for the report: JSON has no optional.
func orNull(_ value: Any?) -> Any { value ?? NSNull() }

/// A page's memory for the report: its drafts and its view, or "nil" for an answer that is none.
func memo(_ memory: PageMemory?) -> Any {
	guard let memory else { return "nil" }
	return [orNull(memory.drafts), orNull(memory.hash)]
}

// MARK: memory

/// Loads `url` in the window's page and waits for it.
func load(_ main: MainWindow, _ url: URL) {
	let loaded = Loaded()
	main.webView?.navigationDelegate = loaded
	main.webView?.load(URLRequest(url: url))
	spin(10) { loaded.done }
}

/// What a script says in the window's page.
func eval(_ main: MainWindow, _ code: String) -> Any? {
	var answered = false
	var answer: Any?
	main.webView?.evaluateJavaScript(code) { result, _ in
		answer = result
		answered = true
	}
	spin(10) { answered }
	return answer
}

/// A window that is closed and made again keeps the page's unsent drafts and the view it was on (`MainWindow.remember`), with a
/// real page on a real origin (`url`: sessionStorage needs one) and the scripts of the page as the app sets them up.
func memoryReport(_ url: URL) -> [String: Any] {
	_ = NSApplication.shared
	NSApp.setActivationPolicy(.accessory)
	let main = MainWindow(make: parts)
	var out: [String: Any] = [:]
	// What the page's own code wrote: quotes, a line break, a character outside ASCII, a closing script tag.
	let drafts = #"{"conv":{"text":"typed \"quoted\" 日本語\nline two </script>","images":[]}}"#
	let view = URL(string: url.absoluteString + "#/s/%2Ftmp%2Fa%20b.jsonl")!

	autoreleasepool { main.open() }
	load(main, view)
	_ = eval(main, "sessionStorage.setItem('ompw.drafts', \(String(data: try! JSONSerialization.data(withJSONObject: [drafts]), encoding: .utf8)!)[0])")
	var remembered = false
	main.remember(timeout: 10) { remembered = true }
	spin(10) { remembered }
	out["remembered"] = remembered
	autoreleasepool { main.close() }
	out["hash"] = orNull(main.takeHash())
	out["hashAgain"] = orNull(main.takeHash())

	// A new window: the drafts are in its session storage before the page runs.
	autoreleasepool { main.open() }
	load(main, url)
	out["restored"] = (eval(main, "sessionStorage.getItem('ompw.drafts')") as? String == drafts)
	// The page writes its own and reloads: what it wrote is not put over by what was kept.
	_ = eval(main, "sessionStorage.setItem('ompw.drafts', 'mine')")
	load(main, url)
	out["notOver"] = orNull(eval(main, "sessionStorage.getItem('ompw.drafts')"))
	// The page sent what it held (it removed its key) and the page loads again (⌘R, a crashed web content process): what was
	// sent is not put back, because the script restores once for its web view.
	_ = eval(main, "sessionStorage.removeItem('ompw.drafts')")
	load(main, url)
	out["sentStaysSent"] = orNull(eval(main, "sessionStorage.getItem('ompw.drafts')"))
	load(main, url)
	out["sentStaysSentAgain"] = orNull(eval(main, "sessionStorage.getItem('ompw.drafts')"))

	// Kept for one window: a window made after that one, with nothing remembered in between, is given nothing.
	autoreleasepool { main.close() }
	autoreleasepool { main.open() }
	load(main, url)
	out["once"] = orNull(eval(main, "sessionStorage.getItem('ompw.drafts')"))

	// A window with no page: the answer comes at once, and nothing is kept of it.
	autoreleasepool { main.close() }
	var noPage = false
	main.remember(timeout: 10) { noPage = true }
	out["noPage"] = noPage
	// A page with nothing to keep (no drafts, a plain address) leaves nothing.
	autoreleasepool { main.open() }
	load(main, url)
	var empty = false
	main.remember(timeout: 10) { empty = true }
	spin(10) { empty }
	autoreleasepool { main.close() }
	out["emptyHash"] = orNull(main.takeHash())
	autoreleasepool { main.open() }
	load(main, url)
	out["emptyDrafts"] = orNull(eval(main, "sessionStorage.getItem('ompw.drafts')"))
	autoreleasepool { main.close() }

	// The menu bar icon's "N questions waiting" (#705): a window that is closed has the view for its next page, and a page that is
	// up goes there at once.
	main.route(to: "#/questions")
	out["routedClosed"] = orNull(main.takeHash())
	out["routedClosedAgain"] = orNull(main.takeHash())
	autoreleasepool { main.open() }
	load(main, url)
	main.route(to: "#/questions")
	out["routedOpen"] = orNull(eval(main, "location.hash"))
	autoreleasepool { main.close() }

	// What a page can answer is looked at before it is trusted.
	let long = "#" + String(repeating: "a", count: longestHash)
	out["parsed"] = [
		memo(parsePageMemory(##"{"drafts":"d","hash":"#/s/x"}"##)),
		memo(parsePageMemory(##"{"drafts":null,"hash":""}"##)),
		memo(parsePageMemory(##"{"drafts":"","hash":"#"}"##)),
		memo(parsePageMemory(##"{"drafts":null,"hash":"https://evil.example/"}"##)),
		memo(parsePageMemory(##"{"drafts":null,"hash":"#a b"}"##)),
		memo(parsePageMemory(##"{"drafts":null,"hash":"#a\nb"}"##)),
		memo(parsePageMemory("{\"drafts\":null,\"hash\":\"\(long)\"}")),
		memo(parsePageMemory("not json")),
		memo(parsePageMemory(nil)),
	]
	let base = URL(string: "http://127.0.0.1:7878/?token=t")!
	out["urls"] = [pageURL(base, hash: "#/s/x").absoluteString, pageURL(base, hash: nil).absoluteString]
	return out
}

let variant = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "model"
switch variant {
case "window": print(json(windowReport()))
case "mode": print(json(modeReport()))
case "memory": print(json(memoryReport(URL(string: CommandLine.arguments[2])!)))
default: print(json(model()))
}
exit(0)
