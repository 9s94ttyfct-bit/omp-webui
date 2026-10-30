import AppKit

// Run in Background (#627): the app has no window at all. Its window and the page in it are closed (`MainWindow`), the app is
// no longer a regular one (no Dock icon, not in ⌘-Tab or Stage Manager, and the system never makes it the active app to show
// the window of one that has none), the server and the conversations run on, and a menu bar icon is how the person gets back:
// it opens the window again, says what is working and what needs them, and quits. What a page used to do in the background
// (hear the conversations, show their notifications) the app does itself, from the server's own stream (`shellevents.swift`).

// MARK: - The screen goes back to the app that had it

/// What `ScreenHandoff.yield` did with the screen.
enum ScreenYield: String {
	/// The app that was in front was activated, so this one is no longer the active app.
	case gave
	/// Nothing to give: this app was not the active one (the system had not let it become one), or no other app is there.
	case idle
}

/// The app is active when it puts its window away (or a question it asked is answered while it has none), and an active app that
/// shows nothing would keep the screen: the app that had it is made the active one again. `NSApp.deactivate()` is not used: on
/// macOS 27 (measured, with an app that had activated itself the way this one does) it leaves the app active, in front of the
/// one that had the screen, while activating that app works.
///
/// Only an active app has a screen to give back. From macOS 14 an app becomes the active one only when the person or the
/// active app lets it, and a request that is refused leaves it inactive (a Quit from the menu bar icon while another app is in
/// front, whose question was not allowed to come forward): activating the app that was in front would at best repeat what the
/// person has (it is the last app that was activated, so usually the one in front) and at worst bring forward one they have
/// since hidden or left.
final class ScreenHandoff {
	/// The last app that was active but this one: where the screen goes back to.
	private var lastOther: NSRunningApplication?
	private var watching: NSObjectProtocol?

	/// `otherApp`: the app the screen goes back to; nil follows the app that was in front before this one (what the shell does; a
	/// test names one, or none, to have the same every time).
	init(otherApp: (() -> NSRunningApplication?)? = nil) {
		if let otherApp {
			lastOther = otherApp()
			return
		}
		lastOther = NSWorkspace.shared.frontmostApplication.flatMap { $0.processIdentifier == getpid() ? nil : $0 }
		watching = NSWorkspace.shared.notificationCenter.addObserver(
			forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
		) { [weak self] note in
			guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
				app.processIdentifier != getpid()
			else { return }
			self?.lastOther = app
		}
	}

	deinit {
		if let watching { NSWorkspace.shared.notificationCenter.removeObserver(watching) }
	}

	@discardableResult
	func yield() -> ScreenYield {
		guard NSApp.isActive, let other = lastOther, !other.isTerminated, other.activate(options: []) else { return .idle }
		return .gave
	}
}

// MARK: - The menu bar icon

/// What the person has seen of the runs that finished (#705): the server counts them from its start (`ShellState.finished`, per
/// `epoch`), and the icon says how many came since the person last looked, which is when its menu opens or the app becomes the
/// active one (its window comes to the front). A new epoch is a server that began again: its count starts over, and the person
/// has seen what there was when the app first heard of it. A state that names no epoch (a test's) is of the epoch before.
struct FinishedWatch: Equatable {
	private(set) var epoch: String?
	private var finished = 0
	private var seen = 0

	/// Runs that ended since the person last looked.
	var unseen: Int { max(0, finished - seen) }

	mutating func hear(finished: Int, epoch: String?) {
		if let epoch, epoch != self.epoch {
			self.epoch = epoch
			seen = finished
		}
		self.finished = finished
	}

	/// The person looks: what finished so far is seen.
	mutating func look() { seen = finished }
}

/// One line of the menu bar icon's menu.
struct StatusLine: Equatable {
	enum Role: Int, Equatable {
		/// Opens the window again.
		case open = 1
		/// Says something, and does nothing.
		case info
		/// Pauses every conversation whose turn is open, each as its own Pause does (`POST /api/shell/pause-all`).
		case pauseAll
		/// Resumes every paused conversation (`POST /api/shell/resume-all`).
		case resumeAll
		/// Quits, as ⌘Q does (the same question, and the same refusals).
		case quit
		case separator
		/// Opens the window on the Questions page (`#/questions`): the unattended questions that wait for an answer (#705).
		case questions
	}

