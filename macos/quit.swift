import AppKit

// What the shell does when the app is asked to quit (#604), as plain values and functions: what the person chose, what the
// server says is running, which question is asked in which words, and what a quit Apple event says about why it came. The
// delegate (`main.swift`) only fetches, shows the question and acts on the answer, so that all of it can be run in a harness
// (tests/support/swift/quit/main.swift) without a window or a server.

// MARK: - What the person chose

/// The web UI's preferences of these names (`PREF.quitAction` and `PREF.lang` in shared/prefs.ts), which the server keeps in
/// its data dir: the shell reads them from `GET /api/prefs` when it is asked to quit, and writes the first back with
/// `POST /api/prefs` when the person ticks "Don't ask again".
let quitActionKey = "ompw.quitAction"
let languageKey = "ompw.lang"

/// What quitting does: `ask` (the default) asks; `background` closes the window and keeps the app, the server and its
/// conversations running; `quit` quits for real, as before.
enum QuitAction: String {
	case ask, background, quit

	/// What the preference holds; anything else (not set, a value from another version) is `ask`.
	init(stored: String?) { self = stored.flatMap(QuitAction.init(rawValue:)) ?? .ask }
}

/// The language of the shell's own words (the quit question), chosen as the page chooses its own: the saved language, else
/// the first of the Mac's preferred languages (`navigator.language` is that one).
enum ShellLanguage: Equatable {
	case en, zh

	init(stored: String?, preferred: [String]) {
		switch stored {
		case "en": self = .en
		case "zh-CN": self = .zh
		default: self = (preferred.first ?? "").lowercased().hasPrefix("zh") ? .zh : .en
		}
	}
}

// MARK: - What the server says

/// What a state line says: how many conversations work, wait for an answer and are paused, whether the menu bar icon is wanted
/// while the app has its window too (Settings › Quitting), how many unattended questions are open, and how many runs have
/// finished in this server's run (a running count: what the person has seen of it is the icon's to keep, `FinishedWatch`). A
/// server from before these said none of them: none is paused, the icon is wanted (the default), no question waits and no run
/// finished.
struct ShellState: Equatable {
	var working = 0
	var asking = 0
	var paused = 0
	var menuIcon = true
	var questions = 0
	var finished = 0
}

/// What is running that a quit would touch: conversations that are working (`/api/lives`), ones that are paused, ones that
/// wait out a provider's usage limit, and the kind of omp install or update that is running (`/api/omp`), if any.
struct Conversations: Equatable {
	var working = 0
	var paused = 0
	var waiting = 0
	var job: String?

	/// Something a quit stops, or leaves in the background, that the person should be told of.
	var needsWarning: Bool { working > 0 || paused > 0 || waiting > 0 || job != nil }
}

/// Everything a quit decides by, as the server answered it. A server that did not answer is `reachable == false`, with
/// nothing running: quitting must never hang on it.
struct QuitContext: Equatable {
	var running = Conversations()
	/// `/api/lives` answered.
	var reachable = false
	/// The tunnel of remote access is up or coming up: it goes on running in the background, and a quit ends it.
	var remote = false
	var action = QuitAction.ask
	var language = ShellLanguage.en
}

/// The conversations in the answers of `/api/lives` and `/api/omp` (nil: it did not answer, which counts as none).
func conversations(lives: Any?, omp: Any?) -> Conversations {
	var counts = Conversations()
	for live in (lives as? [[String: Any]] ?? []) where (live["exited"] as? Bool) != true {
		// A wait the server keeps across its end (`Live.kept`): a usage-limit wait whose turn has not started.
		let retry = live["retry"] as? [String: Any]
		if live["pausedAt"] is NSNumber { counts.paused += 1 }
		else if (retry?["usageLimit"] as? Bool) == true && (retry?["resumed"] as? Bool) == false { counts.waiting += 1 }
		else if (live["busy"] as? Bool) == true { counts.working += 1 }
	}
	if let state = (omp as? [String: Any])?["state"] as? [String: Any],
		let job = state["job"] as? [String: Any], (job["state"] as? String) == "running" {
		counts.job = job["kind"] as? String
	}
	return counts
}

