import AppKit
import WebKit

// Harness for scripts/app-shots.ts: photographs the app's page without the app and without a screen.
//
//   harness shoot <job.json>                 one WKWebView per shot, `takeSnapshot` into <out>/<name>.png
//   harness compare <a.png> <b.png> <out.png> <label a> <label b>
//                                            a side-by-side picture, and how many pixels differ (one JSON line)
//
// What a shot is photographed in is what macos/main.swift builds the window's page from: a WKWebView whose page finds the
// same script message handlers (notifications, dropped files, pop-out windows: the classes compiled in from macos/) and
// is loaded through the server's token link, so the page runs in the shell's own mode (`inShell()`), not as a browser tab.
// What it does not have is a window on a screen: the web view is only sized, never shown, and `takeSnapshot` renders it
// in WebKit's own process, so a locked screen, another Space or Stage Manager change nothing about the picture.
// Each shot gets a private, non-persistent data store: nothing is read from or written to the app's own WebKit storage,
// cookies or preferences (the harness is a bare executable and has no bundle identifier of its own to share them with).

struct Shot: Decodable {
	var name: String
	/// What follows the server's origin: "/" or "/#/settings".
	var path: String
	/// Run once the page is up (an async function body: it may `await`), e.g. open a panel.
	var prepare: String?
	/// A JavaScript expression polled until it is truthy before the picture is taken.
	var waitFor: String?
}

struct Job: Decodable {
	var base: String
	var token: String
	var out: String
	var width: Double
	var height: Double
	/// Pixels per point of the picture: 2 is a Retina screen.
	var scale: Double
	/// Style rules added to every page before its picture (what would only differ by release, such as the version line).
	var css: String?
	var shots: [Shot]
	/// Seconds a page may take to load, to show what a shot waits for, and to be photographed.
	var timeout: Double
	/// Milliseconds after the page is ready, for fonts, transitions and syntax highlighting to settle.
	var settle: Double
}

struct HarnessError: Error, CustomStringConvertible {
	var description: String
	init(_ text: String) { description = text }
}

/// A script message handler that takes everything and answers nothing: the shell's colour handler (`ompwTheme`) needs no more.
final class Ignoring: NSObject, WKScriptMessageHandler {
	func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {}
}

@MainActor final class Page: NSObject, WKNavigationDelegate {
	let web: WKWebView
	/// Held so that what the page asks of the shell is answered for as long as the page is up.
	private let notifications: NotificationBridge
	private let drops: DropPaths
	private let popOuts: PopOutWindows
	private let window: NSWindow
	private var loaded: CheckedContinuation<Void, Error>?

