import AppKit
import WebKit

// The list of other Macs in the app (#614, the switcher #628): the Macs menu, the sheets that add one and manage them, the
// windows that are open (one for each Mac, `remotewindow.swift`), and the bridge that lets the page's own switcher open one.
// The list belongs to the local server, which is its only writer: the menu reads the file it keeps as it is now (so it works
// while the server is down and costs the web UI nothing), and a change (add, rename, forget, the time of the last connection,
// the team of the sign-in) is a request to the server (`RemoteMacsClient`), which says no when it is not up. What is deleted
// here is this Mac's own: the saved sign-ins, in the data stores of the windows. Everything is worded in the language the app's
// other native words are in (`ShellLanguage`).
//
// A Mac's window needs macOS 14 (its data store); before it the menu is not there at all.

/// Why forgetting a Mac did not finish.
enum ForgetFailure: Error {
	/// The server did not take the Mac out of the list: nothing was changed.
	case server(MacsServerError)
	/// The Mac is out of the list, and its saved sign-in could not be deleted.
	case store(Error)
}

@available(macOS 14.0, *)
final class RemoteMacsController: NSObject, NSMenuDelegate, NSMenuItemValidation {
	let store: RemoteMacStore
	let client: RemoteMacsClient
	let language: () -> ShellLanguage
	/// Ask the local server for the page's saved language again (the menu is opened rarely, and the answer is used the next time).
	private let refreshLanguage: () -> Void
	let menuItem = NSMenuItem()
	private let menu = NSMenu(title: "Macs")
	/// The Macs that have a window open, one session for each.
	private(set) var sessions: [UUID: RemoteMacSession] = [:]
	/// A sheet is up, or an added Mac is on its way from the server: no other sheet is opened over it.
	private var busy = false
	/// The app's notifications (nil in a test: there are none to show), and the Macs that the person turned them on for.
	private let notifications: NotificationBridge?
	private let choices: RemoteNotifyChoices
	/// Reads the notices of the Macs that are turned on (`remotenotify.swift`), for as long as the app runs.
	private var notifier: RemoteNotifier?

	/// `server`: where the app's own server is and the token that signs in (nil while it is not up). `notifications`: what shows the
	/// notifications of other Macs' conversations; none, no Mac is read and the menu has no such choice.
	init(
		directory: URL, server: @escaping () -> (origin: URL, token: String)?, language: @escaping () -> ShellLanguage,
		refreshLanguage: @escaping () -> Void, notifications: NotificationBridge? = nil,
		choices: RemoteNotifyChoices = DefaultsRemoteNotifyChoices()
	) {
		store = RemoteMacStore(directory: directory)
		client = RemoteMacsClient(server: server)
		self.language = language
		self.refreshLanguage = refreshLanguage
		self.notifications = notifications
		self.choices = choices
		super.init()
		menu.delegate = self
		menu.autoenablesItems = true
		menuItem.title = RemoteWords(language()).menuTitle
		menuItem.submenu = menu
		if let notifications {
			notifier = RemoteNotifier(
				choices: choices, macs: { [unowned self] in self.store.list.macs }, language: language,
				hear: { [unowned self] id, message in self.hear(id, message) })
			notifications.onRemoteClick = { [unowned self] id, event in self.openConversation(of: id, event) }
			notifier?.sync()
		}
	}

	var words: RemoteWords { RemoteWords(language()) }

	// MARK: Menu

