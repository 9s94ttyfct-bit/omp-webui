import Foundation

/// The server asks the app to quit for an update (#571): it has downloaded and checked the new app, staged it next to this
/// one and started the helper that swaps them once this app has quit, and says so with SIGUSR1.
///
/// Only an update that is really handed over quits the app: the server writes `<data dir>/update/handover.json` before it
/// signals, and a signal without that file is ignored (any process of the user may send one; the file is what says the
/// server did). SIGUSR1's own action would end the app, so it is ignored for good from `start` on and read as a request.
final class UpdateQuit {
	private let handover: URL
	private let quit: () -> Void
	private var source: DispatchSourceSignal?

	/// `quit` is called on the main thread, once for each request that is for an update.
	init(dataDir: URL, quit: @escaping () -> Void) {
		self.handover = dataDir.appendingPathComponent("update").appendingPathComponent("handover.json")
		self.quit = quit
	}

	func start(queue: DispatchQueue = .main) {
		signal(SIGUSR1, SIG_IGN)
		let source = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: queue)
		source.setEventHandler { [weak self] in self?.requested() }
		source.resume()
		self.source = source
	}

	private func requested() {
		guard FileManager.default.fileExists(atPath: handover.path) else { return }
		// Not from here: this handler runs inside a block the main queue is draining, and `NSApp.terminate` waits for the
		// server to stop (`.terminateLater`) in a loop of its own — which cannot run the blocks that answer it while the one
		// it was called from is still running. The app then never quit (found by the first real update). A run-loop source
		// is no block of the main queue: it is run by the loop itself, which is then free to run the queue.
		RunLoop.main.perform(inModes: [.common]) { [quit] in quit() }
	}
}