	var role: Role
	var title: String
}

/// The menu: Open; what is going on, and Pause all or Resume all when there is something to pause or to resume; what is left
/// of each provider's quota; Quit. What is going on is how many conversations work, how many wait for an answer and how many
/// are paused, as the server counts them (`shellCounts` in server/shell-events.ts): each is counted once. Then, when any are,
/// the unattended questions that wait (a line that opens the Questions page) and the runs that finished since the person last
/// looked (`unseenFinished`, #705).
func statusMenu(state: ShellState, quota: [String], language: ShellLanguage, unseenFinished: Int = 0) -> [StatusLine] {
	let zh = language == .zh
	var lines = [StatusLine(role: .open, title: zh ? "打开 \(appName)" : "Open \(appName)"), StatusLine(role: .separator, title: "")]
	let (working, asking, paused) = (state.working, state.asking, state.paused)
	if zh {
		if working > 0 { lines.append(.init(role: .info, title: "\(working) 个对话正在工作")) }
		if asking > 0 { lines.append(.init(role: .info, title: "\(asking) 个对话需要你的输入")) }
		if paused > 0 { lines.append(.init(role: .info, title: "\(paused) 个对话已暂停")) }
		if working == 0 && asking == 0 && paused == 0 { lines.append(.init(role: .info, title: "没有正在工作的对话")) }
	} else {
		if working > 0 { lines.append(.init(role: .info, title: working == 1 ? "1 conversation working" : "\(working) conversations working")) }
		if asking > 0 { lines.append(.init(role: .info, title: asking == 1 ? "1 conversation needs your input" : "\(asking) conversations need your input")) }
		if paused > 0 { lines.append(.init(role: .info, title: paused == 1 ? "1 conversation paused" : "\(paused) conversations paused")) }
		if working == 0 && asking == 0 && paused == 0 { lines.append(.init(role: .info, title: "No conversations working")) }
	}
	let questions = state.questions
	if questions > 0 {
		lines.append(.init(role: .questions, title: zh ? "\(questions) 个问题等待回答" : (questions == 1 ? "1 question waiting" : "\(questions) questions waiting")))
	}
	if unseenFinished > 0 {
		lines.append(.init(role: .info, title: zh ? "\(unseenFinished) 个对话已完成" : (unseenFinished == 1 ? "1 conversation finished" : "\(unseenFinished) conversations finished")))
	}
	if working + asking > 0 { lines.append(.init(role: .pauseAll, title: zh ? "暂停所有对话" : "Pause All Conversations")) }
	if paused > 0 { lines.append(.init(role: .resumeAll, title: zh ? "继续所有已暂停的对话" : "Resume All Paused Conversations")) }
	if !quota.isEmpty {
		lines.append(StatusLine(role: .separator, title: ""))
		lines += quota.map { StatusLine(role: .info, title: $0) }
	}
	lines.append(StatusLine(role: .separator, title: ""))
	lines.append(StatusLine(role: .quit, title: zh ? "退出 \(appName)" : "Quit \(appName)"))
	return lines
}

/// What the icon says beside itself: how many are waiting for the person, conversations at a dialog and open unattended
/// questions together (the rest is in the menu), and a ✓ when a run finished since they last looked (`finished`: how many).
func statusTitle(asking: Int, questions: Int = 0, finished: Int = 0) -> String {
	var parts: [String] = []
	if asking + questions > 0 { parts.append("\(asking + questions)") }
	if finished > 0 { parts.append("✓") }
	return parts.isEmpty ? "" : " " + parts.joined(separator: " ")
}