/// The context from the answers of `/api/lives`, `/api/omp`, `/api/prefs` and `/api/remote` (each nil when it did not answer).
func quitContext(lives: Any?, omp: Any?, prefs: Any?, remote: Any?, preferredLanguages: [String]) -> QuitContext {
	let values = (prefs as? [String: Any])?["values"] as? [String: Any]
	let tunnel = ((remote as? [String: Any])?["status"] as? [String: Any])?["state"] as? String
	return QuitContext(
		running: conversations(lives: lives, omp: omp),
		reachable: lives is [Any],
		remote: tunnel == "connected" || tunnel == "starting",
		action: QuitAction(stored: values?[quitActionKey] as? String),
		language: ShellLanguage(stored: values?[languageKey] as? String, preferred: preferredLanguages))
}

// MARK: - What a quit does first

/// What a quit the person asked for (⌘Q, the menu, the window's close button, the Dock) does first.
enum QuitFirst: Equatable {
	/// The window goes and the app, its server and its conversations run on.
	case runInBackground
	/// The question with all three answers: Run in Background, Quit, Cancel.
	case askBackgroundOrQuit
	/// The app quits, as it always did: at once while nothing is at risk, else after the question that says what a quit stops.
	case quit
}

/// A server that does not answer is not asked about anything, and a window that is already in the background is not sent
/// there again: both quit for real. Otherwise the person's standing answer decides.
func quitFirst(action: QuitAction, inBackground: Bool, reachable: Bool) -> QuitFirst {
	if !reachable || inBackground { return .quit }
	switch action {
	case .ask: return .askBackgroundOrQuit
	case .background: return .runInBackground
	case .quit: return .quit
	}
}

/// Whether a quit Apple event says why it came, and that the reason is the end of the session: log out, restart or shut down
/// (`kAEQuitReason`). Those quit for real and at once, whatever the person chose: nobody is there to be asked, and a question
/// that is not answered holds the whole logout up.
func isSessionEnd(_ event: NSAppleEventDescriptor?) -> Bool {
	guard let reason = event?.attributeDescriptor(forKeyword: AEKeyword(kAEQuitReason)) else { return false }
	let ending: [OSType] = [
		OSType(kAELogOut), OSType(kAEReallyLogOut), OSType(kAEShowRestartDialog), OSType(kAEShowShutdownDialog),
		OSType(kAERestart), OSType(kAEShutDown),
	]
	return ending.contains(reason.enumCodeValue)
}

/// The end of the session as the system announces it before it sends any quit event (`NSWorkspace.willPowerOffNotification`: log
/// out, restart, shut down), and for `hold` seconds after it.
///
/// The quit event alone is not enough (measured, #604): while a quit is pending (the app answered `.terminateLater`, as it does
/// while it asks, and again while the server stops) AppKit answers a second quit event itself and never shows it to the
/// delegate, so a logout that comes while the question is open could not tell the app to quit, and the system would wait for
/// the person. The notice comes first, whatever is pending: `onNotice` closes the question. It is held for a while, not for good: a
/// logout that is cancelled after the notice must not leave every later ⌘Q unasked.
///
/// The notice is not handed to the main queue (`queue: nil`, `onNotice` runs where the system posts it, on the main thread): the
/// question is open in a modal session that the shell started from a block of the main queue, and a modal session started there
/// does not run the blocks that come after it (the same trap `UpdateQuit` documents), so a block would only run once the question
/// has been answered by the person it was meant to spare.
final class SessionEnd {
	private let center: NotificationCenter
	private let hold: TimeInterval
	private var until = Date.distantPast
	private var watching: NSObjectProtocol?

	/// `onNotice` runs each time the system announces the end of the session.
	init(center: NotificationCenter = NSWorkspace.shared.notificationCenter, hold: TimeInterval = 30, onNotice: @escaping () -> Void) {
		self.center = center
		self.hold = hold
		watching = center.addObserver(forName: NSWorkspace.willPowerOffNotification, object: nil, queue: nil) { [weak self] _ in
			guard let self else { return }
			self.until = Date().addingTimeInterval(self.hold)
			onNotice()
		}
	}

	deinit {
		if let watching { center.removeObserver(watching) }
	}

	/// The system announced the end of the session a moment ago.
	var isEnding: Bool { Date() < until }

	/// The quit that `event` delivers is the end of the session: it says so, or the system announced it a moment ago.
	func isEnding(by event: NSAppleEventDescriptor?) -> Bool { isEnding || isSessionEnd(event) }
}

