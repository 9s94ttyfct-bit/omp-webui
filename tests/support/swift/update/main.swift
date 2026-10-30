import AppKit
import Darwin
import Foundation

// Harness for macos/update.swift: the shell's `UpdateQuit` inside a real `NSApplication`, quitting the way the shell does —
// `NSApp.terminate` answered `.terminateLater`, with the reply sent from a block of the main queue once "the server has
// stopped" (the supervisor's `done` runs on the main queue). Prints `ready` once the handler is installed, `asked` for each
// request that is for an update, and `quit` when the application is ending. See tests/unit/macos-update.test.ts.
//
//   harness <data dir>                 how the shell quits (what the app does)
//   harness <data dir> direct          the shell as it was first written: `terminate` called inside the signal's handler

setvbuf(stdout, nil, _IOLBF, 0)
let dataDir = URL(fileURLWithPath: CommandLine.arguments[1])
let direct = CommandLine.arguments.dropFirst(2).first == "direct"

final class Delegate: NSObject, NSApplicationDelegate {
	func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
		// What `stopServerAndQuit` does: the answer comes from a block of the main queue, some time after.
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.reply(toApplicationShouldTerminate: true) }
		return .terminateLater
	}
	func applicationWillTerminate(_ notification: Notification) { print("quit") }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.prohibited)

var requests = 0
let updateQuit = UpdateQuit(dataDir: dataDir) {
	requests += 1
	print("asked")
	NSApp.terminate(nil)
}
if direct {
	// The first version of `UpdateQuit.requested`: the quit is called in the handler itself.
	signal(SIGUSR1, SIG_IGN)
	let source = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
	source.setEventHandler {
		guard FileManager.default.fileExists(atPath: dataDir.appendingPathComponent("update/handover.json").path) else { return }
		print("asked")
		NSApp.terminate(nil)
	}
	source.resume()
	// Held for the life of the process.
	withExtendedLifetime(source) { print("ready"); app.run() }
} else {
	updateQuit.start()
	print("ready")
	app.run()
}
