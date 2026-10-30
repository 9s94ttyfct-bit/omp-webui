import Darwin
import Foundation

// Harness for macos/server.swift (and macos/serveroutput.swift): the server is a shell script, the supervisor is the one
// the app runs, and `events` is the main queue, as in the app. Prints one JSON object. See tests/unit/macos-server.test.ts.
//
//   harness last-line <runs>     a server prints 2 KB of error and a last line, then exits 1: does the failure report end with it?
//   harness last-line-control <runs>   the same with what the shell did before: the log is read on the exit callback's queue
//   harness last-line-race-control <runs>   that, with the shell's unsynchronised access to the text too: what ThreadSanitizer is shown
//   harness restarts             a server that is killed twice, then stays up: it is started again each time, with the same environment
//   harness gives-up             a server that always stops: started `maxRestarts + 1` times, then reported, then left alone
//   harness window               a server that stops, but never often enough: it is restarted for ever
//   harness stop-polite          stop while the main thread is watched: it answers when the server is gone, the main thread stays free
//   harness stop-stubborn        a server that ignores SIGTERM is killed at the deadline, the main thread stays free
//   harness stop-control         the blocking stop the shell had before: the main thread is not free
//   harness stop-while-restarting   a stop between a stop of the server and its restart: no restart follows

func shell(_ script: String) -> ServerSupervisor.Launch {
	ServerSupervisor.Launch(
		executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", script],
		environment: ["OMPW_TEST_TOKEN": "tok-123", "PATH": "/usr/bin:/bin"],
		directory: URL(fileURLWithPath: NSTemporaryDirectory()))
}

