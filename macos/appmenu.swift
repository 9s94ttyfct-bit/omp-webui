import AppKit

/// The app's menu bar. `reload`: the app's Reload command (it goes to the app's delegate, the end of the responder chain);
/// `macs`: the Macs menu, between View and Window (macOS 14 and later; nil before it).
///
/// The View menu has no zoom: the page is never zoomed in the app (see `prepareWebView`), so ⌘= ⌘- ⌘0 are no command
/// here and reach the page as the keystrokes they are. Full screen and the Window menu are the window's, not the page's.
func appMainMenu(appName: String, reload: Selector, macs: NSMenuItem?) -> NSMenu {
	let main = NSMenu()
	func submenu(_ title: String, _ items: [NSMenuItem]) {
		let item = NSMenuItem()
		let menu = NSMenu(title: title)
		items.forEach(menu.addItem)
		item.submenu = menu
		main.addItem(item)
	}
	func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
		let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
		i.keyEquivalentModifierMask = mods
		return i
	}
	submenu(appName, [
		item("About \(appName)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
		.separator(),
		item("Hide \(appName)", #selector(NSApplication.hide(_:)), "h"),
		item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
		item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
		.separator(),
		item("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"),
	])
	// Standard editing commands: WebKit text fields need these for ⌘C / ⌘V / ⌘Z.
	submenu("Edit", [
		item("Undo", Selector(("undo:")), "z"),
		item("Redo", Selector(("redo:")), "z", [.command, .shift]),
		.separator(),
		item("Cut", #selector(NSText.cut(_:)), "x"),
		item("Copy", #selector(NSText.copy(_:)), "c"),
		item("Paste", #selector(NSText.paste(_:)), "v"),
		item("Select All", #selector(NSText.selectAll(_:)), "a"),
	])
	submenu("View", [
		item("Reload", reload, "r"),
		.separator(),
		item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
	])
	if let macs { main.addItem(macs) }
	submenu("Window", [
		item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
		item("Close", #selector(NSWindow.performClose(_:)), "w"),
	])
	return main
}
