import Darwin
import Foundation

// Harness for macos/serveroutput.swift: a "server" that prints and exits, its output read the way the shell reads it,
// and what the process costs in CPU in the second after the server is gone (the shell's "server stopped" alert is
// open for that long and longer). Prints one JSON line.
//
//   harness            followOutput, as the shell uses it
//   harness control    the handler the shell used to have: it never removes itself at the end of the file

func cpuSeconds() -> Double {
	var usage = rusage()
	getrusage(RUSAGE_SELF, &usage)
	func seconds(_ t: timeval) -> Double { Double(t.tv_sec) + Double(t.tv_usec) / 1_000_000 }
	return seconds(usage.ru_utime) + seconds(usage.ru_stime)
}

let control = CommandLine.arguments.contains("control")
let p = Process()
p.executableURL = URL(fileURLWithPath: "/bin/sh")
p.arguments = ["-c", "echo OMPW_READY '{\"port\":1}'; echo boom >&2; exit 1"]
let out = Pipe()
p.standardOutput = out
p.standardError = out

let lock = NSLock()
var text = ""
var calls = 0
if control {
	out.fileHandleForReading.readabilityHandler = { h in
		let data = h.availableData
		lock.lock()
		calls += 1
		lock.unlock()
		guard !data.isEmpty else { return }
		lock.lock()
		text += String(decoding: data, as: UTF8.self)
		lock.unlock()
	}
} else {
	followOutput(of: out.fileHandleForReading) { piece in
		lock.lock()
		calls += 1
		text += piece
		lock.unlock()
	}
}

let exited = DispatchSemaphore(value: 0)
p.terminationHandler = { _ in exited.signal() }
try p.run()
_ = exited.wait(timeout: .now() + 10)

// Let the end of the file be seen, then measure a quiet second: the run loop runs, as the app's does.
RunLoop.main.run(until: Date().addingTimeInterval(0.3))
let cpuBefore = cpuSeconds()
let callsBefore = { () -> Int in lock.lock(); defer { lock.unlock() }; return calls }()
let wallBefore = Date()
RunLoop.main.run(until: Date().addingTimeInterval(1.0))
let wall = Date().timeIntervalSince(wallBefore)
let cpu = cpuSeconds() - cpuBefore
lock.lock()
let callsAfter = calls - callsBefore
let received = text
lock.unlock()

let report: [String: Any] = [
	"text": received,
	"handlerCleared": out.fileHandleForReading.readabilityHandler == nil,
	"callsInQuietSecond": callsAfter,
	"cpuShare": cpu / wall,
]
let json = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(decoding: json, as: UTF8.self))
