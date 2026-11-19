import Darwin
import Foundation

// Harness for macos/serveroutput.swift: a "server" that prints and exits, its output read the way the shell reads it,
// and what the process costs in CPU in the second after the server is gone (the shell's "server stopped" alert is
// open for that long and longer). Prints one JSON line.
//
//   harness            followOutput, as the shell uses it
//   harness control    the handler the shell used to have: it never removes itself at the end of the file
//   harness split      a server whose one line comes in two writes cut inside a character (#379)
//   harness cuts       `UTF8Pieces` alone: a line cut into two pieces at every byte, then fed one byte at a time

func cpuSeconds() -> Double {
	var usage = rusage()
	getrusage(RUSAGE_SELF, &usage)
	func seconds(_ t: timeval) -> Double { Double(t.tv_sec) + Double(t.tv_usec) / 1_000_000 }
	return seconds(usage.ru_utime) + seconds(usage.ru_stime)
}

/// A line with characters of two, three and four bytes, as a path in a Chinese stack trace has.
let sample = "错误: 无法打开 /tmp/项目/a.ts é 😀"

if CommandLine.arguments.contains("cuts") {
	let bytes = Data(sample.utf8)
	var wrong: [Int] = []
	for cut in 0...bytes.count {
		let pieces = UTF8Pieces()
		let text = pieces.decode(bytes.prefix(cut)) + pieces.decode(bytes.suffix(from: cut)) + pieces.finish()
		if text != sample { wrong.append(cut) }
	}
	let bytewise = UTF8Pieces()
	var one = bytes.map { bytewise.decode(Data([$0])) }.joined()
	one += bytewise.finish()
	// A character that never completes still reads as U+FFFD at the end, as it did.
	let unfinished = UTF8Pieces()
	let cutShort = unfinished.decode(Data("ab".utf8) + Data([0xE9, 0x94])) + unfinished.finish()
	let report: [String: Any] = ["wrongCuts": wrong, "bytewise": one == sample, "cutShort": cutShort]
	print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
	exit(0)
}

let control = CommandLine.arguments.contains("control")
let split = CommandLine.arguments.contains("split")
let p = Process()
p.executableURL = URL(fileURLWithPath: "/bin/sh")
if split {
	// The first write ends after the first byte of 误 (E8 AF AF); the pause makes the rest a second read.
	p.arguments = ["-c", "printf '\\351\\224\\231\\350'; sleep 0.3; printf '\\257\\257: x\\n'"]
} else {
	p.arguments = ["-c", "echo OMPW_READY '{\"port\":1}'; echo boom >&2; exit 1"]
}
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
