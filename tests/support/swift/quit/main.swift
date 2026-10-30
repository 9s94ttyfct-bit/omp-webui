import AppKit
import Foundation

// Harness for macos/quit.swift: what a quit decides by and says, run as the shell runs it, without a window or a server.
// Prints one JSON object (see tests/unit/macos-quit.test.ts):
//
//   context   what `quitContext` makes of the server's answers (a server that answers, one that does not, odd preferences)
//   first     what `quitFirst` does first for each standing answer, with the window in the foreground and in the background
//   dialogs   the question for each situation, in both languages, as it is shown
//   session   whether `isSessionEnd` takes a quit Apple event for the end of the session: real events, sent to this process
//             and delivered by AppKit to `applicationShouldTerminate`, the way logout and shutdown deliver theirs

/// `main.swift` of the app names the app; the question says its name.
let appName = "omp-webui"

setvbuf(stdout, nil, _IOLBF, 0)

func json(_ value: Any) -> String {
	String(data: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
}

func lives(_ items: [[String: Any]]) -> [[String: Any]] { items }

// MARK: context

let answers: [String: Any] = [
	"working": [["busy": true], ["busy": true, "exited": true], ["busy": false]],
	"paused": [["pausedAt": 1_000, "busy": true]],
	"waiting": [["retry": ["usageLimit": true, "resumed": false]]],
	"resumedWait": [["retry": ["usageLimit": true, "resumed": true], "busy": true]],
]

func context(
	lives: Any? = nil, omp: Any? = nil, prefs: Any? = nil, remote: Any? = nil, preferred: [String] = ["en-US"]
) -> [String: Any] {
	let c = quitContext(lives: lives, omp: omp, prefs: prefs, remote: remote, preferredLanguages: preferred)
	return [
		"working": c.running.working, "paused": c.running.paused, "waiting": c.running.waiting,
		"job": c.running.job ?? NSNull(), "reachable": c.reachable, "remote": c.remote,
		"action": c.action.rawValue, "language": c.language == .zh ? "zh" : "en",
	]
}

func prefs(_ values: [String: Any]) -> [String: Any] { ["id": "x", "rev": 1, "values": values] }

let contexts: [String: Any] = [
	"silent": context(),
	"empty": context(lives: []),
	"working": context(lives: answers["working"]),
	"paused": context(lives: answers["paused"]),
	"waiting": context(lives: answers["waiting"]),
	"resumedWait": context(lives: answers["resumedWait"]),
	"job": context(lives: [], omp: ["state": ["job": ["state": "running", "kind": "install"]]]),
	"jobEnded": context(lives: [], omp: ["state": ["job": ["state": "done", "kind": "install"]]]),
	"remoteConnected": context(lives: [], remote: ["status": ["state": "connected"]]),
	"remoteStarting": context(lives: [], remote: ["status": ["state": "starting"]]),
	"remoteError": context(lives: [], remote: ["status": ["state": "error"]]),
	"remoteOff": context(lives: [], remote: ["status": ["state": "off"]]),
	"background": context(lives: [], prefs: prefs([quitActionKey: "background"])),
	"quit": context(lives: [], prefs: prefs([quitActionKey: "quit"])),
	"ask": context(lives: [], prefs: prefs([quitActionKey: "ask"])),
	"unknownAction": context(lives: [], prefs: prefs([quitActionKey: "sometimes"])),
	"noAction": context(lives: [], prefs: prefs([quitActionKey: NSNull()])),
	"savedZh": context(lives: [], prefs: prefs([languageKey: "zh-CN"]), preferred: ["en-US"]),
	"savedEn": context(lives: [], prefs: prefs([languageKey: "en"]), preferred: ["zh-Hans-CN"]),
	"macZh": context(lives: [], preferred: ["zh-Hans-CN", "en-US"]),
	"macEn": context(lives: [], preferred: ["en-US", "zh-Hans-CN"]),
]

// MARK: first

var first: [String: String] = [:]
for action in [QuitAction.ask, .background, .quit] {
	for inBackground in [false, true] {
		for reachable in [true, false] {
			let what = quitFirst(action: action, inBackground: inBackground, reachable: reachable)
			first["\(action.rawValue)/\(inBackground ? "background" : "front")/\(reachable ? "up" : "down")"] =
				what == .runInBackground ? "runInBackground" : what == .askBackgroundOrQuit ? "ask" : "quit"
		}
	}
}

// MARK: dialogs

func shown(_ dialog: QuitDialog) -> [String: Any] {
	[
		"informational": dialog.informational, "message": dialog.message, "detail": dialog.detail,
		"buttons": dialog.buttons.map { ["title": $0.title, "choice": "\($0.choice)", "destructive": $0.destructive] },
		"remember": dialog.remember ?? NSNull(),
	]
}

func counts(_ working: Int = 0, _ paused: Int = 0, _ waiting: Int = 0, job: String? = nil) -> Conversations {
	Conversations(working: working, paused: paused, waiting: waiting, job: job)
}

let situations: [(String, Conversations, Bool)] = [
	("nothing", counts(), false),
	("oneWorking", counts(1), false),
	("manyWorking", counts(3), false),
	("oneWorkingOnePaused", counts(1, 1), false),
	("onePaused", counts(0, 1), false),
	("manyPaused", counts(0, 2), false),
	("oneWaiting", counts(0, 0, 1), false),
	("pausedAndWaiting", counts(0, 1, 1), false),
	("install", counts(job: "install"), false),
	("update", counts(job: "update"), false),
	("workingPausedWaitingInstall", counts(2, 1, 1, job: "install"), false),
	("remoteOnly", counts(), true),
	("workingAndRemote", counts(2), true),
]

var dialogs: [String: Any] = [:]
for language in [ShellLanguage.en, .zh] {
	for (name, running, remote) in situations {
		let context = QuitContext(running: running, reachable: true, remote: remote, action: .ask, language: language)
		let tag = language == .zh ? "zh" : "en"
		dialogs["\(tag)/\(name)/background"] = shown(quitDialog(context, offersBackground: true))
		dialogs["\(tag)/\(name)/quitOnly"] = shown(quitDialog(context, offersBackground: false))
	}
}
var warnings: [String: Bool] = [:]
for (name, running, _) in situations { warnings[name] = running.needsWarning }

// MARK: session

/// Records what `isSessionEnd` says in `applicationShouldTerminate`, and refuses the quit (the harness is the one to end).
final class Delegate: NSObject, NSApplicationDelegate {
	var seen: [Bool] = []
	func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
		seen.append(isSessionEnd(NSAppleEventManager.shared().currentAppleEvent))
		return .terminateCancel
	}
}