	func menuNeedsUpdate(_ menu: NSMenu) {
		refreshLanguage()
		let w = words
		menu.removeAllItems()
		let macs = store.list.macs
		if macs.isEmpty {
			let none = NSMenuItem(title: w.noMacs, action: nil, keyEquivalent: "")
			none.isEnabled = false
			menu.addItem(none)
		}
		for mac in macs {
			let item = NSMenuItem(title: mac.name, action: #selector(openMac(_:)), keyEquivalent: "")
			item.target = self
			item.representedObject = mac.id
			item.toolTip = mac.host
			// A tick for the Macs that have a window open.
			item.state = sessions[mac.id] == nil ? .off : .on
			menu.addItem(item)
		}
		// What the person turned notifications on for: a tick for each, their own choice, off until made.
		if notifier != nil, !macs.isEmpty {
			menu.addItem(.separator())
			let heading = NSMenuItem(title: w.notifyHeading, action: nil, keyEquivalent: "")
			heading.isEnabled = false
			menu.addItem(heading)
			for mac in macs {
				let item = NSMenuItem(title: mac.name, action: #selector(toggleNotify(_:)), keyEquivalent: "")
				item.target = self
				item.representedObject = mac.id
				item.indentationLevel = 1
				item.toolTip = w.notifyTip(mac.host)
				item.state = choices.isOn(mac.id) ? .on : .off
				menu.addItem(item)
			}
		}
		menu.addItem(.separator())
		for (title, action) in [(w.addMac, #selector(addMac)), (w.manageMacs, #selector(manageMacs))] {
			let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
			item.target = self
			menu.addItem(item)
		}
	}

	func validateMenuItem(_ item: NSMenuItem) -> Bool {
		if item.action == #selector(manageMacs) { return !store.list.macs.isEmpty }
		return true
	}

	@objc private func openMac(_ sender: NSMenuItem) {
		guard let id = sender.representedObject as? UUID else { return }
		open(id)
	}

	// MARK: Windows

	/// The Mac's window: in front if it is open, made if not. False when the list has no such Mac.
	@discardableResult
	func open(_ id: UUID) -> Bool {
		guard let mac = store.list.mac(id: id) else { return false }
		if let session = sessions[id] {
			session.bringForward()
			return true
		}
		let session = RemoteMacSession(mac: mac, language: language, owner: self)
		sessions[id] = session
		session.start { [weak self] opened in
			guard !opened, let self else { return }
			self.sessions[id] = nil
			self.alert(self.words.cannotOpen, self.words.cannotProtect)
		}
		return true
	}

	/// Every window of every Mac goes (Run in Background, quit): they belong to the other Macs, whose conversations run on there.
	func closeAll() {
		for session in Array(sessions.values) { session.disconnect() }
	}

	func sessionEnded(_ id: UUID) { sessions[id] = nil }

	/// A window of this Mac was signed in. The server keeps the time; when it is not up this is lost, and the next connection
	/// says it again.
	func connected(_ id: UUID) {
		client.connected(id: id)
		// What the notifications of this Mac were read with may be a sign-in that has run out: this one is read at once.
		notifier?.reconnect(id)
	}

	/// The team of the sign-in of a window was seen. The server keeps the first one it is told; a failure is not said (the next
	/// window of this Mac says it again).
	func pinned(_ id: UUID, team: String) { client.pin(id: id, team: team) }

	// MARK: Notifications

	/// The menu's tick for a Mac: notifications of its conversations, on or off. Turning them on asks macOS to allow them (a prompt the
	/// first time) and says where to look when it does not; a Mac whose window was never signed in is opened for the sign-in, which is
	/// what its notices are read with.
	@objc private func toggleNotify(_ sender: NSMenuItem) {
		guard let id = sender.representedObject as? UUID, let mac = store.list.mac(id: id), let notifications else { return }
		if choices.isOn(id) {
			choices.set(id, on: false)
			notifier?.sync()
			return
		}
		notifications.requestPermission { [weak self] allowed in
			guard let self else { return }
			guard allowed == "granted" else {
				return self.alert(self.words.notifyTitle, allowed == "unsupported" ? self.words.notifyUnsupported : self.words.notifyBlocked)
			}
			self.choices.set(id, on: true)
			self.notifier?.sync()
			if mac.lastConnected == nil { self.open(id) }
		}
	}

	/// A Mac's stream says something: a conversation of it needs the person, or finished. Not while somebody is looking at it, in a
	/// window of that Mac that is in use (`RemoteMacSession.isLooked`).
	private func hear(_ id: UUID, _ message: ShellMessage) {
		guard case .attention(let banner, _) = message, choices.isOn(id), let mac = store.list.mac(id: id), let notifications else { return }
		notifications.present(banner.onMac(mac), watching: sessions[id]?.isLooked(at: banner) ?? false)
	}

	/// A click on a notification of a Mac's conversation: that Mac's window comes forward (or opens) and its page opens the conversation.
	private func openConversation(of id: UUID, _ event: [String: Any]) {
		guard open(id) else { return }
		sessions[id]?.hand(event)
	}

	// MARK: Add

	@objc private func addMac() { presentAdd() }

	/// The sheet that adds a Mac: the Macs menu's Add Mac…, and the page's own switcher (`MacsBridge`). The Mac is looked at (the
	/// probe), then the server adds it, then its window opens.
	func presentAdd() {
		guard !busy else { return }
		let list = store.list
		// Ten is the most: said before anything is typed.
		guard list.macs.count < RemoteMacList.limit else { return alert(words.addTitle, words.problem(.full)) }
		busy = true
		guard let added = AddMacDialog(words: words, list: list).run() else {
			busy = false
			return
		}
		client.add(name: added.name, address: added.host, team: added.team) { [weak self] result in
			guard let self else { return }
			self.busy = false
			switch result {
			case .success(let mac): self.open(mac.id)
			case .failure(let error):
				// What went wrong in the list as it is now (somebody else added the name meanwhile) is said in the app's words.
				var problem: RemoteMacProblem?
				if case .failure(let found) = self.store.list.checkNew(name: added.name, address: added.host) { problem = found }
				self.alert(self.words.addTitle, self.explain(error, problem: problem, because: self.words.cannotSave))
			}
		}
	}

	/// What to say when the server did not make a change: that it is not running; else what is wrong in the app's own words when
	/// its own checks find it (`problem`), else the server's words after `summary`.
	func explain(_ error: MacsServerError, problem: RemoteMacProblem?, because summary: String) -> String {
		switch error {
		case .unreachable: return words.serverDown
		case .refused(_, let message): return problem.map { words.problem($0) } ?? "\(summary): \(message)"
		}
	}

	// MARK: Manage

	@objc private func manageMacs() {
		guard !busy else { return }
		busy = true
		ManageMacsDialog(controller: self).run()
		busy = false
	}

	/// Close the windows of the Mac and of every Mac that shares its sign-in, and delete that sign-in (its data store: the Macs
	/// of one Cloudflare team share one, so signing out of one signs out of all of them), keeping them in the list. `done` gets
	/// the names of the other Macs that were signed out with it.
	func signOut(_ mac: RemoteMac, done: @escaping ([String]) -> Void) {
		let sharing = store.list.macs.filter { $0.id != mac.id && $0.storeIdentifier == mac.storeIdentifier }
		for other in sharing + [mac] {
			sessions[other.id]?.disconnect()
			// What its notices are read with is the sign-in that goes: nothing is read from a Mac that is signed out.
			choices.set(other.id, on: false)
		}
		notifier?.sync()
		let names = sharing.map(\.name)
		WKWebsiteDataStore(forIdentifier: mac.storeIdentifier).removeData(
			ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast
		) {
			DispatchQueue.main.async {
				// A window that was open when the team became known still has the Mac's own store, which holds its sign-in.
				guard mac.storeId != mac.storeIdentifier else { return done(names) }
				WKWebsiteDataStore.fetchAllDataStoreIdentifiers { stores in
					DispatchQueue.main.async {
						guard stores.contains(mac.storeId) else { return done(names) }
						WKWebsiteDataStore(forIdentifier: mac.storeId).removeData(
							ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast
						) { DispatchQueue.main.async { done(names) } }
					}
				}
			}
		}
	}

	/// Take the Mac out of the list, which the server does (while it cannot, nothing is changed and nothing is closed), then close
	/// its windows and delete the data stores no other Mac uses: its team's is kept while another Mac of that team is listed, and
	/// the one it had before its team was known goes too. A store cannot go while a web view still holds it, which a window that
	/// has just closed may for a moment: it is tried again a few times. A team's store that stays still holds what this Mac put in
	/// it (its cookies, which are its sign-in, and its page storage): that is deleted from it (`removeOriginData`), so that adding
	/// the Mac again later does not find it signed in.
	func forget(_ mac: RemoteMac, done: @escaping (Result<Void, ForgetFailure>) -> Void) {
		client.remove(id: mac.id) { [weak self] result in
			guard let self else { return }
			switch result {
			case .success, .failure(.refused(status: 404, _)):
				// A Mac that the server no longer lists (forgotten from the page meanwhile) is as good as forgotten.
				break
			case .failure(let error): return done(.failure(.server(error)))
			}
			self.sessions[mac.id]?.disconnect()
			self.choices.set(mac.id, on: false)
			self.notifier?.sync()
			let remaining = self.store.list.macs.filter { $0.id != mac.id }
			let removing = storesToRemove(forgetting: mac, remaining: remaining)
			self.removeStores(removing) { error in
				if let error { return done(.failure(.store(error))) }
				// The store the Mac shares with others stays: what it put in it does not.
				guard !removing.contains(mac.storeIdentifier) else { return done(.success(())) }
				WKWebsiteDataStore.fetchAllDataStoreIdentifiers { ids in
					DispatchQueue.main.async {
						// A Mac that was never opened has put nothing anywhere.
						guard ids.contains(mac.storeIdentifier) else { return done(.success(())) }
						removeOriginData(of: mac, remaining: remaining, from: WKWebsiteDataStore(forIdentifier: mac.storeIdentifier)) {
							done(.success(()))
						}
					}
				}
			}
		}
	}

	private func removeStores(_ ids: [UUID], done: @escaping (Error?) -> Void) {
		guard let id = ids.first else { return done(nil) }
		removeStore(id, attempts: 6) { [weak self] error in
			if let error { return done(error) }
			self?.removeStores(Array(ids.dropFirst()), done: done)
		}
	}

	private func removeStore(_ id: UUID, attempts: Int, done: @escaping (Error?) -> Void) {
		WKWebsiteDataStore.fetchAllDataStoreIdentifiers { [weak self] ids in
			DispatchQueue.main.async {
				// A Mac that was never opened has no store.
				guard ids.contains(id) else { return done(nil) }
				WKWebsiteDataStore.remove(forIdentifier: id) { error in
					DispatchQueue.main.async {
						if error != nil, attempts > 1, let self {
							DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
								self.removeStore(id, attempts: attempts - 1, done: done)
							}
						} else {
							done(error)
						}
					}
				}
			}
		}
	}

	func alert(_ title: String, _ detail: String) {
		NSApp.activate(ignoringOtherApps: true)
		let alert = NSAlert()
		alert.alertStyle = .warning
		alert.messageText = title
		alert.informativeText = detail
		alert.addButton(withTitle: words.ok)
		alert.runModal()
	}
}

/// What a forgotten Mac put in a data store that stays, because another Mac of its team still uses it (`storesToRemove`): its
/// cookies (the Access cookie of the Mac's host and the access-token cookie its server set: its sign-in) by host, which a cookie store can tell apart,
/// and the page storage records no Mac that is left shares (`recordsToRemove`: WebKit names a record by registrable domain, so
/// `a.example.com`'s storage cannot be cut from `b.example.com`'s while both are listed; it goes with the last of them). Cookies
/// for a parent domain stay (the others may use them), and so does the team's own Access sign-in, which is another site's.
/// `done` is called on the main queue.
func removeOriginData(of mac: RemoteMac, remaining: [RemoteMac], from store: WKWebsiteDataStore, done: @escaping () -> Void) {
	store.httpCookieStore.getAllCookies { cookies in
		DispatchQueue.main.async {
			let group = DispatchGroup()
			for cookie in cookies where cookieIsOwn(domain: cookie.domain, host: mac.host) {
				group.enter()
				store.httpCookieStore.delete(cookie) { group.leave() }
			}
			group.notify(queue: .main) {
				let types = WKWebsiteDataStore.allWebsiteDataTypes()
				store.fetchDataRecords(ofTypes: types) { records in
					DispatchQueue.main.async {
						let names = Set(recordsToRemove(forgetting: mac, remaining: remaining, recordNames: records.map(\.displayName)))
						let own = records.filter { names.contains($0.displayName) }
						guard !own.isEmpty else { return done() }
						store.removeData(ofTypes: types, for: own) { DispatchQueue.main.async { done() } }
					}
				}
			}
		}
	}
}

// MARK: - The sheets

/// A text field of the sheets: a plain one-line field of the width of the sheet.
private func field(_ frame: NSRect, placeholder: String, delegate: NSTextFieldDelegate?) -> NSTextField {
	let field = NSTextField(frame: frame)
	field.placeholderString = placeholder
	field.isEditable = true
	field.usesSingleLineMode = true
	field.lineBreakMode = .byTruncatingTail
	field.delegate = delegate
	return field
}

private func caption(_ text: String, _ frame: NSRect) -> NSTextField {
	let label = NSTextField(labelWithString: text)
	label.frame = frame
	label.alignment = .right
	label.textColor = .secondaryLabelColor
	return label
}

/// "Add a Mac": a name and an address, looked at before they are saved. Return adds (looking first); Check only looks. A Mac
/// that Access answers for is added at once; anything else is said and needs a second press (Add Anyway), since it may only be
/// asleep, or not yet behind Access.
@available(macOS 14.0, *)
private final class AddMacDialog: NSObject, NSTextFieldDelegate {
	struct Added {
		let name: String
		let host: String
		let team: String?
	}

	private let words: RemoteWords
	private let list: RemoteMacList
	private let alert = NSAlert()
	private let nameField: NSTextField
	private let addressField: NSTextField
	private let status = NSTextField(wrappingLabelWithString: "")
	private let addButton: NSButton
	private let checkButton: NSButton
	private var probing = false
	private var running = false
	private var checked: (host: String, result: ProbeResult)?
	private var added: Added?

	init(words: RemoteWords, list: RemoteMacList) {
		self.words = words
		self.list = list
		let width: CGFloat = 380
		let view = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 130))
		nameField = field(NSRect(x: 80, y: 102, width: width - 80, height: 24), placeholder: words.namePlaceholder, delegate: nil)
		addressField = field(NSRect(x: 80, y: 70, width: width - 80, height: 24), placeholder: words.addressPlaceholder, delegate: nil)
		status.frame = NSRect(x: 80, y: 0, width: width - 80, height: 62)
		status.font = NSFont.systemFont(ofSize: 11)
		status.textColor = .secondaryLabelColor
		for subview in [
			caption(words.nameLabel, NSRect(x: 0, y: 105, width: 72, height: 18)),
			caption(words.addressLabel, NSRect(x: 0, y: 73, width: 72, height: 18)), nameField, addressField, status,
		] as [NSView] { view.addSubview(subview) }
		alert.messageText = words.addTitle
		alert.informativeText = words.addDetail
		alert.alertStyle = .informational
		alert.accessoryView = view
		addButton = alert.addButton(withTitle: words.add)
		checkButton = alert.addButton(withTitle: words.check)
		let cancel = alert.addButton(withTitle: words.cancel)
		// Escape cancels in either language: AppKit only gives it to a button titled "Cancel".
		cancel.keyEquivalent = "\u{1b}"
		super.init()
		nameField.delegate = self
		addressField.delegate = self
		// These two do not close the sheet: they look, and close it themselves once there is something to add.
		addButton.target = self
		addButton.action = #selector(addPressed)
		checkButton.target = self
		checkButton.action = #selector(checkPressed)
	}