let scratch = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("ompw-supervisor-\(getpid())")
try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
func scratchFile(_ name: String) -> String { scratch.appendingPathComponent(name).path }
func lines(_ name: String) -> [String] {
	((try? String(contentsOfFile: scratchFile(name), encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
}

/// What the supervisor reports, in order, as text (`ready:<port>`, `failed:<title>|<detail>`), under a lock: the harness
/// thread reads it while the main queue appends.
final class Log {
	private let lock = NSLock()
	private var items: [String] = []
	func add(_ item: String) { lock.lock(); items.append(item); lock.unlock() }
	/// A copy in a buffer of its own: an array handed to another thread shares its buffer with the one the main queue
	/// appends to, and ThreadSanitizer cannot see the reference counts that make that safe.
	var all: [String] { lock.lock(); defer { lock.unlock() }; return items.map { $0 } }
	var count: Int { lock.lock(); defer { lock.unlock() }; return items.count }
	func wait(for count: Int, timeout: TimeInterval = 20) -> Bool {
		let end = Date().addingTimeInterval(timeout)
		while self.count < count && Date() < end { usleep(5_000) }
		return self.count >= count
	}
}

func supervise(_ launch: ServerSupervisor.Launch, maxRestarts: Int = 3, within: TimeInterval = 60, restartDelay: TimeInterval = 0.05, _ log: Log) -> ServerSupervisor {
	ServerSupervisor(launch: launch, maxRestarts: maxRestarts, within: within, restartDelay: restartDelay) { event in
		switch event {
		case .ready(let port): log.add("ready:\(port)")
		case .failed(let title, let detail): log.add("failed:\(title)|\(detail)")
		}
	}
}

/// `stop` from the harness thread: how long until `done`, and whether `done` ran on the main queue.
func stopped(_ supervisor: ServerSupervisor, deadline: TimeInterval = 5) -> (seconds: Double, onMain: Bool) {
	let done = DispatchSemaphore(value: 0)
	var onMain = false
	let began = Date()
	supervisor.stop(deadline: deadline) {
		onMain = Thread.isMainThread
		done.signal()
	}
	_ = done.wait(timeout: .now() + 30)
	return (Date().timeIntervalSince(began), onMain)
}

/// How long the main thread went without running a 10 ms timer, from `begin()` to `end()`: a main thread that is
/// blocked cannot repaint or be dragged, whatever else the app does.
final class MainWatch {
	private let lock = NSLock()
	private var last = Date()
	private var worst = 0.0
	private var timer: Timer?
	func begin() {
		DispatchQueue.main.sync {
			last = Date()
			timer = Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { _ in
				let now = Date()
				self.lock.lock()
				self.worst = max(self.worst, now.timeIntervalSince(self.last))
				self.last = now
				self.lock.unlock()
			}
		}
	}
	func end() -> Double {
		// The gap that is still open counts too: a main thread blocked until now has not run its timer yet.
		var open = 0.0
		DispatchQueue.main.sync { open = Date().timeIntervalSince(last); timer?.invalidate() }
		lock.lock(); defer { lock.unlock() }
		return max(worst, open)
	}
}

func alive(_ pid: pid_t) -> Bool { kill(pid, 0) == 0 }

/// A main thread that is busy most of the time (a page loading, a heavy render): 30 ms of work in every 40.
func keepMainBusy() {
	DispatchQueue.main.sync {
		_ = Timer.scheduledTimer(withTimeInterval: 0.04, repeats: true) { _ in
			let end = Date().addingTimeInterval(0.03)
			while Date() < end {}
		}
	}
}

func lastLine(_ runs: Int, control: Bool, busy: Bool, guarded: Bool = true) -> [String: Any] {
	if busy { keepMainBusy() }
	var missing = 0
	var wrongExit = 0
	for i in 0..<runs {
		let marker = "last-line-\(i)"
		// What a crashing server prints: the ready line, 2 KB of error and stack on standard error, then exit 1.
		let script = "echo 'OMPW_READY {\"port\":1}'; n=0; while [ $n -lt 40 ]; do echo \"error: frame $n ........................................\" >&2; n=$((n+1)); done; echo \(marker) >&2; exit 1"
		var report = ""
		if control {
			report = oldShellReport(script, guarded: guarded)
		} else {
			let log = Log()
			let supervisor = supervise(shell(script), maxRestarts: 0, log)
			supervisor.start()
			guard log.wait(for: 2) else { missing += 1; continue }
			report = log.all.last ?? ""
		}
		if !report.contains(marker) { missing += 1 }
		if !control && !report.contains("Exit code 1.") { wrongExit += 1 }
	}
	return ["runs": runs, "missing": missing, "wrongExit": wrongExit]
}

/// The shell before #374/#373, as it read a stopped server's output: chunks appended on the main queue, the log read at
/// once on the queue of the exit callback.
///
/// `guarded`: the text is kept under a lock. What the loss measurement needs is the order (the log is read before the main
/// queue has appended the last chunk), not the shell's unsynchronised access to a `String`: that access is a data race, and
/// a race on a `String` that is being appended to sometimes frees its buffer under the reader, which ends the harness
/// (exit 134, "deallocated with non-zero retain count") instead of reporting. The unguarded variant is the shell's own and
/// is what ThreadSanitizer is shown (`last-line-race-control`).
func oldShellReport(_ script: String, guarded: Bool) -> String {
	final class Old {
		private let lock = NSLock()
		private let guarded: Bool
		private var serverOutput = ""
		var report = ""
		init(guarded: Bool) { self.guarded = guarded }
		func append(_ text: String) {
			if guarded { lock.lock(); defer { lock.unlock() }; serverOutput += text } else { serverOutput += text }
		}
		func tail() -> String {
			if guarded { lock.lock(); defer { lock.unlock() }; return String(serverOutput.suffix(4000)) }
			return String(serverOutput.suffix(4000))
		}
	}
	let old = Old(guarded: guarded)
	let p = Process()
	p.executableURL = URL(fileURLWithPath: "/bin/sh")
	p.arguments = ["-c", script]
	let out = Pipe()
	p.standardOutput = out
	p.standardError = out
	let exited = DispatchSemaphore(value: 0)
	p.terminationHandler = { _ in
		old.report = old.tail()
		exited.signal()
	}
	followOutput(of: out.fileHandleForReading) { text in
		DispatchQueue.main.async { old.append(text) }
	}
	try? p.run()
	_ = exited.wait(timeout: .now() + 10)
	return old.report
}

func restarts() -> [String: Any] {
	// Each start appends a line with the environment it saw; the first two are killed, the third stays up.
	let counter = scratchFile("restarts.txt")
	let script = "echo \"$OMPW_TEST_TOKEN\" >> '\(counter)'; n=$(wc -l < '\(counter)' | tr -d ' '); echo \"OMPW_READY {\\\"port\\\":$n}\"; if [ $n -le 2 ]; then kill -9 $$; fi; exec sleep 60"
	let log = Log()
	let supervisor = supervise(shell(script), log)
	supervisor.start()
	let reachedThree = log.wait(for: 3)
	let (seconds, onMain) = stopped(supervisor)
	return [
		"events": log.all, "reachedThree": reachedThree, "environments": lines("restarts.txt"),
		"stopSeconds": seconds, "stopOnMain": onMain,
	]
}

func givesUp() -> [String: Any] {
	let counter = scratchFile("gives-up.txt")
	let script = "echo start >> '\(counter)'; echo 'OMPW_READY {\"port\":9}'; echo 'fatal: it never works' >&2; exit 3"
	let log = Log()
	let supervisor = supervise(shell(script), log)
	supervisor.start()
	// Four readies, then the failure.
	_ = log.wait(for: 5)
	Thread.sleep(forTimeInterval: 1.0)  // a fifth start would show by now
	_ = stopped(supervisor)
	return ["events": log.all, "starts": lines("gives-up.txt").count]
}

func window() -> [String: Any] {
	// Each start stops 0.4 s after it began, the window is 0.3 s: no stop ever finds another one in its window.
	let counter = scratchFile("window.txt")
	let script = "echo start >> '\(counter)'; echo 'OMPW_READY {\"port\":9}'; sleep 0.4; exit 3"
	let log = Log()
	let supervisor = supervise(shell(script), maxRestarts: 1, within: 0.3, log)
	supervisor.start()
	let reachedSix = log.wait(for: 6)
	_ = stopped(supervisor)
	return ["events": log.all, "reachedSix": reachedSix]
}

func stop(kind: String) -> [String: Any] {
	let pidFile = scratchFile("pid-\(kind).txt")
	let script: String
	switch kind {
	case "polite": script = "echo $$ > '\(pidFile)'; echo 'OMPW_READY {\"port\":1}'; exec sleep 60"
	default: script = "trap '' TERM; echo $$ > '\(pidFile)'; echo 'OMPW_READY {\"port\":1}'; while :; do sleep 0.1; done"
	}
	let log = Log()
	let deadline: TimeInterval = kind == "polite" ? 5 : 1.5
	var seconds = 0.0
	var onMain = false
	let watch = MainWatch()
	if kind == "control" {
		// The shell's former `stopServer`, on the main thread: SIGTERM, then wait for the exit in a sleep loop.
		let p = Process()
		p.executableURL = URL(fileURLWithPath: "/bin/sh")
		p.arguments = ["-c", script]
		p.standardOutput = FileHandle.nullDevice
		try? p.run()
		while !FileManager.default.fileExists(atPath: pidFile) { usleep(5_000) }
		watch.begin()
		let began = Date()
		DispatchQueue.main.sync {
			p.terminate()
			let end = Date().addingTimeInterval(deadline)
			while p.isRunning && Date() < end { usleep(50_000) }
			if p.isRunning { kill(p.processIdentifier, SIGKILL) }
		}
		seconds = Date().timeIntervalSince(began)
		let gap = watch.end()
		return ["stopSeconds": seconds, "worstMainGap": gap, "gone": !alive(p.processIdentifier)]
	}
	let supervisor = supervise(shell(script), log)
	supervisor.start()
	_ = log.wait(for: 1)
	while !FileManager.default.fileExists(atPath: pidFile) { usleep(5_000) }
	let pid = pid_t(lines("pid-\(kind).txt").first ?? "") ?? 0
	watch.begin()
	(seconds, onMain) = stopped(supervisor, deadline: deadline)
	let gap = watch.end()
	return ["stopSeconds": seconds, "stopOnMain": onMain, "worstMainGap": gap, "gone": !alive(pid), "events": log.all]
}

func stopWhileRestarting() -> [String: Any] {
	let counter = scratchFile("stop-restarting.txt")
	let script = "echo start >> '\(counter)'; echo 'OMPW_READY {\"port\":1}'; kill -9 $$"
	let log = Log()
	// A long restart delay: the stop comes in the gap between the stop of the server and its next start.
	let supervisor = supervise(shell(script), restartDelay: 0.5, log)
	supervisor.start()
	_ = log.wait(for: 1)
	let (seconds, _) = stopped(supervisor)
	Thread.sleep(forTimeInterval: 1.2)
	return ["starts": lines("stop-restarting.txt").count, "stopSeconds": seconds]
}

let scenario = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let runs = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2]) ?? 200 : 200
let busy = CommandLine.arguments.contains("busy")

DispatchQueue.global().async {
	let report: [String: Any]
	switch scenario {
	case "last-line": report = lastLine(runs, control: false, busy: busy)
	case "last-line-control": report = lastLine(runs, control: true, busy: busy)
	case "last-line-race-control": report = lastLine(runs, control: true, busy: busy, guarded: false)
	case "restarts": report = restarts()
	case "gives-up": report = givesUp()
	case "window": report = window()
	case "stop-polite": report = stop(kind: "polite")
	case "stop-stubborn": report = stop(kind: "stubborn")
	case "stop-control": report = stop(kind: "control")
	case "stop-while-restarting": report = stopWhileRestarting()
	default:
		FileHandle.standardError.write(Data("unknown scenario \(scenario)\n".utf8))
		exit(2)
	}
	try? FileManager.default.removeItem(at: scratch)
	let json = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
	print(String(decoding: json, as: UTF8.self))
	exit(0)
}
RunLoop.main.run()
