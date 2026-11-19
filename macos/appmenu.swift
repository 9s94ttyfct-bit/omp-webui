import AppKit

/// The item of the menu bar that holds the Window menu, whatever its title is in the app's language.
let windowMenuIdentifier = NSUserInterfaceItemIdentifier("window")

/// The words of the app's menu bar, in the language of the page (#232): what macOS itself says in each.
struct MenuWords {
	let language: ShellLanguage
	init(_ language: ShellLanguage) { self.language = language }
	private func pick(_ en: String, _ zh: String) -> String { language == .zh ? zh : en }

	func about(_ app: String) -> String { pick("About \(app)", "关于 \(app)") }
	func hide(_ app: String) -> String { pick("Hide \(app)", "隐藏 \(app)") }
	var hideOthers: String { pick("Hide Others", "隐藏其他") }
	var showAll: String { pick("Show All", "全部显示") }
	func quit(_ app: String) -> String { pick("Quit \(app)", "退出 \(app)") }
	var edit: String { pick("Edit", "编辑") }
	var undo: String { pick("Undo", "撤销") }
	var redo: String { pick("Redo", "重做") }
	var cut: String { pick("Cut", "剪切") }
	var copy: String { pick("Copy", "拷贝") }
	var paste: String { pick("Paste", "粘贴") }
	var selectAll: String { pick("Select All", "全选") }
	var view: String { pick("View", "显示") }
	var reload: String { pick("Reload", "重新载入") }
	var enterFullScreen: String { pick("Enter Full Screen", "进入全屏幕") }
	var window: String { pick("Window", "窗口") }
	var minimize: String { pick("Minimize", "最小化") }
	var close: String { pick("Close", "关闭") }
}

/// The app's menu bar, in `language`. `reload`: the app's Reload command (it goes to the app's delegate, the end of the
/// responder chain); `macs`: the Macs menu, between View and Window (macOS 14 and later; nil before it).
///
/// The View menu has no zoom: the page is never zoomed in the app (see `prepareWebView`), so ⌘= ⌘- ⌘0 are no command
/// here and reach the page as the keystrokes they are. Full screen and the Window menu are the window's, not the page's.
func appMainMenu(appName: String, reload: Selector, macs: NSMenuItem?, language: ShellLanguage) -> NSMenu {
	let w = MenuWords(language)
	let main = NSMenu()
	func submenu(_ title: String, _ items: [NSMenuItem], id: NSUserInterfaceItemIdentifier? = nil) {
		let item = NSMenuItem()
		item.identifier = id
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
		item(w.about(appName), #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
		.separator(),
		item(w.hide(appName), #selector(NSApplication.hide(_:)), "h"),
		item(w.hideOthers, #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
		item(w.showAll, #selector(NSApplication.unhideAllApplications(_:)), ""),
		.separator(),
		item(w.quit(appName), #selector(NSApplication.terminate(_:)), "q"),
	])
	// Standard editing commands: WebKit text fields need these for ⌘C / ⌘V / ⌘Z.
	submenu(w.edit, [
		item(w.undo, Selector(("undo:")), "z"),
		item(w.redo, Selector(("redo:")), "z", [.command, .shift]),
		.separator(),
		item(w.cut, #selector(NSText.cut(_:)), "x"),
		item(w.copy, #selector(NSText.copy(_:)), "c"),
		item(w.paste, #selector(NSText.paste(_:)), "v"),
		item(w.selectAll, #selector(NSText.selectAll(_:)), "a"),
	])
	submenu(w.view, [
		item(w.reload, reload, "r"),
		.separator(),
		item(w.enterFullScreen, #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
	])
	if let macs { main.addItem(macs) }
	submenu(w.window, [
		item(w.minimize, #selector(NSWindow.performMiniaturize(_:)), "m"),
		item(w.close, #selector(NSWindow.performClose(_:)), "w"),
	], id: windowMenuIdentifier)
	return main
}