	func run() -> Added? {
		NSApp.activate(ignoringOtherApps: true)
		alert.layout()
		alert.window.initialFirstResponder = nameField
		running = true
		_ = alert.runModal()
		running = false
		alert.window.orderOut(nil)
		return added
	}

	/// Anything typed means what was looked at is no longer what is typed.
	func controlTextDidChange(_ notification: Notification) {
		checked = nil
		addButton.title = words.add
		status.stringValue = ""
	}

	private func show(_ text: String, problem: Bool = false) {
		status.stringValue = text
		status.textColor = problem ? .systemRed : .secondaryLabelColor
	}

	@objc private func addPressed() {
		guard !probing else { return }
		switch list.checkNew(name: nameField.stringValue, address: addressField.stringValue) {
		case .failure(let problem):
			show(words.problem(problem), problem: true)
		case .success(let ok):
			if let checked, checked.host == ok.host { return accept(ok.name, ok.host, checked.result) }
			look(at: ok.host) { [weak self] result in
				guard let self else { return }
				if case .access = result { return self.accept(ok.name, ok.host, result) }
				self.addButton.title = self.words.addAnyway
			}
		}
	}

	@objc private func checkPressed() {
		guard !probing else { return }
		switch parseRemoteAddress(addressField.stringValue) {
		case .failure(let problem): show(words.problem(.address(problem)), problem: true)
		case .success(let host):
			look(at: host) { [weak self] result in
				guard let self else { return }
				if case .access = result { return }
				self.addButton.title = self.words.addAnyway
			}
		}
	}