	init(base: URL, width: Double, height: Double) {
		let config = WKWebViewConfiguration()
		config.websiteDataStore = .nonPersistent()
		let origin = { Optional(base) }
		notifications = NotificationBridge(origin: origin, open: {})
		drops = DropPaths(origin: origin)
		popOuts = PopOutWindows(origin: origin)
		config.userContentController.add(Ignoring(), name: "ompwTheme")
		config.userContentController.add(popOuts, name: PopOutWindows.handlerName)
		config.userContentController.addScriptMessageHandler(
			notifications, contentWorld: .page, name: NotificationBridge.handlerName)
		config.userContentController.addScriptMessageHandler(drops, contentWorld: .page, name: DropPaths.handlerName)
		let view = DropWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
		view.drops = drops
		web = view
		// As the app has it: the page is not held back because nothing covers it or looks at it.
		if web.responds(to: NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")) {
			web.setValue(false, forKey: "windowOcclusionDetectionEnabled")
		}
		// A web view takes its size from a window; one that is never ordered in is not on any screen.
		window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.borderless], backing: .buffered,
			defer: false)
		window.isReleasedWhenClosed = false
		window.contentView = web
		super.init()
		notifications.webView = web
		web.navigationDelegate = self
	}

	func load(_ url: URL) async throws {
		try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
			loaded = c
			web.load(URLRequest(url: url))
		}
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.resume(); loaded = nil }
	func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loaded?.resume(throwing: error); loaded = nil }
	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		loaded?.resume(throwing: error)
		loaded = nil
	}
	func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
		loaded?.resume(throwing: HarnessError("the page's web process died"))
		loaded = nil
	}

	/// The expression's value, as JSON text (nil for undefined).
	func evaluate(_ source: String) async throws -> Any? {
		try await web.callAsyncJavaScript("return (\(source))", arguments: [:], in: nil, contentWorld: .page)
	}

	func run(_ body: String) async throws {
		_ = try await web.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: .page)
	}

	func wait(for expression: String, seconds: Double) async throws {
		let until = Date().addingTimeInterval(seconds)
		var last = "false"
		while Date() < until {
			do {
				if let v = try await evaluate(expression) {
					if let b = v as? Bool, b { return }
					if let n = v as? NSNumber, !(v is Bool), n != 0 { return }
					if let s = v as? String, !s.isEmpty { return }
					last = "\(v)"
				}
			} catch { last = "\(error)" }
			try await Task.sleep(nanoseconds: 100_000_000)
		}
		throw HarnessError("`\(expression)` was not true after \(seconds) s (last: \(last))")
	}

	/// The page as a PNG of exactly `scale` pixels per point: the snapshot's own pixel density is the screen's, and there may be none.
	func png(scale: Double) async throws -> Data {
		let snap = WKSnapshotConfiguration()
		snap.rect = NSRect(x: 0, y: 0, width: web.bounds.width, height: web.bounds.height)
		snap.snapshotWidth = NSNumber(value: web.bounds.width * scale)
		let image = try await web.takeSnapshot(configuration: snap)
		let w = Int(web.bounds.width * scale), h = Int(web.bounds.height * scale)
		guard
			let rep = NSBitmapImageRep(
				bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
				isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
			let context = NSGraphicsContext(bitmapImageRep: rep)
		else { throw HarnessError("no drawing context") }
		NSGraphicsContext.saveGraphicsState()
		NSGraphicsContext.current = context
		context.imageInterpolation = .high
		image.draw(in: NSRect(x: 0, y: 0, width: w, height: h), from: .zero, operation: .copy, fraction: 1)
		NSGraphicsContext.restoreGraphicsState()
		guard let data = rep.representation(using: .png, properties: [:]) else {
			throw HarnessError("the snapshot could not be encoded")
		}
		return data
	}
}

func line(_ object: [String: Any]) {
	let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
	print(String(decoding: data, as: UTF8.self))
	fflush(stdout)
}

@MainActor func shoot(_ job: Job) async -> Int32 {
	guard let base = URL(string: job.base) else { line(["error": "bad base URL"]); return 2 }
	var failed: Int32 = 0
	for shot in job.shots {
		let page = Page(base: base, width: job.width, height: job.height)
		do {
			// The token link stores the access cookie and redirects to the UI, as the app's first load does.
			let entry = URL(string: "\(job.base)/?token=\(job.token)")!
			try await withTimeout(job.timeout, "loading \(entry.host ?? "")") { try await page.load(entry) }
			if shot.path != "/" {
				let target = URL(string: job.base + shot.path)!
				// A hash change only is the page's own navigation and finishes without a load event.
				if shot.path.hasPrefix("/#") {
					try await page.run("location.hash = \(jsString(String(shot.path.dropFirst(1))))")
				} else {
					try await withTimeout(job.timeout, "loading \(shot.path)") { try await page.load(target) }
				}
			}
			if let css = job.css {
				try await page.run(
					"const s = document.createElement('style'); s.textContent = \(jsString(css)); document.head.appendChild(s)")
			}
			// `prepare` waits for what it needs itself; what the picture is about is waited for after it.
			if let prepare = shot.prepare { try await page.run(prepare) }
			if let wait = shot.waitFor { try await page.wait(for: wait, seconds: job.timeout) }
			try await page.run("await document.fonts.ready")
			try await Task.sleep(nanoseconds: UInt64(job.settle * 1_000_000))
			let data = try await page.png(scale: job.scale)
			let file = URL(fileURLWithPath: job.out).appendingPathComponent("\(shot.name).png")
			// Never over a picture that is there.
			try data.write(to: file, options: [.withoutOverwriting])
			line(["shot": shot.name, "bytes": data.count])
		} catch {
			failed = 1
			line(["shot": shot.name, "error": "\(error)"])
		}
	}
	return failed
}

func jsString(_ s: String) -> String {
	let data = try! JSONSerialization.data(withJSONObject: [s], options: [])
	let array = String(decoding: data, as: UTF8.self)
	return String(array.dropFirst().dropLast())
}

func withTimeout<T: Sendable>(_ seconds: Double, _ what: String, _ body: @escaping @MainActor () async throws -> T) async throws -> T {
	try await withThrowingTaskGroup(of: T.self) { group in
		group.addTask { try await body() }
		group.addTask {
			try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
			throw HarnessError("timed out after \(seconds) s \(what)")
		}
		defer { group.cancelAll() }
		return try await group.next()!
	}
}

