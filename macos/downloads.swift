import Foundation
import WebKit

/// Saves what the page downloads (an exported conversation) where the user chooses, and says how it went.
///
/// WebKit refuses to write over a file that is already there and fails the download with `NSURLErrorCancelled`,
/// which says nothing: the old file stayed and the user was told nothing. So a file the user agreed to replace is
/// moved aside before the download starts, deleted once it has been saved, and put back if it fails.
final class DownloadSaver: NSObject, WKDownloadDelegate {
	/// Ask where to save `suggestedFilename`; nil when the user declines. Called on the main thread.
	typealias Choose = (_ suggestedFilename: String, _ done: @escaping (URL?) -> Void) -> Void

	private struct Saving {
		let url: URL
		/// Where the file that was at `url` waits until the download is known to have worked.
		let previous: URL?
	}

	private let choose: Choose
	private let saved: (URL) -> Void
	private let failed: (_ title: String, _ detail: String) -> Void
	private var saving: [ObjectIdentifier: Saving] = [:]

	init(choose: @escaping Choose, saved: @escaping (URL) -> Void, failed: @escaping (_ title: String, _ detail: String) -> Void) {
		self.choose = choose
		self.saved = saved
		self.failed = failed
	}

	func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
		choose(suggestedFilename) { [weak self] url in
			guard let self, let url else { return completionHandler(nil) }
			let fileManager = FileManager.default
			var previous: URL?
			if fileManager.fileExists(atPath: url.path) {
				let aside = url.deletingLastPathComponent()
					.appendingPathComponent(".\(url.lastPathComponent).replaced-\(UUID().uuidString)")
				do {
					try fileManager.moveItem(at: url, to: aside)
					previous = aside
				} catch {
					self.failed("Could not replace “\(url.lastPathComponent)”", error.localizedDescription)
					return completionHandler(nil)
				}
			}
			self.saving[ObjectIdentifier(download)] = Saving(url: url, previous: previous)
			completionHandler(url)
		}
	}

	func downloadDidFinish(_ download: WKDownload) {
		guard let saving = saving.removeValue(forKey: ObjectIdentifier(download)) else { return }
		if let previous = saving.previous { try? FileManager.default.removeItem(at: previous) }
		saved(saving.url)
	}

	func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
		guard let saving = saving.removeValue(forKey: ObjectIdentifier(download)) else {
			// No destination yet: the user closed the save sheet, which cancels the download. Anything else is news.
			let cancelled = (error as NSError).domain == NSURLErrorDomain && (error as NSError).code == NSURLErrorCancelled
			if !cancelled { failed("The download failed", error.localizedDescription) }
			return
		}
		let fileManager = FileManager.default
		// What WebKit began writing is not a file worth keeping; the one that was there before is.
		try? fileManager.removeItem(at: saving.url)
		if let previous = saving.previous { try? fileManager.moveItem(at: previous, to: saving.url) }
		failed("Could not save “\(saving.url.lastPathComponent)”", error.localizedDescription)
	}
}