	private func look(at host: String, then: @escaping (ProbeResult) -> Void) {
		probing = true
		addButton.isEnabled = false
		checkButton.isEnabled = false
		show(words.checking(host))
		RemoteProbe.run(host: host) { [weak self] result in
			guard let self, self.running else { return }
			self.probing = false
			self.addButton.isEnabled = true
			self.checkButton.isEnabled = true
			self.checked = (host, result)
			if case .access = result {
				self.show(self.words.probe(result, host: host))
			} else {
				self.show("\(self.words.probe(result, host: host)) \(self.words.addAnywayNote)", problem: true)
			}
			then(result)
		}
	}

	private func accept(_ name: String, _ host: String, _ result: ProbeResult) {
		var team: String?
		if case .access(let found) = result { team = found }
		added = Added(name: name, host: host, team: team)
		NSApp.stopModal(withCode: .alertFirstButtonReturn)
	}
}

/// "Manage Macs": pick one, rename it, sign out of it (its saved sign-in is deleted, and the other Macs of its Cloudflare team
/// are signed out with it; it stays in the list) or forget it (it goes, with its saved sign-in unless another Mac of its team
/// still uses it). Renaming and forgetting are the server's to do: the buttons wait for it, and say when it is not running.
/// Nothing here touches the other Mac.
@available(macOS 14.0, *)
private final class ManageMacsDialog: NSObject, NSTextFieldDelegate {
	private unowned let controller: RemoteMacsController
	private let words: RemoteWords
	private let alert = NSAlert()
	private let popup = NSPopUpButton(frame: NSRect(x: 80, y: 126, width: 300, height: 26), pullsDown: false)
	private let nameField: NSTextField
	private let addressLine = NSTextField(labelWithString: "")
	private let teamLine = NSTextField(labelWithString: "")
	private let connectedLine = NSTextField(labelWithString: "")
	private let note = NSTextField(wrappingLabelWithString: "")
	private let buttons: [NSButton]
	/// The Macs the popup shows, in its order: a choice is the Mac that was shown there, whatever the list is by then.
	private var shown: [UUID] = []
	private var selected: UUID?
	private var running = false
	/// A request is out (or a sign-out is under way): nothing can be pressed or typed until it is answered.
	private var waiting = false

