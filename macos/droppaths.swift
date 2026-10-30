// Where the files dropped on the window are. A page can never know: a dropped `File` has a name, a size and its bytes,
// and no path (WebKit hides it, as every browser does), so the page could only send a copy to the server. The app can do
// better, because it is the window the drag arrives at: `DropWebView` reads the file URLs off the drag's pasteboard just
// before WebKit takes the drop, and the page asks for them over a script message handler (see web/src/lib/shell-drop.ts,
// which has the protocol and matches them to the `File`s it was given). A page that gets nothing, because the drag
// carried no files or the handler is not there (any browser), sends the files to the server instead.
import AppKit
import WebKit

/// One file or folder the Finder put in a drag.
struct DroppedItem: Equatable {
	var name: String
	/// Where it is on this Mac.
	var path: String
	var directory: Bool
	/// Bytes of a file; 0 for a folder.
	var size: Int
}

/// The most items handed to the page for one drop: more is a folder's worth of files, and the page takes twenty.
let maxDroppedItems = 200

/// How long a drop is kept for the page to ask for: it asks as it handles the drop, a moment after the drop itself.
let dropKeepSeconds: TimeInterval = 15

/// What the page is told of the items: one entry each, in the order of the drag.
func dropAnswer(_ items: [DroppedItem]) -> [String: Any] {
	[
		"items": items.map { ["name": $0.name, "path": $0.path, "directory": $0.directory, "size": $0.size] as [String: Any] }
	]
}

/// The items the file URLs are: their path and what they are; what is not on disk any more is left out.
func droppedItems(_ urls: [URL]) -> [DroppedItem] {
	var items: [DroppedItem] = []
	for url in urls {
		// A file URL as the drag gives it may be a reference (`file:///.file/id=…`): the path is what the page and omp need.
		let file = (url as NSURL).filePathURL ?? url
		guard file.isFileURL,
			let values = try? file.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey]),
			FileManager.default.fileExists(atPath: file.path)
		else { continue }
		let directory = values.isDirectory ?? false
		items.append(
			DroppedItem(
				name: file.lastPathComponent, path: file.path, directory: directory, size: directory ? 0 : (values.fileSize ?? 0)))
		if items.count == maxDroppedItems { break }
	}
	return items
}

/// The file URLs a pasteboard holds, in order.
func droppedItems(from pasteboard: NSPasteboard) -> [DroppedItem] {
	let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
	return droppedItems(urls ?? [])
}

/// Whether a page's message is the one request the bridge answers.
func isDropRequest(_ body: Any) -> Bool {
	guard let message = body as? [String: Any] else { return false }
	return message["type"] as? String == "paths"
}

final class DropPaths: NSObject, WKScriptMessageHandlerWithReply {
	static let handlerName = "ompwDrop"

	private let origin: () -> URL?
	private let now: () -> Date
	/// What the last drop carried, until the page has asked for it or it is too old to be that drop's.
	private var kept: (items: [DroppedItem], at: Date)?

	init(origin: @escaping () -> URL?, now: @escaping () -> Date = Date.init) {
		self.origin = origin
		self.now = now
	}

	/// A drag is about to be dropped on the window: what it holds is kept for the page. A drag with no files (text, a link)
	/// replaces what was kept, so the page is never given the files of an earlier drop for this one.
	func capture(from pasteboard: NSPasteboard) {
		let items = droppedItems(from: pasteboard)
		kept = items.isEmpty ? nil : (items, now())
	}

	/// The items of the last drop, once: nothing when it was handed over already, or is older than `dropKeepSeconds`.
	func take() -> [DroppedItem] {
		defer { kept = nil }
		guard let kept, now().timeIntervalSince(kept.at) <= dropKeepSeconds else { return [] }
		return kept.items
	}

	func userContentController(
		_ controller: WKUserContentController, didReceive message: WKScriptMessage,
		replyHandler: @escaping (Any?, String?) -> Void
	) {
		let sender = message.frameInfo.securityOrigin
		guard message.frameInfo.isMainFrame, isOwnPage(scheme: sender.protocol, host: sender.host, port: sender.port, origin: origin())
		else { return replyHandler(nil, "Not available to this page.") }
		guard isDropRequest(message.body) else { return replyHandler(nil, "Unknown request.") }
		replyHandler(dropAnswer(take()), nil)
	}
}

/// The window's web view, told of what is dropped on it before WebKit handles the drop. Everything else about a drop
/// (the page's `drop` event, its files) is WebKit's own and goes on as before: `super` is always called.
final class DropWebView: WKWebView {
	var drops: DropPaths?

	override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
		drops?.capture(from: sender.draggingPasteboard)
		return super.performDragOperation(sender)
	}
}
