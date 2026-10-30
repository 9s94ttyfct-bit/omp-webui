import Foundation

/// The server, as a child process the app keeps running: it is started, started again when it dies on its own, and
/// stopped when the app quits.
///
/// - A server that stops while the app did not ask it to (a crash, a kill, an exit) is started again with the same
///   launch: the same data dir and token, the same preferred port (`OMP_WEBUI_AUTO_PORT` finds the next free one while
///   the occupant stays), and what a former server left paused is paused again (#373). Only a server that keeps
///   stopping, `maxRestarts + 1` times within `window`, ends the restarts: that is `.failed`, with what it printed last.
/// - What the server prints is read on its own queue and handed over, with everything else the supervisor knows (the
///   current process, its output, the times it stopped, whether a stop was asked for), to one serial queue: nothing is
///   read on one queue and written on another (#374). A stopped server's last words — the error and stack it died with —
///   are reported only once the pipe has been read to its end, or `drainWait` has passed with a holder that keeps it open.
/// - `stop` answers when the process is gone, and never blocks the caller: SIGTERM lets the server close its omp
///   processes, SIGKILL follows after `deadline` (#375).
///
/// `handler` is called on `events` (the main queue in the app).
final class ServerSupervisor {
	struct Launch {
		var executable: URL
		var arguments: [String] = []
		var environment: [String: String]
		var directory: URL
	}

	enum Event {
		/// The server printed its ready line and listens on `port`: once per start, so again after every restart.
		case ready(port: Int)
		/// The server stopped and will not be started again (or could not be started at all).
		case failed(title: String, detail: String)
	}

	/// One process, from its start to the last of its output. Confined to the supervisor's queue.
	private final class Run {
		let process = Process()
		let pipe = Pipe()
		/// The tail of what the server printed: the ready line at startup, then only what a crash report shows. The
		/// server runs for days; everything it prints must not pile up in this process.
		var output = ""
		var announced = false
		var ended = false
		var drained = false
		var finished = false
		var status: Int32 = 0
		var signaled = false
	}

	private let launch: Launch
	private let maxRestarts: Int
	private let window: TimeInterval
	private let restartDelay: TimeInterval
	private let drainWait: TimeInterval
	private let events: DispatchQueue
	private let handler: (Event) -> Void
	private let queue = DispatchQueue(label: "omp-webui.server")

	// Confined to `queue`.
	private var run: Run?
	private var stopping = false
	private var stopWaiters: [() -> Void] = []
	/// When the server stopped on its own, as `systemUptime` (it does not move with the clock), within `window`.
	private var stops: [TimeInterval] = []

	init(
		launch: Launch, maxRestarts: Int = 3, within window: TimeInterval = 60, restartDelay: TimeInterval = 0.5,
		drainWait: TimeInterval = 0.5, events: DispatchQueue = .main, handler: @escaping (Event) -> Void
	) {
		self.launch = launch
		self.maxRestarts = maxRestarts
		self.window = window
		self.restartDelay = restartDelay
		self.drainWait = drainWait
		self.events = events
		self.handler = handler
	}

	func start() {
		queue.async { self.spawn() }
	}

	/// Stop the server and call `done` (on `events`) once its process is gone; also when there is none. A server that
	/// has not exited `deadline` seconds after SIGTERM is killed. No later start follows.
	func stop(deadline: TimeInterval = 5, done: @escaping () -> Void) {
		queue.async {
			self.stopping = true
			guard let run = self.run, !run.ended, run.process.isRunning else { return self.events.async(execute: done) }
			self.stopWaiters.append(done)
			run.process.terminate()
			self.queue.asyncAfter(deadline: .now() + deadline) {
				if !run.ended && run.process.isRunning { kill(run.process.processIdentifier, SIGKILL) }
			}
			// A process that does not die even of SIGKILL must not keep the app from quitting.
			self.queue.asyncAfter(deadline: .now() + deadline + 1) { self.releaseStopWaiters() }
		}
	}

	private func spawn() {
		guard !stopping else { return }
		let run = Run()
		let p = run.process
		p.executableURL = launch.executable
		p.arguments = launch.arguments
		p.currentDirectoryURL = launch.directory
		p.environment = launch.environment
		p.standardOutput = run.pipe
		p.standardError = run.pipe
		p.terminationHandler = { [weak self] proc in
			let status = proc.terminationStatus, signaled = proc.terminationReason == .uncaughtSignal
			self?.queue.async { self?.exited(run, status: status, signaled: signaled) }
		}
		followOutput(
			of: run.pipe.fileHandleForReading,
			{ [weak self] text in self?.queue.async { self?.received(run, text) } },
			atEnd: { [weak self] in self?.queue.async { self?.drained(run) } })
		do {
			try p.run()
			self.run = run
		} catch {
			run.pipe.fileHandleForReading.readabilityHandler = nil
			emit(.failed(title: "Could not start the omp-webui server", detail: error.localizedDescription))
		}
	}

	private func received(_ run: Run, _ text: String) {
		guard !run.finished else { return }
		run.output += text
		if run.output.utf8.count > 16_000 { run.output = String(run.output.suffix(8_000)) }
		guard !run.announced, let port = ServerSupervisor.readyPort(in: run.output) else { return }
		run.announced = true
		emit(.ready(port: port))
	}

	/// The port in the server's `OMPW_READY {"port":N}` line, once the whole line is there.
	private static func readyPort(in output: String) -> Int? {
		guard let line = output.split(separator: "\n").first(where: { $0.hasPrefix("OMPW_READY ") }),
			let json = line.dropFirst("OMPW_READY ".count).data(using: .utf8),
			let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any]
		else { return nil }
		return obj["port"] as? Int
	}

	private func drained(_ run: Run) {
		run.drained = true
		if run.ended { finish(run) }
	}

	private func exited(_ run: Run, status: Int32, signaled: Bool) {
		run.ended = true
		run.status = status
		run.signaled = signaled
		run.process.terminationHandler = nil  // it holds `run`, which holds the process
		if self.run === run { releaseStopWaiters() }
		if run.drained {
			finish(run)
		} else {
			// What the server printed last is still on its way through the pipe reader. Its end says all has been read,
			// but a process that outlived the server (a relay) may hold the pipe for ever.
			queue.asyncAfter(deadline: .now() + drainWait) { self.finish(run) }
		}
	}

	/// The process is gone and its output is as complete as it will be.
	private func finish(_ run: Run) {
		guard !run.finished else { return }
		run.finished = true
		if self.run === run { self.run = nil }
		let log = String(run.output.suffix(4000))
		run.output = ""
		guard !stopping else { return }
		let now = ProcessInfo.processInfo.systemUptime
		stops = stops.filter { now - $0 < window } + [now]
		let how = run.signaled ? "Killed by signal \(run.status)." : "Exit code \(run.status)."
		if stops.count > maxRestarts {
			emit(.failed(title: "The omp-webui server stopped", detail: "\(how)\n\n\(log)"))
		} else {
			NSLog("omp-webui: the server stopped (\(how)) and is started again")
			queue.asyncAfter(deadline: .now() + restartDelay) { self.spawn() }
		}
	}

	private func releaseStopWaiters() {
		let waiting = stopWaiters
		stopWaiters = []
		for done in waiting { events.async(execute: done) }
	}

	private func emit(_ event: Event) {
		events.async { self.handler(event) }
	}
}