	init(controller: RemoteMacsController) {
		self.controller = controller
		words = controller.words
		nameField = field(NSRect(x: 80, y: 94, width: 300, height: 24), placeholder: "", delegate: nil)
		let view = NSView(frame: NSRect(x: 0, y: 0, width: 380, height: 214))
		for (line, y) in [(addressLine, 66), (teamLine, 46), (connectedLine, 26)] as [(NSTextField, CGFloat)] {
			line.frame = NSRect(x: 80, y: y, width: 300, height: 18)
			line.textColor = .secondaryLabelColor
			line.lineBreakMode = .byTruncatingMiddle
			view.addSubview(line)
		}
		note.frame = NSRect(x: 80, y: 0, width: 300, height: 22)
		note.font = NSFont.systemFont(ofSize: 11)
		note.textColor = .secondaryLabelColor
		for subview in [
			caption(words.manageTitle, NSRect(x: 0, y: 129, width: 72, height: 18)),
			caption(words.nameLabel, NSRect(x: 0, y: 97, width: 72, height: 18)), popup, nameField, note,
		] as [NSView] { view.addSubview(subview) }
		alert.messageText = words.manageTitle
		alert.informativeText = words.manageDetail
		alert.accessoryView = view
		let done = alert.addButton(withTitle: words.done)
		let signOut = alert.addButton(withTitle: words.signOut)
		let forget = alert.addButton(withTitle: words.forget)
		buttons = [done, signOut, forget]
		super.init()
		nameField.delegate = self
		popup.target = self
		popup.action = #selector(choose)
		for (button, action) in [(done, #selector(donePressed)), (signOut, #selector(signOutPressed)), (forget, #selector(forgetPressed))] {
			button.target = self
			button.action = action
		}
	}

	func run() {
		NSApp.activate(ignoringOtherApps: true)
		alert.layout()
		reload(select: nil)
		guard !controller.store.list.macs.isEmpty else { return }
		running = true
		_ = alert.runModal()
		running = false
		alert.window.orderOut(nil)
	}

	private var current: RemoteMac? { selected.flatMap { controller.store.list.mac(id: $0) } }

	/// Fill the sheet from the list as it is now: the popup, and the lines of the Mac that is chosen.
	private func reload(select id: UUID?) {
		let macs = controller.store.list.macs
		shown = macs.map(\.id)
		popup.removeAllItems()
		for mac in macs { popup.addItem(withTitle: mac.name) }
		guard !macs.isEmpty else {
			selected = nil
			if running { NSApp.stopModal(withCode: .alertFirstButtonReturn) }
			return
		}
		let mac = macs.first { $0.id == (id ?? selected) } ?? macs[0]
		selected = mac.id
		popup.selectItem(at: macs.firstIndex { $0.id == mac.id } ?? 0)
		nameField.stringValue = mac.name
		addressLine.stringValue = words.addressLine(mac.host)
		teamLine.stringValue = words.teamLine(mac.team)
		connectedLine.stringValue = words.lastConnectedLine(mac.lastConnected)
	}

	private func say(_ text: String, problem: Bool = false) {
		note.stringValue = text
		note.textColor = problem ? .systemRed : .secondaryLabelColor
	}

	/// A request is out (or no longer): the buttons, the popup and the name wait for it, and the note says so.
	private func wait(_ on: Bool) {
		waiting = on
		for button in buttons { button.isEnabled = !on }
		popup.isEnabled = !on
		nameField.isEditable = !on
		if on { say(words.working) }
	}

	/// Save the name as typed, when it was changed; `then(true)` once there is nothing to keep or it was kept, `then(false)` (and
	/// said) when it could not be, after the server answered. A name that is plainly not one (empty, taken) is said at once.
	private func commitName(then: @escaping (Bool) -> Void) {
		guard let mac = current, nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) != mac.name else {
			return then(true)
		}
		let typed = nameField.stringValue
		if case .failure(let problem) = controller.store.list.checkRename(id: mac.id, to: typed) {
			say(words.problem(problem), problem: true)
			return then(false)
		}
		wait(true)
		controller.client.rename(id: mac.id, to: typed) { [weak self] result in
			guard let self else { return }
			self.wait(false)
			switch result {
			case .success(let renamed):
				self.controller.sessions[renamed.id]?.renamed(to: renamed.name)
				self.say("")
				then(true)
			case .failure(let error):
				var problem: RemoteMacProblem?
				if case .failure(let found) = self.controller.store.list.checkRename(id: mac.id, to: typed) { problem = found }
				self.say(self.controller.explain(error, problem: problem, because: self.words.cannotSave), problem: true)
				then(false)
			}
		}
	}

