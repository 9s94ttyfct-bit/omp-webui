import Foundation

/// What the window does with a navigation.
enum NavigationVerdict {
	/// The page goes on: its own UI, or an in-page `about:` / `blob:` document.
	case allow
	/// Not this window's to show: the default browser or mail client gets it.
	case openExternally
	/// Never shown, never handed over: a dropped file (`file:`), `data:` and the like would replace the UI, and the
	/// window has no Back button to return from it.
	case cancel
}

/// How to treat a navigation to `url` in a window showing the UI served at `origin` (nil before the server is up).
func navigationVerdict(for url: URL?, origin: URL?) -> NavigationVerdict {
	guard let url else { return .allow }
	let scheme = url.scheme?.lowercased() ?? ""
	if scheme == "about" || scheme == "blob" { return .allow }
	let web = scheme == "http" || scheme == "https"
	if web, let origin, url.host == origin.host, url.port == origin.port { return .allow }
	if web || scheme == "mailto" { return .openExternally }
	return .cancel
}

/// Where a new-window request (`window.open`, a link with `target=_blank`) goes: the address to hand to the system,
/// or nil to ignore the request. It gets the verdict a navigation of the window gets: only what the default browser or
/// mail client should have (an `http(s):` address that is not this UI's own, `mailto:`) is opened. Any other scheme
/// opens some other app (`ssh:`, `vnc:`, `x-apple.systempreferences:`…) or a document (`file:`), and the page's own
/// address would only open the UI again, without its cookie, in a browser: none of that from a link the page was handed.
func externalURL(forNewWindow url: URL?, origin: URL?) -> URL? {
	guard let url, navigationVerdict(for: url, origin: origin) == .openExternally else { return nil }
	return url
}

/// Whether a new-window request is the page asking for a window of its own (see `PopOutWindows`): the UI's own address
/// with the `popout` parameter, `/?popout#/s/<file>/agent/<id>` (`popOutHref` in the web app). Any other address of the
/// UI is still no window: `externalURL` ignores it, and a pop-out shows the UI served at `origin` and nothing else.
func isPopOutRequest(_ url: URL?, origin: URL?) -> Bool {
	guard let url, let origin, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
		url.host == origin.host, url.port == origin.port, url.path == "/" || url.path.isEmpty,
		let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
	else { return false }
	return items.contains { $0.name == "popout" }
}