/// The icon: a prompt (`>_`) in a rounded box, drawn as a template image, so that the menu bar colours it for a light or a dark bar.
func statusIcon() -> NSImage {
	let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
		NSColor.black.setStroke()
		let box = NSBezierPath(roundedRect: rect.insetBy(dx: 1.5, dy: 2.5), xRadius: 3.5, yRadius: 3.5)
		box.lineWidth = 1.4
		box.stroke()
		let chevron = NSBezierPath()
		chevron.move(to: NSPoint(x: 5.5, y: 11.5))
		chevron.line(to: NSPoint(x: 8.5, y: 9))
		chevron.line(to: NSPoint(x: 5.5, y: 6.5))
		chevron.lineWidth = 1.4
		chevron.lineCapStyle = .round
		chevron.lineJoinStyle = .round
		chevron.stroke()
		let cursor = NSBezierPath()
		cursor.move(to: NSPoint(x: 10.5, y: 6.5))
		cursor.line(to: NSPoint(x: 13, y: 6.5))
		cursor.lineWidth = 1.4
		cursor.lineCapStyle = .round
		cursor.stroke()
		return true
	}
	image.isTemplate = true
	image.accessibilityDescription = appName
	return image
}

/// The app's icon in the menu bar: there when `install`ed, gone when `remove`d. It is there while the app runs in the
/// background, and beside its window too unless Settings says otherwise (`BackgroundMode.showAlways`).
final class StatusMenu: NSObject, NSMenuDelegate {
	private let language: () -> ShellLanguage
	private let actions: [StatusLine.Role: () -> Void]
	private let opening: () -> Void
	private var item: NSStatusItem?
	private var state = ShellState()
	private var quota: [String] = []
	private var watch = FinishedWatch()
	/// The runs the menu that is open said had finished: the person has seen them by opening it (`menuNeedsUpdate`), and the
	/// menu keeps saying so until it closes, whatever the stream says meanwhile. Nil while no menu is open.
	private var shownFinished: Int?

	/// `opening`: the menu is about to open (the quota is read again, when it is old: `update(quota:)` puts it in). `questions`:
	/// the line "N questions waiting" is chosen (the window opens on the Questions page).
	init(
		language: @escaping () -> ShellLanguage, open: @escaping () -> Void, quit: @escaping () -> Void,
		pauseAll: @escaping () -> Void = {}, resumeAll: @escaping () -> Void = {}, opening: @escaping () -> Void = {},
		questions: @escaping () -> Void = {}
	) {
		self.language = language
		actions = [.open: open, .quit: quit, .pauseAll: pauseAll, .resumeAll: resumeAll, .questions: questions]
		self.opening = opening
	}

	var isInstalled: Bool { item != nil }

	/// The menu as it is when it opens: the lines it holds, in order (a separator is an empty one).
	var titles: [String] { item?.menu?.items.map { $0.isSeparatorItem ? "" : $0.title } ?? [] }

	/// What the icon shows beside itself.
	var buttonTitle: String? { item?.button?.title }

	func install() {
		guard item == nil else { return }
		let made = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
		made.button?.image = statusIcon()
		made.button?.imagePosition = .imageLeading
		made.button?.toolTip = appName
		let menu = NSMenu()
		menu.delegate = self
		made.menu = menu
		item = made
		render()
	}

	func remove() {
		guard let item else { return }
		NSStatusBar.system.removeStatusItem(item)
		self.item = nil
	}

	/// The counts, from the server's stream: shown the next time the menu opens (and by the icon's own title now). `epoch`: the
	/// server's run that said it (a new one starts what the person has seen of finished runs over).
	func update(_ state: ShellState, epoch: String? = nil) {
		self.state = state
		watch.hear(finished: state.finished, epoch: epoch)
		render()
	}

	/// The person looks: the app became the active one, its window is in front. Runs that finished so far are seen.
	func look() {
		watch.look()
		render()
	}

	/// What is left of each provider's quota, in words (`GET /api/shell/quota`): shown now, also in a menu that is open.
	func update(quota: [String]) {
		self.quota = quota
		render()
	}