	@objc private func choose() {
		let index = popup.indexOfSelectedItem
		guard !waiting, shown.indices.contains(index) else { return }
		let target = shown[index]
		let before = selected
		// What was typed for the Mac that is left is kept first (or the choice goes back).
		commitName { [weak self] kept in
			guard let self else { return }
			guard kept else {
				if let before, let back = self.shown.firstIndex(of: before) { self.popup.selectItem(at: back) }
				return
			}
			self.say("")
			self.reload(select: target)
		}
	}

	@objc private func donePressed() {
		guard !waiting else { return }
		commitName { kept in
			if kept { NSApp.stopModal(withCode: .alertFirstButtonReturn) }
		}
	}

	@objc private func signOutPressed() {
		guard !waiting, let mac = current else { return }
		wait(true)
		controller.signOut(mac) { [weak self] others in
			guard let self else { return }
			self.wait(false)
			self.say(others.isEmpty ? self.words.signedOut(mac.name) : self.words.signedOutShared(mac.name, others: others))
		}
	}

	@objc private func forgetPressed() {
		guard !waiting, let mac = current else { return }
		let confirm = NSAlert()
		confirm.alertStyle = .warning
		confirm.messageText = words.forgetTitle(mac.name)
		confirm.informativeText = words.forgetDetail
		let forget = confirm.addButton(withTitle: words.forgetButton)
		forget.hasDestructiveAction = true
		let cancel = confirm.addButton(withTitle: words.cancel)
		cancel.keyEquivalent = "\u{1b}"
		guard confirm.runModal() == .alertFirstButtonReturn else { return }
		wait(true)
		controller.forget(mac) { [weak self] result in
			guard let self else { return }
			self.wait(false)
			switch result {
			case .success:
				self.say("")
				self.reload(select: nil)
			case .failure(.server(let error)):
				self.say(
					self.controller.explain(error, problem: nil, because: self.words.cannotForget(mac.name)), problem: true)
			case .failure(.store(let error)):
				// The Mac is out of the list; what it had saved is not.
				self.say("\(self.words.forgotButSignInKept(mac.name)): \(error.localizedDescription)", problem: true)
				self.reload(select: nil)
			}
		}
	}
}