// MARK: - The question

enum QuitChoice: Equatable { case cancel, runInBackground, quit, quitEndingKept }

/// A question as it is shown: the words, the buttons in the order they are added (the first is the default, answered by Return),
/// and the "Don't ask again" box with the answers it applies to.
struct QuitDialog: Equatable {
	struct Button: Equatable {
		var title: String
		var choice: QuitChoice
		var destructive = false
	}

	/// Nothing is stopped by an answer (as against: a working conversation is).
	var informational: Bool
	var message: String
	var detail: String
	var buttons: [Button]
	/// The title of the box that makes an answer the standing one; nil when there is none.
	var remember: String?
	/// The answers the box applies to (Run in Background, Quit): the others are one-off.
	static let rememberable: [QuitChoice] = [.runInBackground, .quit]
}

/// The words of one language. English is what the question has always said; the Chinese says 对话, never 会话, as the web UI does.
private struct Words {
	let working: (Int) -> String
	let install: String
	let update: String
	let pausedOrWaiting: (Int) -> String
	let paused: (Int) -> String
	let waiting: (Int) -> String
	let nothing: String
	/// "Quit anyway? Quitting stops them.", the sentence of the question that only asks whether to quit.
	let quitAnywayQuestion: (Int) -> String
	/// "Quitting stops them.", in the question that also offers to run in the background.
	let quitStops: (Int) -> String
	let jobStays: (_ install: Bool) -> String
	/// `lead`: something else was said before, so the subject is named.
	let pausedStays: (_ n: Int, _ lead: Bool) -> String
	let waitingStays: (_ n: Int, _ lead: Bool) -> String
	let background: (_ remote: Bool) -> String
	let runInBackground: String
	let cancel: String
	let quit: String
	let quitAnyway: String
	let endIt: String
	let endPaused: String
	let endWaiting: String
	let endThem: String
	let dontAsk: String
}

private func words(_ language: ShellLanguage) -> Words {
	switch language {
	case .en:
		return Words(
			working: { $0 == 1 ? "1 conversation is still working" : "\($0) conversations are still working" },
			install: "omp is being installed",
			update: "omp is being updated",
			pausedOrWaiting: { "\($0) conversations are paused or waiting" },
			paused: { $0 == 1 ? "1 conversation is paused" : "\($0) conversations are paused" },
			waiting: { $0 == 1 ? "1 conversation is waiting for a usage limit" : "\($0) conversations are waiting for a usage limit" },
			nothing: "Quit \(appName)?",
			quitAnywayQuestion: { "Quit anyway? Quitting stops \($0 == 1 ? "it" : "them")." },
			quitStops: { "Quitting stops \($0 == 1 ? "it" : "them")." },
			jobStays: {
				"\($0 ? "The install" : "The update") is not stopped by quitting: it finishes in the background, and \(appName) shows how it ended when you open it again."
			},
			pausedStays: { n, lead in
				let stays = lead ? (n == 1 ? "The paused conversation stays" : "The paused conversations stay") : (n == 1 ? "It stays" : "They stay")
				return "\(stays) frozen in the background, with running tools, and \(n == 1 ? "continues where it stopped" : "continue where they stopped") when you open \(appName) again."
			},
			waitingStays: { n, lead in
				let stays = lead ? (n == 1 ? "The waiting conversation stays" : "The waiting conversations stay") : (n == 1 ? "It stays" : "They stay")
				return "\(stays) in the background, where omp retries the turn by itself when the usage limit resets; \(appName) shows how it went when you open it again."
			},
			background: {
				"Run in Background closes the window but keeps \(appName) running, so your conversations carry on\($0 ? " and remote access stays on" : ""). Click the \(appName) icon in the menu bar to open the window again."
			},
			runInBackground: "Run in Background", cancel: "Cancel", quit: "Quit", quitAnyway: "Quit Anyway",
			endIt: "Quit and End It", endPaused: "Quit and End Paused", endWaiting: "Quit and End Waiting",
			endThem: "Quit and End Them", dontAsk: "Don't ask again")
	case .zh:
		return Words(
			working: { "有 \($0) 个对话仍在工作" },
			install: "正在安装 omp",
			update: "正在更新 omp",
			pausedOrWaiting: { "有 \($0) 个对话已暂停或在等待" },
			paused: { "有 \($0) 个对话已暂停" },
			waiting: { "有 \($0) 个对话在等待用量上限重置" },
			nothing: "退出 \(appName)？",
			quitAnywayQuestion: { _ in "仍要退出吗？退出会停止它们。" },
			quitStops: { _ in "退出会停止它们。" },
			jobStays: { "退出不会中断\($0 ? "安装" : "更新")：它会在后台继续完成，下次打开 \(appName) 时会显示结果。" },
			pausedStays: { _, _ in "已暂停的对话会连同它的工具一起在后台保持冻结，重新打开 \(appName) 后从停下的地方继续。" },
			waitingStays: { _, _ in "在等待的对话会留在后台，用量上限重置时 omp 会自动重试这一轮；重新打开 \(appName) 后会显示结果。" },
			background: {
				"“在后台运行”会关闭窗口，但 \(appName) 继续运行，对话照常进行\($0 ? "，远程访问也保持开启" : "")。点击菜单栏里的 \(appName) 图标即可重新打开窗口。"
			},
			runInBackground: "在后台运行", cancel: "取消", quit: "退出", quitAnyway: "仍然退出",
			endIt: "退出并结束它", endPaused: "退出并结束已暂停的", endWaiting: "退出并结束在等待的",
			endThem: "退出并结束它们", dontAsk: "不再询问")
	}
}