func sendQuit(reason: OSType?) {
	let target = NSAppleEventDescriptor(processIdentifier: ProcessInfo.processInfo.processIdentifier)
	let event = NSAppleEventDescriptor(
		eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEQuitApplication), targetDescriptor: target,
		returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
	if let reason { event.setAttribute(NSAppleEventDescriptor(enumCode: reason), forKeyword: AEKeyword(kAEQuitReason)) }
	_ = try? event.sendEvent(options: [.noReply, .neverInteract], timeout: 5)
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.prohibited)

/// Quits in the order of this list: a plain Apple event (Dock › Quit, `osascript`), a direct `terminate` (⌘Q), a reason that is
/// no end of the session, then each of the six that are.
let sent: [(String, OSType?)] = [
	("appleEvent", nil),
	("terminate", nil),
	("userReason", OSType(0x7573_6572)),
	("logOut", OSType(kAELogOut)),
	("reallyLogOut", OSType(kAEReallyLogOut)),
	("restartDialog", OSType(kAEShowRestartDialog)),
	("shutdownDialog", OSType(kAEShowShutdownDialog)),
	("restart", OSType(kAERestart)),
	("shutdown", OSType(kAEShutDown)),
]

func next(_ index: Int) {
	guard index < sent.count else {
		var session: [String: Bool] = [:]
		for (i, (name, _)) in sent.enumerated() where i < delegate.seen.count { session[name] = delegate.seen[i] }
		print(
			json([
				"context": contexts, "first": first, "dialogs": dialogs, "warnings": warnings,
				"session": ["asked": delegate.seen.count, "ending": session],
			]))
		exit(0)
	}
	let before = delegate.seen.count
	if sent[index].0 == "terminate" { NSApp.terminate(nil) } else { sendQuit(reason: sent[index].1) }
	// Wait for the application to have asked, then go on with the next.
	func wait(_ tries: Int) {
		if delegate.seen.count > before || tries == 0 { return next(index + 1) }
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { wait(tries - 1) }
	}
	wait(60)
}