// MARK: - The page's switcher

/// Whether a message of a page's handler is one the Macs bridge answers: from the UI's own page, in its main frame (`origin`:
/// nil before the server is up), and one of the two requests (`macsBridgeAction`).
func macsBridgeRequest(isMainFrame: Bool, scheme: String, host: String, port: Int, origin: URL?, body: Any) -> MacsBridgeAction? {
	guard isWindowRequestAllowed(isMainFrame: isMainFrame, scheme: scheme, host: host, port: port, origin: origin) else { return nil }
	return macsBridgeAction(body: body)
}

/// The page's way to the list of Macs (`ompwMacs`, a script message handler that replies): the switcher in the web UI asks the
/// app to open a saved Mac's window, or to show the sheet that adds one. The page names a Mac by its id and never by address, and
/// the app looks the id up in its own list; a remote window never has this handler. The answer is `{ ok: Bool }`: false for a
/// message from anywhere but the UI's own page, a message that is neither request, and an id that is no saved Mac.
final class MacsBridge: NSObject, WKScriptMessageHandlerWithReply {
	static let handlerName = "ompwMacs"

	private let origin: () -> URL?
	/// Open (or bring forward) the Mac's window; false when there is no such Mac.
	private let open: (UUID) -> Bool
	/// Show the sheet that adds a Mac.
	private let add: () -> Void

