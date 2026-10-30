import AppKit

// The harness of tests/unit/macos-window-frame.test.ts: asks macos/windowframe.swift's pure parts about made-up screens and a
// defaults suite of its own, and prints what they answered as one JSON object. No window and no window server.

let screen = NSRect(x: 0, y: 0, width: 1512, height: 944)
let second = NSRect(x: 1512, y: 0, width: 2560, height: 1415)
let min = NSSize(width: 420, height: 480)
func frame(_ r: NSRect?) -> Any { r.map { [$0.minX, $0.minY, $0.width, $0.height] } ?? NSNull() }

let suite = "ompw-windowframe-test-\(getpid())"
let defaults = UserDefaults(suiteName: suite)!
defaults.removePersistentDomain(forName: suite)
let memory = WindowFrameMemory(key: "main", defaults: defaults)
let before = memory.savedSize()
defaults.set(NSStringFromRect(NSRect(x: 40, y: 50, width: 1300, height: 800)), forKey: "ompw.windowFrame.main")
let after = memory.savedSize()
defaults.removePersistentDomain(forName: suite)

let out: [String: Any] = [
	"onScreen": frame(restorableFrame(NSRect(x: 100, y: 80, width: 1300, height: 820), screens: [screen], minSize: min)),
	"onSecond": frame(restorableFrame(NSRect(x: 1700, y: 200, width: 1600, height: 1000), screens: [screen, second], minSize: min)),
	"secondGone": frame(restorableFrame(NSRect(x: 1700, y: 200, width: 1600, height: 1000), screens: [screen], minSize: min)),
	"titleBarOff": frame(restorableFrame(NSRect(x: 100, y: 900, width: 1300, height: 820), screens: [screen], minSize: min)),
	"tooSmall": frame(restorableFrame(NSRect(x: 100, y: 80, width: 300, height: 200), screens: [screen], minSize: min)),
	"parsed": frame(parseSavedFrame(NSStringFromRect(NSRect(x: 12, y: 34, width: 1280, height: 840)))),
	"parsedEmpty": frame(parseSavedFrame("")),
	"parsedJunk": frame(parseSavedFrame("not a frame")),
	"sizeBefore": before.map { [$0.width, $0.height] } ?? NSNull(),
	"sizeAfter": after.map { [$0.width, $0.height] } ?? NSNull(),
]
print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