	/// The menu is built when it opens, in the language of the moment (the person may have changed it while the app was away). It
	/// says which runs finished since the person last looked, and that is looking.
	func menuNeedsUpdate(_ menu: NSMenu) {
		shownFinished = watch.unseen
		watch.look()
		render()
		opening()
	}

	/// Not rebuilt here: AppKit closes the menu before it performs the action of the line that was chosen, and a line that is gone
	/// does nothing. The next time it opens it is built again (`menuNeedsUpdate`).
	func menuDidClose(_ menu: NSMenu) {
		shownFinished = nil
	}

	/// What a click on a line does (also what a test does for a click).
	func choose(_ role: StatusLine.Role) {
		actions[role]?()
	}

	@objc private func chosen(_ sender: NSMenuItem) {
		if let role = StatusLine.Role(rawValue: sender.tag) { choose(role) }
	}

	private func render() {
		guard let item, let menu = item.menu else { return }
		item.button?.title = statusTitle(asking: state.asking, questions: state.questions, finished: watch.unseen)
		menu.removeAllItems()
		let finished = (shownFinished ?? 0) + watch.unseen
		for line in statusMenu(state: state, quota: quota, language: language(), unseenFinished: finished) {
			switch line.role {
			case .separator: menu.addItem(.separator())
			case .info:
				let info = NSMenuItem(title: line.title, action: nil, keyEquivalent: "")
				info.isEnabled = false
				menu.addItem(info)
			case .open, .pauseAll, .resumeAll, .quit, .questions:
				let entry = NSMenuItem(title: line.title, action: #selector(chosen(_:)), keyEquivalent: "")
				entry.target = self
				entry.tag = line.role.rawValue
				menu.addItem(entry)
			}
		}
	}
}

// MARK: - Running without a window

/// What the app is while it runs in the background: not a regular app (`.accessory`), kept from being napped by macOS, with its
/// menu bar icon. The window itself is `MainWindow`'s, closed by whoever puts the app here and opened again, after `leave`, by
/// whoever brings it back. The icon is also there beside the window while Settings says so (`showAlways`, on by default).
final class BackgroundMode {
	let status: StatusMenu
	private let handoff: ScreenHandoff
	private var activity: NSObjectProtocol?
	private(set) var isActive = false
	/// Whether the icon stays while the app has its window (Settings › Quitting, `ompw.menuIcon`). Off until the server says:
	/// an app whose server is not up yet has nothing for the menu to say.
	private(set) var alwaysShown = false

	init(status: StatusMenu, handoff: ScreenHandoff = ScreenHandoff()) {
		self.status = status
		self.handoff = handoff
	}

	/// The icon is wanted beside the window too, or only in the background: shown or taken away now, unless the app is in the
	/// background (it always has the icon there: it is the way back).
	func showAlways(_ on: Bool) {
		alwaysShown = on
		guard !isActive else { return }
		if on { status.install() } else { status.remove() }
	}

	/// The app is put in the background: `closing` closes its window and its page, once the app counts as being in the background
	/// (closing the last window must not end it: `applicationShouldTerminateAfterLastWindowClosed`). macOS naps an app that is out
	/// of sight (its own timers slow down); this one waits for conversations and tells of them, so it asks not to be napped, and
	/// the Mac may still sleep.
	func enter(closing: () -> Void) {
		guard !isActive else { return }
		isActive = true
		closing()
		activity = ProcessInfo.processInfo.beginActivity(
			options: .userInitiatedAllowingIdleSystemSleep, reason: "\(appName) runs in the background")
		NSApp.setActivationPolicy(.accessory)
		status.install()
		handoff.yield()
	}

	/// The app is a regular one again; the caller opens its window.
	func leave() {
		guard isActive else { return }
		isActive = false
		if !alwaysShown { status.remove() }
		if let activity { ProcessInfo.processInfo.endActivity(activity) }
		activity = nil
		NSApp.setActivationPolicy(.regular)
	}

	/// A question the app asked while it had no window (a Quit from the menu bar icon) is answered with a no: the screen goes
	/// back to the app that had it.
	@discardableResult
	func yieldScreen() -> ScreenYield { handoff.yield() }
}
