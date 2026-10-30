import AppKit

// The size and place of a window, kept across reopenings and launches (#v0.11.18 §5). AppKit's own frame autosave was used
// before (`setFrameAutosaveName("main")`), and it lost the frame: every reopening of the main window (Run in Background, then
// the window again) builds a new NSWindow under the same name, and AppKit refuses a name another live window still holds,
// silently, so that window was neither restored nor saved. The frame is kept here instead, under a key of its own, written
// when the window moves or is resized and read when the next one is made.

/// Where a saved frame may be put back: the frame, when enough of it is on one of the screens there are now (a screen that
/// was unplugged leaves it nowhere), with its title bar on that screen; nil puts the window where it would go the first time.
/// Pure (no AppKit state), so that a test can ask it about screens it makes up.
func restorableFrame(_ saved: NSRect, screens: [NSRect], minSize: NSSize) -> NSRect? {
	guard saved.width >= minSize.width, saved.height >= minSize.height else { return nil }
	for screen in screens {
		let shown = saved.intersection(screen)
		// A quarter of the window on this screen, and its title bar (the top 24 points) where it can be grabbed.
		let titleBar = NSRect(x: saved.minX, y: saved.maxY - 24, width: saved.width, height: 24).intersection(screen)
		if shown.width * shown.height >= saved.width * saved.height / 4, titleBar.width >= 80 { return saved }
	}
	return nil
}

/// The frame a string saved by `WindowFrameMemory` says, or nil when it says none.
func parseSavedFrame(_ text: String?) -> NSRect? {
	guard let text, !text.isEmpty else { return nil }
	let rect = NSRectFromString(text)
	return rect.width > 0 && rect.height > 0 ? rect : nil
}

/// Keeps one window's frame under `key` in the app's defaults.
final class WindowFrameMemory {
	private let key: String
	private let defaults: UserDefaults
	private var watching: [NSObjectProtocol] = []

	init(key: String, defaults: UserDefaults = .standard) {
		self.key = "ompw.windowFrame.\(key)"
		self.defaults = defaults
	}

	deinit { stop() }

	/// Put `window` where the last one was, if that still fits the screens; returns false when it did not (the caller centres
	/// it). `legacyName`: the AppKit autosave name the window used before, read once so that an update keeps the frame.
	@discardableResult
	func restore(_ window: NSWindow, legacyName: String? = nil) -> Bool {
		var saved = parseSavedFrame(defaults.string(forKey: key))
		if saved == nil, let legacyName, let old = defaults.string(forKey: "NSWindow Frame \(legacyName)") {
			// AppKit's format: "x y w h screenX screenY screenW screenH".
			let n = old.split(separator: " ").compactMap { Double($0) }
			if n.count >= 4 { saved = NSRect(x: n[0], y: n[1], width: n[2], height: n[3]) }
		}
		guard let saved,
			let frame = restorableFrame(saved, screens: NSScreen.screens.map(\.visibleFrame), minSize: window.minSize)
		else { return false }
		window.setFrame(frame, display: false)
		return true
	}

	/// The size of the last window saved under this key, if any: for windows that cascade and so keep only their size.
	func savedSize() -> NSSize? {
		parseSavedFrame(defaults.string(forKey: key))?.size
	}

	/// Write the window's frame whenever it moves or is resized, until `stop`. A window in full screen or in the Dock is not
	/// written: the next one opens at the size it had before.
	func follow(_ window: NSWindow) {
		stop()
		let center = NotificationCenter.default
		for name in [NSWindow.didMoveNotification, NSWindow.didResizeNotification, NSWindow.willCloseNotification] {
			watching.append(
				center.addObserver(forName: name, object: window, queue: .main) { [weak self, weak window] _ in
					guard let self, let window else { return }
					self.save(window)
				})
		}
	}

	func save(_ window: NSWindow) {
		guard !window.styleMask.contains(.fullScreen), !window.isMiniaturized else { return }
		defaults.set(NSStringFromRect(window.frame), forKey: key)
	}

	func stop() {
		watching.forEach(NotificationCenter.default.removeObserver)
		watching = []
	}
}