	init(origin: @escaping () -> URL?, open: @escaping (UUID) -> Bool, add: @escaping () -> Void) {
		self.origin = origin
		self.open = open
		self.add = add
	}

	func userContentController(
		_ controller: WKUserContentController, didReceive message: WKScriptMessage,
		replyHandler: @escaping (Any?, String?) -> Void
	) {
		let sender = message.frameInfo.securityOrigin
		handle(
			isMainFrame: message.frameInfo.isMainFrame, scheme: sender.protocol, host: sender.host, port: sender.port,
			body: message.body, reply: { replyHandler($0, nil) })
	}

	/// What the handler does with a message, apart from the web view's own objects (so that a harness can send one).
	func handle(isMainFrame: Bool, scheme: String, host: String, port: Int, body: Any, reply: @escaping (Any) -> Void) {
		guard
			let action = macsBridgeRequest(
				isMainFrame: isMainFrame, scheme: scheme, host: host, port: port, origin: origin(), body: body)
		else { return reply(["ok": false]) }
		switch action {
		case .open(let id):
			reply(["ok": open(id)])
		case .add:
			// The page's promise is answered before the sheet: the sheet is modal, and runs on the next turn of the main queue.
			reply(["ok": true])
			DispatchQueue.main.async { [add] in add() }
		}
	}
}