// MARK: - compare

/// An 8-bit RGBA bitmap of the picture, and its size in pixels.
func pixels(_ path: String) throws -> (data: [UInt8], width: Int, height: Int) {
	guard let image = NSImage(contentsOfFile: path), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
	else { throw HarnessError("cannot read \(path)") }
	let w = cg.width, h = cg.height
	var data = [UInt8](repeating: 0, count: w * h * 4)
	let space = CGColorSpace(name: CGColorSpace.sRGB)!
	let ok = data.withUnsafeMutableBytes { raw -> Bool in
		guard let ctx = CGContext(
			data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
		else { return false }
		ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
		return true
	}
	if !ok { throw HarnessError("cannot decode \(path)") }
	return (data, w, h)
}

func compare(_ a: String, _ b: String, out: String, labels: (String, String)) throws {
	let left = try pixels(a), right = try pixels(b)
	guard left.width == right.width, left.height == right.height else {
		throw HarnessError("sizes differ: \(left.width)x\(left.height) against \(right.width)x\(right.height)")
	}
	var changed = 0
	for i in stride(from: 0, to: left.data.count, by: 4)
	where left.data[i] != right.data[i] || left.data[i + 1] != right.data[i + 1] || left.data[i + 2] != right.data[i + 2] {
		changed += 1
	}
	let total = left.width * left.height
	// before | after, each under its label, as the browser comparisons of the releases are laid out.
	let pad = 16, gap = 16, band = 56
	let w = pad * 2 + left.width * 2 + gap, h = pad * 2 + band + left.height
	let size = NSSize(width: w, height: h)
	let rep = NSBitmapImageRep(
		bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
		isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
	guard let gc = NSGraphicsContext(bitmapImageRep: rep) else { throw HarnessError("no drawing context") }
	NSGraphicsContext.saveGraphicsState()
	NSGraphicsContext.current = gc
	NSColor(srgbRed: 22 / 255, green: 22 / 255, blue: 24 / 255, alpha: 1).setFill()
	NSRect(origin: .zero, size: size).fill()
	func panel(_ path: String, _ label: String, x: Int, accent: NSColor) {
		let top = h - pad
		NSColor(srgbRed: 40 / 255, green: 40 / 255, blue: 44 / 255, alpha: 1).setFill()
		NSRect(x: x, y: top - band, width: left.width, height: band).fill()
		let font = NSFont.boldSystemFont(ofSize: 26)
		(label as NSString).draw(at: NSPoint(x: x + 16, y: top - band + 14), withAttributes: [.font: font, .foregroundColor: accent])
		NSImage(contentsOfFile: path)?.draw(
			in: NSRect(x: x, y: pad, width: left.width, height: left.height), from: .zero, operation: .copy, fraction: 1)
	}
	panel(a, labels.0, x: pad, accent: NSColor(srgbRed: 120 / 255, green: 170 / 255, blue: 1, alpha: 1))
	panel(b, labels.1, x: pad + left.width + gap, accent: NSColor(srgbRed: 120 / 255, green: 220 / 255, blue: 160 / 255, alpha: 1))
	NSGraphicsContext.restoreGraphicsState()
	guard let data = rep.representation(using: .png, properties: [:]) else { throw HarnessError("cannot encode") }
	try data.write(to: URL(fileURLWithPath: out), options: [.withoutOverwriting])
	line(["changed": changed, "total": total, "width": left.width, "height": left.height])
}

// MARK: - main

@main struct Harness {
	@MainActor static func main() async {
		let args = CommandLine.arguments
		guard args.count >= 3 else {
			FileHandle.standardError.write(
				Data("usage: harness shoot <job.json> | compare <a> <b> <out> <label a> <label b>\n".utf8))
			exit(2)
		}
		_ = NSApplication.shared
		NSApp.setActivationPolicy(.prohibited)
		switch args[1] {
		case "compare":
			guard args.count == 7 else { exit(2) }
			do { try compare(args[2], args[3], out: args[4], labels: (args[5], args[6])) } catch {
				line(["error": "\(error)"])
				exit(1)
			}
		case "shoot":
			let job: Job
			do { job = try JSONDecoder().decode(Job.self, from: Data(contentsOf: URL(fileURLWithPath: args[2]))) } catch {
				line(["error": "bad job: \(error)"])
				exit(2)
			}
			exit(await shoot(job))
		default:
			exit(2)
		}
	}
}
