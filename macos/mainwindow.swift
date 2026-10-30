import AppKit
import WebKit

// MARK: - What a page holds that must outlive its window

/// What the page of the window holds that the server does not: the unsent drafts (the page mirrors them to its session storage,
/// which dies with the page: `web/src/lib/drafts.ts`) and the view it is on (`location.hash`: the conversation, a pop-out's
/// agent). Run in Background closes the window, so the app keeps them for the page that opens in its place.
struct PageMemory: Equatable {
	var drafts: String?
	var hash: String?
}

/// The longest drafts (with the pictures pasted into them, in base64) and the longest address that are kept.
let longestDrafts = 32 << 20
let longestHash = 4096

/// What the page is asked, as one script: its drafts as the page wrote them, and where it is.
let pageMemoryScript = "JSON.stringify({ drafts: sessionStorage.getItem('ompw.drafts'), hash: location.hash })"

/// The memory in a page's answer to `pageMemoryScript`, or nil for any other answer. An address that is not an in-page
/// address (`#…`, no control characters, not too long) is not kept: it is appended to the app's own URL.
func parsePageMemory(_ result: Any?) -> PageMemory? {
	guard let text = result as? String, let data = text.data(using: .utf8),
		let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
	else { return nil }
	let drafts = (json["drafts"] as? String).flatMap { $0.utf8.count <= longestDrafts && !$0.isEmpty ? $0 : nil }
	let hash = (json["hash"] as? String).flatMap { hash -> String? in
		guard hash.hasPrefix("#"), hash.count > 1, hash.utf8.count <= longestHash,
			!hash.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f || $0 == " " })
		else { return nil }
		return hash
	}
	return PageMemory(drafts: drafts, hash: hash)
}

/// Puts the drafts back in the new page's session storage before any script of the page runs, once for this web view: the
/// script stays in the web view's configuration and runs on every load of its main frame, and a page that has sent what it
/// held has removed its key (`flushDrafts`), so a reload (⌘R, a crashed web content process, the reload after a server restart)
/// must not put a message that was sent back in the composer. A new web view starts with empty session storage, so the next
/// window restores normally. Nothing is written where the page has written its own by then.
func restoreDraftsScript(_ drafts: String) -> WKUserScript {
	// The text goes in as the JSON of an array: a string with quotes, line breaks and any character is a valid literal there.
	let literal = String(data: try! JSONSerialization.data(withJSONObject: [drafts]), encoding: .utf8)!
	return WKUserScript(
		source: "try { if (sessionStorage.getItem('ompw.draftsRestored') === null) { sessionStorage.setItem('ompw.draftsRestored', '1'); if (sessionStorage.getItem('ompw.drafts') === null) sessionStorage.setItem('ompw.drafts', \(literal)[0]); } } catch (e) {}",
		injectionTime: .atDocumentStart, forMainFrameOnly: true)
}

/// The address of the page with the view it was on: the app's own URL with `hash` as its fragment (the server's redirect to
/// the page keeps a fragment, as any redirect does).
func pageURL(_ base: URL, hash: String?) -> URL {
	guard let hash, let url = URL(string: base.absoluteString + hash) else { return base }
	return url
}

// MARK: - The window

/// The app's one window and the page in it (#627): made when the app has to show one, and gone while the app runs in the
/// background. Closing it releases its web view too, so no window object, no WebKit page and no web content process is left
/// while nobody can see the app. The page's own state goes with it, except what `remember` keeps for the next one: its
/// drafts and the view it is on.
///
/// What a window is made of (the page's script handlers, its delegates, its colour) is the app's to say: `make` builds both and
/// does not show them, with the drafts to put back (see `restoreDraftsScript`); whoever opens it orders it in.
final class MainWindow {
	typealias Parts = (window: NSWindow, web: WKWebView)

	private let make: (_ drafts: String?) -> Parts
	private(set) var window: NSWindow?
	private(set) var webView: WKWebView?
	/// What the last page held (`remember`): the drafts go into the next page, the view is taken by whoever loads it.
	private var drafts: String?
	private var hash: String?

	init(make: @escaping (_ drafts: String?) -> Parts) { self.make = make }

	var isOpen: Bool { window != nil }

	/// The window and its page, made if there are none. True when they were made now.
	@discardableResult
	func open() -> Bool {
		guard window == nil else { return false }
		let parts = make(drafts)
		drafts = nil
		// The window is let go by this object, not by `close()`: AppKit releasing it as well would free it twice.
		parts.window.isReleasedWhenClosed = false
		window = parts.window
		webView = parts.web
		return true
	}

	/// The view the last page was on, once: what the next load of the page is given (`pageURL`), so that it is not given again
	/// to a load that comes after (the server started again).
	func takeHash() -> String? {
		defer { hash = nil }
		return hash
	}

	/// The page goes to the view at `hash` (`#/questions`: a constant of the app's own, never a page's words): a page that is up
	/// is moved there now, and a window that is closed has it as the view its next page opens on (`takeHash`). Say it before
	/// `open()` when the window is closed.
	func route(to hash: String) {
		if let webView {
			webView.evaluateJavaScript("location.hash = '\(hash)'", completionHandler: nil)
		} else {
			self.hash = hash
		}
	}

	/// Ask the page for its drafts and its view, and keep them for the next one; `done` runs once, on the main queue, when it
	/// answered or after `timeout` (a page that does not answer must not hold the app up). Nothing is kept from a page that
	/// answers nothing.
	func remember(timeout: TimeInterval, done: @escaping () -> Void) {
		guard let webView else { return done() }
		var finished = false
		let finish = {
			guard !finished else { return }
			finished = true
			done()
		}
		webView.evaluateJavaScript(pageMemoryScript) { [weak self] result, _ in
			if !finished, let memory = parsePageMemory(result) {
				self?.drafts = memory.drafts
				self?.hash = memory.hash
			}
			finish()
		}
		DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: finish)
	}

	/// The window is closed and both it and its page released: what was open on it (a save panel, a script's alert) is answered
	/// with a no, the page stops loading, and nothing of the app holds either any more.
	func close() {
		guard let window else { return }
		for sheet in window.sheets { window.endSheet(sheet, returnCode: .cancel) }
		webView?.stopLoading()
		window.delegate = nil
		window.contentView = nil
		window.close()
		webView = nil
		self.window = nil
	}
}