// MARK: a quit that is pending

/// The shell while it asks: `applicationShouldTerminate` answers `.terminateLater` and the answer comes later, from a question
/// that is open in a modal session (here a panel; the shell's is an `NSAlert`). The question is closed by `SessionEnd`, as the
/// shell's is, and when it is closed the quit is answered as the shell answers it: for real if the session is ending.
///
///   harness modal          the system announces the end of the session (`willPowerOffNotification`, delivered by hand)
///   harness modal-event    a quit event with the shutdown reason is sent to this process, as the system sends it: it never reaches
///                          the delegate (`quitsSeen` stays 1), but AppKit announces the end of the session itself, which `SessionEnd` hears
final class AskingDelegate: NSObject, NSApplicationDelegate {
	var quitsSeen = 0
	var closedWith: Int?
	var endingAfter = false
	var sessionEnd: SessionEnd!
	let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 200, height: 80), styleMask: [.titled], backing: .buffered, defer: false)

	func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
		quitsSeen += 1
		guard quitsSeen == 1 else { return .terminateLater }
		DispatchQueue.main.async { [self] in
			closedWith = NSApp.runModal(for: panel).rawValue
			endingAfter = sessionEnd.isEnding
			NSApp.reply(toApplicationShouldTerminate: sessionEnd.isEnding)
			if !sessionEnd.isEnding { report(); exit(0) }
		}
		return .terminateLater
	}

	func applicationWillTerminate(_ notification: Notification) { report() }

	func report() {
		print(json(["quitsSeen": quitsSeen, "closedWith": closedWith ?? NSNull(), "endingAfter": endingAfter, "ended": true]))
	}
}

func runPending(event: Bool) {
	let asking = AskingDelegate()
	app.delegate = asking
	app.setActivationPolicy(.accessory)
	asking.sessionEnd = SessionEnd {
		if NSApp.modalWindow != nil { NSApp.abortModal() }
	}
	// The question is a modal session started from a block of the main queue (as the shell's is), and the blocks of the main queue
	// that come after it do not run until it is over: nor do blocks performed on the run loop, which does not wake for them. The
	// run loop itself is what is watched: when it is about to wait for an event while a modal window is up, the question is open
	// and nothing is going to close it. The system's own notice, an event of the run loop, does reach it: that is what is tested.
	func whenOpen(_ body: @escaping () -> Void) {
		var done = false
		let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { observer, _ in
			guard !done, NSApp.modalWindow != nil else { return }
			done = true
			CFRunLoopObserverInvalidate(observer)
			body()
		}
		CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
	}
	RunLoop.main.perform(inModes: [.common]) { NSApp.terminate(nil) }
	// The end of the session comes once the question is open, however long that takes; and the question must close by itself:
	// nothing here closes it by hand, the deadline below is all that waits.
	whenOpen {
		if event {
			sendQuit(reason: OSType(kAEShutDown))
		} else {
			NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.willPowerOffNotification, object: NSWorkspace.shared)
		}
	}
	RunLoop.main.add(
		Timer(timeInterval: 15, repeats: false) { _ in print(json(["error": "the question was not closed"])); exit(2) }, forMode: .common)
	app.run()
}

switch CommandLine.arguments.dropFirst().first {
case "modal": runPending(event: false)
case "modal-event": runPending(event: true)
default:
	DispatchQueue.main.async { next(0) }
	app.run()
}