/// The question for a quit. `offersBackground`: the person is asked whether to run in the background or quit (a window that is
/// already in the background, or a person who chose to quit, is only warned about what a quit stops, and only while it stops
/// or leaves something).
///
/// A quit stops the working conversations; the paused ones stay frozen in the background and continue after the next launch
/// unless the person ends them, and the waiting ones stay there running, so that omp retries the turn at the reset; a running
/// install or update is not stopped (it does not depend on the server) and is picked up again at the next launch. Without
/// a background to run in, Cancel is the default while anything is working or running; otherwise Quit is. With one, Run in
/// Background is.
func quitDialog(_ context: QuitContext, offersBackground: Bool) -> QuitDialog {
	let w = words(context.language)
	let counts = context.running
	let working = counts.working, paused = counts.paused, waiting = counts.waiting
	var lines: [String] = []
	if offersBackground { lines.append(w.background(context.remote)) }
	var message: String
	var informational = true
	if working > 0 {
		message = w.working(working)
		informational = false
		lines.append(offersBackground ? w.quitStops(working) : w.quitAnywayQuestion(working))
	} else if let job = counts.job {
		message = job == "install" ? w.install : w.update
	} else if paused > 0 && waiting > 0 {
		message = w.pausedOrWaiting(paused + waiting)
	} else if paused > 0 {
		message = w.paused(paused)
	} else if waiting > 0 {
		message = w.waiting(waiting)
	} else {
		message = w.nothing
	}
	if let job = counts.job { lines.append(w.jobStays(job == "install")) }
	if paused > 0 { lines.append(w.pausedStays(paused, working > 0 || counts.job != nil)) }
	if waiting > 0 { lines.append(w.waitingStays(waiting, working > 0 || counts.job != nil || paused > 0)) }

	var buttons: [QuitDialog.Button] = []
	let quit = QuitDialog.Button(title: working > 0 ? w.quitAnyway : w.quit, choice: .quit, destructive: working > 0)
	let cancel = QuitDialog.Button(title: w.cancel, choice: .cancel)
	if offersBackground {
		buttons = [.init(title: w.runInBackground, choice: .runInBackground), cancel, quit]
	} else if working > 0 || counts.job != nil {
		buttons = [cancel, quit]
	} else {
		buttons = [.init(title: w.quit, choice: .quit), cancel]
	}
	if paused > 0 || waiting > 0 {
		let kept = paused + waiting
		buttons.append(
			.init(
				title: kept == 1 ? w.endIt : waiting == 0 ? w.endPaused : paused == 0 ? w.endWaiting : w.endThem,
				choice: .quitEndingKept, destructive: true))
	}
	return QuitDialog(
		informational: informational, message: message,
		// Chinese does not put a space between sentences.
		detail: lines.joined(separator: context.language == .zh ? "" : " "), buttons: buttons,
		remember: offersBackground ? w.dontAsk : nil)
}
