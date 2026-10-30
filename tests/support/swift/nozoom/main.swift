import AppKit
import WebKit

// The harness of tests/unit/macos-no-zoom.test.ts: whether the page in the app's web views can be zoomed. Prints one JSON object.
//
//   harness menu       every key of the app's menu bar (`appMainMenu`, macos/appmenu.swift); no window server needed
//   harness gestures   a pinch and a smart zoom (a two-finger double tap) on a web view set up by `prepareWebView`
//                      (macos/webview.swift), and on the control: a web view that allows magnification, as the app's did
//   harness keys       ⌘= ⌘- ⌘0 typed into a text field of a page in a web view set up by `prepareWebView`
//
// The web views are in windows that are never shown: the events are handed to the web view as AppKit would hand them, so
// nothing appears on the screen and nothing takes the keyboard. A trackpad's gestures are built as the window server
// sends them (a gesture event of the zoom or the smart zoom kind), the keys with `NSEvent.keyEvent`. Each web view has a
// private, non-persistent data store.

func spin(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

/// A trackpad gesture as the window server sends it: `hid` 8 is a pinch (NSEvent `.magnify`), 22 a smart zoom (`.smartMagnify`).
func gesture(hid: Int64, amount: Double = 0, phase: Int64 = 0, at point: CGPoint = .zero) -> NSEvent? {
	guard let cg = CGEvent(source: nil), let type = CGEventType(rawValue: 29) else { return nil }
	cg.type = type
	cg.setIntegerValueField(CGEventField(rawValue: 110)!, value: hid)
	cg.setDoubleValueField(CGEventField(rawValue: 113)!, value: amount)
	cg.setIntegerValueField(CGEventField(rawValue: 132)!, value: phase)
	cg.location = point
	return NSEvent(cgEvent: cg)
}

/// A web view in a window that is never shown, with `html` loaded.
func loadedWebView(_ html: String, prepare: (WKWebView) -> Void) -> (WKWebView, NSWindow) {
	let config = WKWebViewConfiguration()
	config.websiteDataStore = .nonPersistent()
	let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 600, height: 400), configuration: config)
	prepare(web)
	let window = NSWindow(
		contentRect: NSRect(x: 0, y: 0, width: 600, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
	window.isReleasedWhenClosed = false
	window.contentView = web
	var loaded = false
	let watch = web.observe(\.isLoading, options: [.new]) { web, _ in if !web.isLoading { loaded = true } }
	web.loadHTMLString(html, baseURL: nil)
	let deadline = Date().addingTimeInterval(20)
	while !loaded && Date() < deadline { spin(0.05) }
	watch.invalidate()
	spin(0.5)
	return (web, window)
}

/// What the page says, as JSON text.
func evaluate(_ web: WKWebView, _ script: String) -> String {
	var result: String?
	web.evaluateJavaScript(script) { value, error in result = (value as? String) ?? "error: \(String(describing: error))" }
	let deadline = Date().addingTimeInterval(10)
	while result == nil && Date() < deadline { spin(0.05) }
	return result ?? "timeout"
}

/// How far a pinch and then a smart zoom magnify `web` (1: not at all).
func zoomByGestures(_ web: WKWebView) -> [String: Any] {
	for (amount, phase) in [(0.0, 1), (0.3, 2), (0.3, 2), (0.0, 4)] as [(Double, Int64)] {
		if let event = gesture(hid: 8, amount: amount, phase: phase) { web.magnify(with: event) }
		spin(0.2)
	}
	spin(1)
	let pinch = web.magnification
	web.setMagnification(1, centeredAt: .zero)
	spin(0.3)
	// Over the narrow block of text, which a smart zoom fits to the view.
	if let event = gesture(hid: 22, at: CGPoint(x: 60, y: 30)) { web.smartMagnify(with: event) }
	spin(1.5)
	return ["pinch": pinch, "smartZoom": web.magnification, "pageZoom": web.pageZoom]
}

let page = """
	<!doctype html><body style="margin:10px"><div style="width:120px;font:12px -apple-system">A narrow block of text, which a
	smart zoom fits to the view.</div><input id="field"><script>
	window.keys = [];
	document.getElementById("field").addEventListener("keydown", (e) => keys.push((e.metaKey ? "meta+" : "") + e.key));
	document.getElementById("field").focus();
	</script></body>
	"""

_ = NSApplication.shared
NSApp.setActivationPolicy(.prohibited)
var report: [String: Any] = [:]
switch CommandLine.arguments.dropFirst().first ?? "" {
case "menu":
	let main = appMainMenu(appName: "omp-webui", reload: NSSelectorFromString("reload"), macs: nil)
	var keys: [[String: Any]] = []
	var menus: [String: [String]] = [:]
	for top in main.items {
		guard let menu = top.submenu else { continue }
		menus[menu.title] = menu.items.filter { !$0.isSeparatorItem }.map(\.title)
		for item in menu.items where !item.keyEquivalent.isEmpty {
			let mods = item.keyEquivalentModifierMask
			keys.append([
				"menu": menu.title, "title": item.title, "key": item.keyEquivalent, "command": mods.contains(.command),
				"shift": mods.contains(.shift), "option": mods.contains(.option), "control": mods.contains(.control),
			])
		}
	}
	report = ["menus": menus, "keys": keys]
case "gestures":
	let (app, appWindow) = loadedWebView(page, prepare: prepareWebView)
	let (control, controlWindow) = loadedWebView(page) { $0.allowsMagnification = true }
	report = [
		"app": zoomByGestures(app).merging(["allowsMagnification": app.allowsMagnification]) { $1 },
		"control": zoomByGestures(control),
	]
	appWindow.close()
	controlWindow.close()
case "keys":
	let (web, window) = loadedWebView(page, prepare: prepareWebView)
	let before = evaluate(web, "JSON.stringify({ width: innerWidth, dpr: devicePixelRatio, scale: visualViewport.scale })")
	window.makeFirstResponder(web)
	for (key, code) in [("=", 24), ("-", 27), ("0", 29)] as [(String, UInt16)] {
		for type in [NSEvent.EventType.keyDown, .keyUp] {
			guard let event = NSEvent.keyEvent(
				with: type, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime,
				windowNumber: window.windowNumber, context: nil, characters: key, charactersIgnoringModifiers: key,
				isARepeat: false, keyCode: code)
			else { continue }
			// A key with ⌘ goes to the menu bar first, then down the window to the web view (`performKeyEquivalent`).
			if type == .keyDown { _ = web.performKeyEquivalent(with: event) } else { web.keyUp(with: event) }
			spin(0.2)
		}
	}
	spin(0.5)
	report = [
		"before": before,
		"after": evaluate(web, "JSON.stringify({ width: innerWidth, dpr: devicePixelRatio, scale: visualViewport.scale })"),
		"keys": evaluate(web, "JSON.stringify(keys)"),
		"pageZoom": web.pageZoom,
		"magnification": web.magnification,
	]
	window.close()
default:
	FileHandle.standardError.write("usage: harness menu|gestures|keys\n".data(using: .utf8)!)
	exit(2)
}
let data = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
