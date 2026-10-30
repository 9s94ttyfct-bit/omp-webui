import Foundation

// What a window onto another Mac may do and how it is labelled (#614), as plain values and functions: which navigations it
// follows (the page of that Mac, its Cloudflare Access sign-in and the identity provider's pages while signing in), who may
// use its bridges to the app, which requests its web view refuses, the words on the window and in the dialogs. The windows
// (`remotewindow.swift`) and the menu (`remotemenu.swift`) only ask and show, so that all of it runs in a harness
// (tests/support/swift/remote/main.swift) without a window or a network.

// MARK: - What the window follows

/// Where a window is in signing in. `loading`: the Mac's own address has not answered yet. `signingIn`: the page is the Access
/// sign-in (or a page of an identity provider it sent the person to). `connected`: the Mac's own page is up.
enum RemotePhase: Equatable {
	case loading
	case signingIn
	case connected
}

/// The Mac a window shows: its host, and the Cloudflare team its sign-in belongs to once that is known.
struct RemoteSite: Equatable {
	var host: String
	var team: String?
	/// The domain Access serves its sign-in from (`<team>.cloudflareaccess.com`).
	var accessDomain = "cloudflareaccess.com"

	/// Where a window starts: the Mac's own address, https on the default port.
	var url: URL { URL(string: "https://\(host)/")! }
}

enum RemoteVerdict: Equatable {
	/// The Mac's own page, or a document inside the page (`about:`, `blob:`).
	case allow
	/// The sign-in of the Access team: allowed. It is the team the Mac is pinned to; with none pinned yet, this one is.
	case signIn(team: String)
	/// Another https page while signing in: an identity provider the sign-in sent the person to. The bar names the host.
	case signInStep
	/// A link the person clicked, for the default browser (or mail client).
	case openExternally
	/// Never shown and never handed on.
	case cancel
	/// A sign-in of another team than the one this Mac is pinned to (or of one when none was seen before): refused, and said.
	case teamMismatch(host: String)
}

/// The host of a URL as a comparison wants it: lower case, no trailing dot.
private func hostOf(_ url: URL) -> String {
	var host = (url.host ?? "").lowercased()
	if host.hasSuffix(".") { host.removeLast() }
	return host
}

/// What a window onto `site` does with a navigation to `url`. `userInitiated`: the person clicked a link, as far as the app can
/// tell: a real mouse or key event in this window a moment ago (WebKit gives no flag of its own: a page can script a link
/// click, so `linkActivated` alone is not it), and the window hands only one link a second to another app. A page that opens
/// something by itself gets nothing handed to another app, and no link goes outside for an address the blocker refuses (this
/// Mac, its network): the browser has no blocker. `mainFrame` is false for a frame inside the page, which the page's own policy
/// governs and which never opens anything outside the window.
///
/// The one place a person types a password is not this app's, so it is reached only the way Access sends people there: from
/// the Mac's own address, to the team's sign-in; and from the sign-in page once it has been shown (`phase` is `signingIn`
/// only after its page was committed, see `RemoteNavigator`), or along the redirect chain of a sign-in that is on its way
/// (`RemoteNavigator` lets the chain's next address through as a possible redirect), the identity provider that page names.
/// That chain ends at the Mac's own address: the window cannot tell a redirect of the sign-in from one of the Mac's own server
/// right after it, so nothing that follows the Mac's own address is a step of the sign-in. A page of the Mac can send the
/// window to the pinned team's sign-in, which replaces the page, and to nothing else by itself; the bar names the host that
/// has the page.
func remoteNavigationVerdict(
	url: URL?, site: RemoteSite, phase: RemotePhase, userInitiated: Bool, mainFrame: Bool = true
) -> RemoteVerdict {
	guard let url else { return .allow }
	let scheme = url.scheme?.lowercased() ?? ""
	if scheme == "about" || scheme == "blob" { return .allow }
	if !mainFrame { return scheme == "https" || scheme == "data" ? .allow : .cancel }
	if scheme == "mailto" { return userInitiated ? .openExternally : .cancel }
	guard scheme == "https" || scheme == "http" else { return .cancel }
	// An address with a user name or a password says one host and means another: never followed, never handed on.
	if url.user != nil || url.password != nil { return .cancel }
	// A link for the browser: the person's, and not to an address of this Mac or its network.
	let external: RemoteVerdict = userInitiated && !isRemoteBlocked(url) ? .openExternally : .cancel
	// Never a page over http in the window: the person could not tell what is on the wire. A link is for the browser.
	if scheme == "http" { return phase != .signingIn ? external : .cancel }
	let host = hostOf(url)
	let defaultPort = url.port == nil || url.port == 443
	if host == site.host && defaultPort { return .allow }
	let suffix = "." + site.accessDomain
	if host.hasSuffix(suffix) {
		let team = String(host.dropLast(suffix.count))
		guard isTeamName(team), defaultPort else { return .cancel }
		if let pinned = site.team { return team == pinned ? .signIn(team: team) : .teamMismatch(host: host) }
		switch phase {
		case .loading: return .signIn(team: team)
		case .signingIn: return .signInStep
		case .connected: return .teamMismatch(host: host)
		}
	}
	switch phase {
	case .signingIn: return isRemoteBlocked(url) ? .cancel : .signInStep
	case .loading, .connected: return external
	}
}

/// The team of a host of the Access domain (`myteam.cloudflareaccess.com`), when it is one.
private func accessTeam(of host: String, site: RemoteSite) -> String? {
	let suffix = "." + site.accessDomain
	guard host.hasSuffix(suffix) else { return nil }
	let team = String(host.dropLast(suffix.count))
	return isTeamName(team) ? team : nil
}

/// Where the window is once a main-frame page has been committed at `url`: only a page that is really shown moves it, never a
/// navigation that was merely allowed (a page could start one to the team's sign-in and another behind it before it commits).
/// The Mac's own page is `connected`, but not Access's endpoints on its address (`/cdn-cgi/…`: a Mac that is no Cloudflare's can
/// serve anything there, so the phase stays what it was); the pinned team's sign-in (the first one seen, for a Mac with none
/// pinned, `teamToPin`) is `signingIn`, and so is an identity provider's page reached from it (`previous` is `signingIn`) or by
/// the redirect of the sign-in that was on its way (`viaHop`: the window saw that redirect for itself, see `RemoteWindow`).
///
/// nil: an https page of another host that nothing led to, which the window must not keep showing under its bar.
func remotePhase(afterCommit url: URL?, site: RemoteSite, previous: RemotePhase, viaHop: Bool = false) -> RemotePhase? {
	guard let url, url.scheme?.lowercased() == "https" else { return previous }
	let host = hostOf(url)
	if host == site.host { return url.path.hasPrefix("/cdn-cgi/") ? previous : .connected }
	if let team = accessTeam(of: host, site: site) {
		if team == site.team || (site.team == nil && previous != .connected) { return .signingIn }
		return nil
	}
	return previous == .signingIn || viaHop ? .signingIn : nil
}

/// The team to keep for a Mac that has none, when its sign-in is what was just committed in a window that had not yet shown
/// the Mac's own page: trust on first use, and only for a page that is shown.
func teamToPin(afterCommit url: URL?, site: RemoteSite, previous: RemotePhase) -> String? {
	guard site.team == nil, previous == .loading, let url, url.scheme?.lowercased() == "https" else { return nil }
	return accessTeam(of: hostOf(url), site: site)
}

/// Whether `url` is the Mac's own address: https, the default port, the Mac's host.
func remoteIsOwn(_ url: URL?, site: RemoteSite) -> Bool {
	guard let url, url.scheme?.lowercased() == "https", url.port == nil || url.port == 443 else { return false }
	return hostOf(url) == site.host
}

/// Whether an answer says it is to be saved and not shown (`Content-Disposition: attachment`): what the Mac's file transfer
/// sends, whatever the type of the file (a text file or a picture the web view could show is saved as well).
func remoteIsAttachment(_ response: URLResponse?) -> Bool {
	guard let http = response as? HTTPURLResponse, let value = http.value(forHTTPHeaderField: "Content-Disposition") else { return false }
	let kind = value.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
	return kind.trimmingCharacters(in: .whitespaces).lowercased() == "attachment"
}

/// What a link the person clicked, or a page's request for full screen, needs: a real click or key press in the window a moment
/// ago, used once. (The window feeds it the events its local monitor sees, with their own times.) Not every event is a
/// gesture: letters typed in a field or a key held down are not (`counts`), since a page can bind a script to any of them.
struct RemoteGesture {
	/// How long an event counts for the link it clicked: navigation decisions arrive a moment after the click.
	static let freshFor: TimeInterval = 1
	private var lastEvent = -TimeInterval.infinity
	private var lastOpen = -TimeInterval.infinity

	/// Whether an event is one the person makes to activate something: a mouse button, or Return, keypad Enter or Space, pressed
	/// and not held (`isRepeat`).
	static func counts(isMouse: Bool, keyCode: UInt16, isRepeat: Bool) -> Bool {
		isMouse || (!isRepeat && [36, 76, 49].contains(keyCode))
	}

	mutating func noteEvent(at time: TimeInterval) { lastEvent = max(lastEvent, time) }

	/// An event happened in the last second (and not in the future of `now`), and has not been used.
	func isFresh(at now: TimeInterval) -> Bool {
		let age = now - lastEvent
		return age >= -0.05 && age < RemoteGesture.freshFor
	}

	/// Use the event for something that is not repeated at once (full screen): true once for each event.
	mutating func consume(at now: TimeInterval) -> Bool {
		guard isFresh(at: now) else { return false }
		lastEvent = -TimeInterval.infinity
		return true
	}

	/// Use the event for handing a link to another app: once for each event, and one link a second at most.
	mutating func consumeForExternalOpen(at now: TimeInterval) -> Bool {
		guard isFresh(at: now), now - lastOpen >= 1 || now < lastOpen else { return false }
		lastEvent = -TimeInterval.infinity
		lastOpen = now
		return true
	}
}

/// What a window makes of the navigations of its page, as values (so that it runs in a harness with the order WebKit calls
/// in): where the window is (`phase`), and whether a sign-in of the Mac's team is on its way.
///
/// A sign-in of the team was decided on (`signIn`) and nothing has been shown since: the next main-frame decision may be the
/// redirect of that sign-in to its identity provider (a redirect is decided, then reported, and no load of its own starts: a
/// navigation the page makes is decided, then starts). So an address that the sign-in's chain may follow is let through and
/// remembered (`pending`); if the server reports it as a redirect (`redirected`) the chain is a redirect chain and what it
/// commits is the sign-in; if a load of its own starts (`started`) it was the page navigating, and it is stopped.
///
/// The chain ends where it can no longer be the sign-in's own: at the Mac's own address (Access hands the login back there, and
/// what the Mac answers after that is the Mac's), at a commit, at a failure or a cancel, and when the window shows a page of its
/// own. The window cannot tell the redirect of a sign-in from one of the Mac's server that comes right after it: what it can
/// say is that nothing that follows the Mac's own address is let through.
struct RemoteNavigator {
	/// What a commit did.
	enum Commit: Equatable {
		/// A page of the window's own (not https): nothing changes.
		case ignored
		/// The phase after the page; `pin` is the team to keep for a Mac that had none.
		case moved(RemotePhase, pin: String?)
		/// A page of another site that nothing led to: not kept.
		case unexpected(host: String)
	}

	private(set) var phase = RemotePhase.loading
	private var chainOpen = false
	private var pending: URL?
	private var verified = false

	/// For the tests: where the chain is.
	var chain: (open: Bool, pending: Bool, verified: Bool) { (chainOpen, pending != nil, verified) }

	private mutating func endChain() {
		chainOpen = false
		pending = nil
		verified = false
	}

	/// The window loads the Mac's address from the start, or shows a page of its own: nothing of the Mac is on screen.
	mutating func reset() {
		phase = .loading
		endChain()
	}

	/// Decide a navigation (`clicked`: a link the person really clicked, see `RemoteGesture`).
	mutating func decide(url: URL?, site: RemoteSite, mainFrame: Bool, clicked: Bool) -> RemoteVerdict {
		let effective: RemotePhase = mainFrame && chainOpen && phase != .signingIn ? .signingIn : phase
		let verdict = remoteNavigationVerdict(url: url, site: site, phase: effective, userInitiated: clicked, mainFrame: mainFrame)
		guard mainFrame else { return verdict }
		switch verdict {
		case .signIn:
			endChain()
			chainOpen = true
		case .signInStep:
			if chainOpen && phase != .signingIn { pending = url }
		case .allow:
			// The Mac's own address ends a chain: nothing after it is the sign-in's redirect.
			if remoteIsOwn(url, site: site) { endChain() }
		default:
			break
		}
		return verdict
	}

	/// A main-frame load starts. True: stop it (the chain had let an address through as a possible redirect and no redirect was
	/// reported for it: the page navigated by itself, to somewhere the sign-in did not send it).
	mutating func started() -> Bool {
		guard pending != nil else { return false }
		endChain()
		return true
	}

	/// The server redirected the load that is on its way.
	mutating func redirected() {
		guard pending != nil else { return }
		pending = nil
		verified = true
	}

	/// A main-frame page is shown. Only a commit moves the phase: never a navigation that was merely allowed.
	mutating func committed(_ url: URL?, site: RemoteSite) -> Commit {
		guard let url, url.scheme?.lowercased() == "https" else { return .ignored }
		let viaHop = chainOpen && verified
		endChain()
		let previous = phase
		guard let next = remotePhase(afterCommit: url, site: site, previous: previous, viaHop: viaHop) else {
			reset()
			return .unexpected(host: hostOf(url))
		}
		let pin = teamToPin(afterCommit: url, site: site, previous: previous)
		phase = next
		return .moved(next, pin: pin)
	}

	/// A load failed or was cancelled (a verdict, a stop): what the chain was doing is over, and the phase is what the page on
	/// screen is, which only a commit moves.
	mutating func ended() { endChain() }
}

/// Whether a request for a window of its own is the page asking for a subagent's pop-out (`/?popout#/s/…`, see
/// `isPopOutRequest`): https, the Mac's own host on the default port, the front page with the `popout` parameter.
func isRemotePopOutRequest(_ url: URL?, host: String) -> Bool {
	guard let url, url.scheme?.lowercased() == "https", hostOf(url) == host, url.port == nil || url.port == 443,
		url.path == "/" || url.path.isEmpty,
		let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
	else { return false }
	return items.contains { $0.name == "popout" }
}

/// Whether a message from a page's handler comes from the Mac's own page, in its main frame, with the sign-in done: not a frame
/// inside it, not the sign-in's pages and not the identity provider's (`port` is 0 for the default one in WebKit's
/// `WKSecurityOrigin`).
func isRemotePage(isMainFrame: Bool, scheme: String, host: String, port: Int, site: RemoteSite, phase: RemotePhase) -> Bool {
	isMainFrame && phase == .connected && scheme.lowercased() == "https" && host.lowercased() == site.host && (port == 0 || port == 443)
}

// MARK: - What the web view refuses

/// The scheme rules: the window is https only (`remoteNavigationVerdict` cancels http in the main frame), so nothing in it loads
/// over `http:` or `ws:`. That does not depend on any spelling, on a name that resolves to an address here (`127.0.0.1.nip.io`)
/// or on mixed-content rules.
let remoteSchemeFilters = ["^http://", "^ws://"]

/// The address rules: what is this Mac's or its network's, for any scheme (`https:`, `wss:`…): any address with a user name, a
/// literal IPv6 address, `localhost` and `*.localhost`, `*.local`, `*.internal`, `*.lan`, `*.localdomain`, `*.home.arpa` (each
/// with or without the dot that ends a name), a name of one label (a host of this Mac's network, finished by a search domain),
/// and the IPv4 ranges of this Mac and its network: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 192.0.0/24,
/// 198.18/15, 0.0.0.0, multicast and what is reserved (224/4 and 240/4, which includes the broadcast address). A URL parser has
/// made every spelling of an address (`2130706433`, `0x7f.1`) into dotted decimal before a rule sees it.
///
/// Not covered: a public name that resolves to an address here, over https or wss (`127.0.0.1.nip.io`, a rebinding name): a name
/// rule cannot see it. It reaches only what answers TLS for that name, which a service of this Mac does not, and omp-webui's own
/// server refuses any `Host` but its own.
func remoteAddressFilters() -> [String] {
	let start = "^[a-z]+://"
	var filters = [
		// Any address with a user name in it: `https://x@127.0.0.1/` must not be read as a different host.
		"\(start)[^/]*@",
		// A literal IPv6 address, which includes `[::1]`.
		"\(start)\\[",
	]
	for end in ["[:/]", "$"] {
		filters.append("\(start)localhost\\.?\(end)")
		for suffix in ["localhost", "local", "internal", "lan", "localdomain", "home\\.arpa"] {
			filters.append("\(start)[^/]*\\.\(suffix)\\.?\(end)")
		}
		filters.append("\(start)[^/.:]+\\.?\(end)")
		for octets in [
			"127\\.[0-9]+\\.[0-9]+\\.[0-9]+", "10\\.[0-9]+\\.[0-9]+\\.[0-9]+", "192\\.168\\.[0-9]+\\.[0-9]+",
			"172\\.1[6-9]\\.[0-9]+\\.[0-9]+", "172\\.2[0-9]\\.[0-9]+\\.[0-9]+", "172\\.3[01]\\.[0-9]+\\.[0-9]+",
			"169\\.254\\.[0-9]+\\.[0-9]+", "100\\.6[4-9]\\.[0-9]+\\.[0-9]+", "100\\.[7-9][0-9]\\.[0-9]+\\.[0-9]+",
			"100\\.1[01][0-9]\\.[0-9]+\\.[0-9]+", "100\\.12[0-7]\\.[0-9]+\\.[0-9]+", "0\\.0\\.0\\.0",
			"192\\.0\\.0\\.[0-9]+", "198\\.1[89]\\.[0-9]+\\.[0-9]+", "22[4-9]\\.[0-9]+\\.[0-9]+\\.[0-9]+",
			"23[0-9]\\.[0-9]+\\.[0-9]+\\.[0-9]+", "24[0-9]\\.[0-9]+\\.[0-9]+\\.[0-9]+", "25[0-5]\\.[0-9]+\\.[0-9]+\\.[0-9]+",
		] {
			filters.append("\(start)\(octets)\(end)")
		}
	}
	return filters
}

/// Every rule of the web view's content blocker, which has no alternation: one rule for each form, as `url-filter` regular
/// expressions over the whole URL. A page of another Mac must not reach this one: not the app's own server on `127.0.0.1` (its
/// token is in no remote window's data store, and the server refuses a page of another site, but the request is refused before it
/// is made), nor anything on this Mac's network.
func remoteBlockFilters() -> [String] { remoteSchemeFilters + remoteAddressFilters() }

func remoteContentRules() -> String {
	let rules = remoteBlockFilters().map { ["trigger": ["url-filter": $0], "action": ["type": "block"]] as [String: Any] }
	return String(data: try! JSONSerialization.data(withJSONObject: rules, options: [.sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)!
}

private let remoteAddressExpressions = remoteAddressFilters().map { try! NSRegularExpression(pattern: $0, options: [.caseInsensitive]) }

/// Whether `url` is an address of this Mac or its network, by the address rules of the blocker, run here: a link for another app
/// must not point at what the web view is not let to load (the browser has no blocker). The scheme rules do not count: a link to
/// `http://example.com/` is the browser's. An address that is numeric but not in dotted decimal (`2130706433`, `0x7f.1`) is
/// refused as well, in case a URL arrives that WebKit has not yet written in the canonical way.
func isRemoteBlocked(_ url: URL) -> Bool {
	let text = url.absoluteString
	let range = NSRange(text.startIndex..., in: text)
	if remoteAddressExpressions.contains(where: { $0.firstMatch(in: text, options: [], range: range) != nil }) { return true }
	guard let host = url.host?.lowercased(), let last = host.split(separator: ".", omittingEmptySubsequences: false).last,
		isNumericLabel(String(last))
	else { return false }
	let quad = host.split(separator: ".", omittingEmptySubsequences: false)
	return !(quad.count == 4 && quad.allSatisfy { Int($0).map { (0...255).contains($0) } ?? false })
}

// MARK: - What the window says of itself

/// Where the window stands, for the bar under the title.
enum RemoteStatus: Equatable {
	case connecting
	/// The host that has the page now.
	case signingIn(host: String)
	case connected
	case failed(RemoteProblem)
}

/// Why the Mac's page is not there.
enum RemoteProblem: Equatable {
	case offline
	case hostNotFound
	case timedOut
	case secure
	/// 401 or 403 from the Mac itself: it is reachable and would not let this sign-in in.
	case refused(status: Int)
	case http(status: Int)
	/// The sign-in moved to another team than the one this Mac is pinned to (`pinned`), or to one when none was seen.
	case teamMismatch(host: String, pinned: String?)
	/// A page of another site that nothing led to (`remotePhase` is nil): not kept on screen.
	case unexpected(host: String)
	case other(String)
}

func remoteProblem(urlErrorCode code: Int, description: String) -> RemoteProblem {
	switch probeFailure(urlErrorCode: code) {
	case .offline: return .offline
	case .hostNotFound: return .hostNotFound
	case .timedOut: return .timedOut
	case .secure: return .secure
	case .other: return .other(description)
	}
}

/// The problem an answer of the Mac's own address is, or nil for one that is a page.
func remoteProblem(httpStatus status: Int) -> RemoteProblem? {
	if status == 401 || status == 403 { return .refused(status: status) }
	return status >= 400 ? .http(status: status) : nil
}

/// A page's title as the window shows it after the Mac's name: no control or format characters (a right-to-left override
/// could make the end of the title read as the beginning), runs of white space as one space, at most 120 characters.
func cleanedPageTitle(_ title: String) -> String {
	var out = String.UnicodeScalarView()
	for scalar in title.unicodeScalars {
		switch scalar.properties.generalCategory {
		case .control, .lineSeparator, .paragraphSeparator, .spaceSeparator: out.append(" ")
		case .format, .privateUse, .surrogate, .unassigned: break
		default: out.append(scalar)
		}
	}
	let words = String(out).split(separator: " ", omittingEmptySubsequences: true)
	let text = words.joined(separator: " ")
	return text.count > 120 ? String(text.prefix(119)) + "…" : text
}

/// The window's title: the Mac's name first, always, then the page's own title. The page cannot take the name away.
func remoteWindowTitle(name: String, pageTitle: String?, language: ShellLanguage) -> String {
	let label = RemoteWords(language).windowLabel(name)
	guard let pageTitle, case let title = cleanedPageTitle(pageTitle), !title.isEmpty else { return label }
	return "\(label) — \(title)"
}

/// A host as the bar names it: all of it, or, when it is long, its end after an ellipsis: what a name is judged by is its end
/// (`accounts.google.com.<long>.evil.example` must not read as `accounts.goo…`), and the bar has room for about this much.
func displayHost(_ host: String, limit: Int = 40) -> String {
	host.count <= limit ? host : "…" + host.suffix(limit - 1)
}

/// What the bar says, in three parts: the tag that does not go away (`REMOTE`), who (`Mac A · omp.example.com`, which gives way
/// first when the window is narrow) and where it stands (`Signing in at login.example-idp.com`, which keeps its room).
func remoteStripParts(
	name: String, host: String, status: RemoteStatus, language: ShellLanguage
) -> (tag: String, who: String, status: String, statusFull: String) {
	let w = RemoteWords(language)
	return (w.remoteTag, "\(name) · \(host)", w.status(status), w.status(status, hostLimit: 253))
}

/// The line in the bar under the title as one text (for what reads it aloud): `REMOTE · Mac A · omp.example.com · Connected`.
func remoteStripText(name: String, host: String, status: RemoteStatus, language: ShellLanguage) -> String {
	let parts = remoteStripParts(name: name, host: host, status: status, language: language)
	return [parts.tag, parts.who, parts.status].joined(separator: " · ")
}

/// Hues (degrees, HSB) a Mac's window is tinted with: eight, none of them red, which is the colour of a warning.
let remoteHues: [Double] = [38, 80, 140, 175, 205, 235, 270, 305]

/// Which hue a Mac has: a function of its id, so it is the same every time and two Macs mostly differ at a glance.
func remoteHueIndex(for id: UUID) -> Int {
	var hash: UInt32 = 2_166_136_261
	withUnsafeBytes(of: id.uuid) { bytes in
		for byte in bytes {
			hash ^= UInt32(byte)
			hash = hash &* 16_777_619
		}
	}
	return Int(hash % UInt32(remoteHues.count))
}

// MARK: - The page the window shows when the Mac's page is not there

private func escaped(_ text: String) -> String {
	text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
		.replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
}

/// The address of the page's "try again" link: the window's own, which it recognises (it reloads the Mac's address).
let remoteRetryScheme = "ompw-retry"

/// The window's own page for a Mac that did not answer (a blank web view would say nothing). Every value is escaped.
func remoteErrorPage(name: String, host: String, problem: RemoteProblem, language: ShellLanguage) -> String {
	let w = RemoteWords(language)
	return """
		<!doctype html><html lang="\(language == .zh ? "zh-CN" : "en")"><head><meta charset="utf-8">
		<meta name="color-scheme" content="light dark"><title>\(escaped(w.problemTitle(problem, host: host)))</title>
		<style>
		body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:14px -apple-system,sans-serif}
		main{max-width:30em;padding:2em;line-height:1.5}
		h1{font-size:1.25em;margin:0 0 .5em} a{font-weight:600}
		.name{opacity:.6}
		</style></head><body><main>
		<h1>\(escaped(w.problemTitle(problem, host: host)))</h1>
		<p>\(escaped(w.problemDetail(problem, name: name, host: host)))</p>
		<p><a href="\(remoteRetryScheme):">\(escaped(w.tryAgain))</a></p>
		<p class="name">\(escaped(w.remoteTag)) · \(escaped(name)) · \(escaped(host))</p>
		</main></body></html>
		"""
}

// MARK: - Words

/// The words of the windows and dialogs about other Macs, in the language the shell's other words are in (`ShellLanguage`).
/// Simplified Chinese says 对话, never 会话, and keeps `agent` as the web UI does.
struct RemoteWords {
	let language: ShellLanguage
	init(_ language: ShellLanguage) { self.language = language }

	private func pick(_ en: String, _ zh: String) -> String { language == .zh ? zh : en }

	// The menu.
	var menuTitle: String { "Macs" }
	var noMacs: String { pick("No other Macs yet", "还没有其他 Mac") }
	var addMac: String { pick("Add Mac…", "添加 Mac…") }
	var manageMacs: String { pick("Manage Macs…", "管理 Mac…") }

	// Notifications of a Mac's conversations (the second part of the menu).
	var notifyHeading: String { pick("Notify me about conversations of:", "通知我这些 Mac 的对话：") }
	func notifyTip(_ host: String) -> String {
		pick(
			"Show a notification when a conversation on \(host) needs your input or has finished, also while its window is closed, unless you are looking at that conversation.",
			"当 \(host) 上的对话需要你的输入或已完成时显示通知，窗口关着时也一样；你正看着那个对话时不显示。")
	}
	var notifyTitle: String { pick("Notifications are off", "通知未开启") }
	var notifyBlocked: String {
		pick(
			"macOS blocks notifications for omp-webui. Open System Settings › Notifications › omp-webui and allow them, then turn this on again.",
			"macOS 阻止了 omp-webui 的通知。请打开“系统设置 › 通知 › omp-webui”允许通知，然后再次开启。")
	}
	var notifyUnsupported: String {
		pick(
			"This copy of omp-webui cannot show notifications: it is not running as an app.",
			"此 omp-webui 并非以应用方式运行，无法显示通知。")
	}

	// Add.
	var addTitle: String { pick("Add a Mac", "添加一台 Mac") }
	var addDetail: String {
		pick(
			"Open omp-webui running on another Mac that you reach through Cloudflare Access. In its window, the commands the agent runs run on that Mac, as its user, not on this one.",
			"打开另一台 Mac 上运行的 omp-webui（通过 Cloudflare Access 访问）。在它的窗口里，agent 运行的命令是在那台 Mac 上、以它的用户身份运行的，不是在这台 Mac 上。")
	}
	var nameLabel: String { pick("Name", "名称") }
	var addressLabel: String { pick("Address", "地址") }
	var namePlaceholder: String { pick("Studio Mac", "工作室的 Mac") }
	var addressPlaceholder: String { "omp.example.com" }
	var check: String { pick("Check", "检查") }
	var add: String { pick("Add", "添加") }
	var addAnyway: String { pick("Add Anyway", "仍然添加") }
	var cancel: String { pick("Cancel", "取消") }
	var ok: String { pick("OK", "好") }
	func checking(_ host: String) -> String { pick("Checking \(host)…", "正在检查 \(host)…") }

	func problem(_ problem: RemoteMacProblem) -> String {
		switch problem {
		case .name(.empty): return pick("Give the Mac a name.", "请给这台 Mac 起个名字。")
		case .name(.tooLong): return pick("A name is at most \(remoteNameLimit) characters.", "名称最多 \(remoteNameLimit) 个字符。")
		case .name(.characters): return pick("A name cannot hold line breaks or invisible characters.", "名称里不能有换行或不可见字符。")
		case .name(.taken(let other)): return pick("Another Mac is already called “\(other)”.", "已有另一台 Mac 叫“\(other)”。")
		case .address(.empty): return pick("Type the Mac's address, for example omp.example.com.", "请填写这台 Mac 的地址，例如 omp.example.com。")
		case .address(.notHTTPS(let scheme)): return pick("Only https addresses work (not “\(scheme)”).", "只能用 https 地址（不能是“\(scheme)”）。")
		case .address(.userInfo): return pick("Leave out the user name and password: signing in happens in the window.", "不要写用户名和密码：登录在窗口里进行。")
		case .address(.port): return pick("Leave out the port: remote access uses the https port.", "不要写端口：远程访问用的是 https 默认端口。")
		case .address(.path): return pick("Leave out everything after the host name.", "主机名后面的内容都不要写。")
		case .address(.ipAddress): return pick("Use the Mac's host name, not an IP address.", "请用这台 Mac 的主机名，不要用 IP 地址。")
		case .address(.trailingDot): return pick("Remove the dot at the end of the name.", "请去掉名称末尾的点。")
		case .address(.notASCII): return pick("Write an international name in its xn-- form.", "国际化域名请写成 xn-- 的形式。")
		case .address(.localName):
			return pick(
				"A name that only works on a private network (localhost, .local…) cannot be a remote Mac.",
				"只在局域网内有效的名称（localhost、.local 等）不能作为远程 Mac。")
		case .address(.accessDomain): return pick("That is Cloudflare's sign-in address. Type the address of the Mac itself.", "那是 Cloudflare 的登录地址。请填这台 Mac 自己的地址。")
		case .address(.notDomainName):
			return pick(
				"That is not a domain name (letters, digits and dashes, separated by dots).",
				"这不是域名（由点分隔的字母、数字和连字符）。")
		case .hostTaken(let other): return pick("That address is already saved as “\(other)”.", "这个地址已经保存为“\(other)”。")
		case .full: return pick("At most \(RemoteMacList.limit) Macs can be saved. Forget one first.", "最多保存 \(RemoteMacList.limit) 台 Mac。请先忘记一台。")
		}
	}

	/// What a look at the address found, for the line under the fields.
	func probe(_ result: ProbeResult, host: String) -> String {
		switch result {
		case .access(let team):
			return pick("\(host) is behind Cloudflare Access (team “\(team)”).", "\(host) 在 Cloudflare Access 之后（团队“\(team)”）。")
		case .redirected(let target):
			return pick(
				"\(host) redirects to \(target.isEmpty ? "another address" : target), which is not Cloudflare Access: nothing confirms it is the Mac you mean.",
				"\(host) 跳转到了\(target.isEmpty ? "另一个地址" : " \(target)")，那不是 Cloudflare Access：无法确认它就是你要找的那台 Mac。")
		case .forbidden:
			return pick(
				"\(host) answers, but it is not behind Cloudflare Access (or remote access is off on that Mac).",
				"\(host) 有响应，但它不在 Cloudflare Access 之后（或那台 Mac 上的远程访问是关闭的）。")
		case .open:
			return pick(
				"\(host) shows a page without asking who you are: it is not behind Cloudflare Access.",
				"\(host) 没有先确认你是谁就显示了页面：它不在 Cloudflare Access 之后。")
		case .httpError(let status):
			return pick(
				"\(host) answered HTTP \(status): that Mac may be asleep, or omp-webui may not be running there.",
				"\(host) 返回了 HTTP \(status)：那台 Mac 可能在休眠，或者那里没有运行 omp-webui。")
		case .unreachable(let failure):
			switch failure {
			case .offline: return pick("This Mac has no internet connection.", "这台 Mac 没有联网。")
			case .hostNotFound: return pick("\(host) is not a known address.", "\(host) 不是一个已知的地址。")
			case .timedOut: return pick("\(host) did not answer in time.", "\(host) 没有及时响应。")
			case .secure: return pick("A secure connection to \(host) could not be made.", "无法与 \(host) 建立安全连接。")
			case .other: return pick("\(host) could not be reached.", "无法连接到 \(host)。")
			}
		}
	}

	/// Said with `probe` when the address was not confirmed as a Mac behind Access and the person may add it anyway.
	var addAnywayNote: String {
		pick(
			"You can still add it: the sign-in team is then kept the first time you sign in there.",
			"你仍然可以添加：登录团队会在你第一次在那里登录时记下。")
	}

	// Manage.
	var manageTitle: String { pick("Manage Macs", "管理 Mac") }
	var manageDetail: String {
		pick(
			"Signing out removes the saved sign-in from this computer; Macs on the same Cloudflare team share it, so they are signed out together. Forgetting also removes the Mac from the list. Nothing changes on the other Mac.",
			"退出登录会从这台电脑上删除保存的登录状态；同一个 Cloudflare 团队的 Mac 共用它，所以会一起退出。忘记还会把这台 Mac 从列表里移除。对方那台 Mac 上不会有任何变化。")
	}
	var done: String { pick("Done", "完成") }
	var signOut: String { pick("Sign Out", "退出登录") }
	var forget: String { pick("Forget…", "忘记…") }
	func addressLine(_ host: String) -> String { pick("Address: \(host)", "地址：\(host)") }
	func teamLine(_ team: String?) -> String {
		pick("Cloudflare team: \(team ?? "not known yet")", "Cloudflare 团队：\(team ?? "尚未获知")")
	}
	func lastConnectedLine(_ date: Date?) -> String {
		guard let date else { return pick("Last connected: never", "上次连接：从未") }
		let formatter = DateFormatter()
		formatter.dateStyle = .medium
		formatter.timeStyle = .short
		formatter.locale = Locale(identifier: language == .zh ? "zh_CN" : "en_US")
		return pick("Last connected: \(formatter.string(from: date))", "上次连接：\(formatter.string(from: date))")
	}
	func signedOut(_ name: String) -> String {
		pick("Signed out of “\(name)”. Its windows were closed.", "已退出“\(name)”的登录，它的窗口已关闭。")
	}
	/// Signing out of a Mac signs out the others of its Cloudflare team too (they share one sign-in): they are named.
	func signedOutShared(_ name: String, others: [String]) -> String {
		let en = others.map { "“\($0)”" }.joined(separator: ", ")
		let zh = others.map { "“\($0)”" }.joined(separator: "、")
		let many = others.count > 1
		return pick(
			"Signed out of “\(name)”. It shares its sign-in with \(en) (the same Cloudflare team), so \(many ? "those Macs are" : "that Mac is") signed out too. \(many ? "Their" : "Its") windows were closed.",
			"已退出“\(name)”的登录。它与\(zh)属于同一个 Cloudflare 团队、共用这一次登录，所以它们也已退出，窗口都已关闭。")
	}
	func forgetTitle(_ name: String) -> String { pick("Forget “\(name)”?", "忘记“\(name)”？") }
	var forgetDetail: String {
		pick(
			"It is removed from the list. Its saved sign-in is deleted from this computer, unless another Mac on the same Cloudflare team still uses it. Its windows close. Nothing changes on that Mac.",
			"它会从列表里移除。保存在这台电脑上的登录状态也会被删除，除非同一个 Cloudflare 团队的另一台 Mac 还在使用它。它的窗口会关闭。那台 Mac 上不会有任何变化。")
	}
	var forgetButton: String { pick("Forget", "忘记") }
	func cannotForget(_ name: String) -> String { pick("Could not forget “\(name)”", "无法忘记“\(name)”") }
	var cannotSave: String { pick("Could not save the list of Macs", "无法保存 Mac 列表") }
	/// The Mac is out of the list (the server did that first) but what it had saved here could not be deleted.
	func forgotButSignInKept(_ name: String) -> String {
		pick(
			"“\(name)” was removed from the list, but its saved sign-in could not be deleted from this computer",
			"“\(name)”已从列表里移除，但无法从这台电脑上删除它保存的登录状态")
	}
	/// The list of Macs belongs to the app's own server: while it is not running, nothing in the list can be changed.
	var serverDown: String {
		pick(
			"The app's server is not running, so the list of Macs cannot be changed now. Try again in a moment.",
			"这个应用的服务器没有运行，所以现在无法修改 Mac 列表。请稍后再试。")
	}
	/// Said under the fields of the sheets while a change waits for the server.
	var working: String { pick("Working…", "正在处理…") }
	var cannotOpen: String { pick("Could not open the window", "无法打开窗口") }
	var cannotProtect: String {
		pick(
			"The protections that keep a remote page away from this Mac could not be set up, so no window was opened.",
			"无法设置让远程页面碰不到这台 Mac 的保护，所以没有打开窗口。")
	}

	// The window.
	var remoteTag: String { pick("REMOTE", "远程") }
	func windowLabel(_ name: String) -> String { pick("\(name) (remote)", "\(name)（远程）") }
	var disconnect: String { pick("Disconnect", "断开") }
	func status(_ status: RemoteStatus, hostLimit: Int = 40) -> String {
		switch status {
		case .connecting: return pick("Connecting…", "正在连接…")
		case .signingIn(let host):
			return pick("Signing in at \(displayHost(host, limit: hostLimit))", "正在 \(displayHost(host, limit: hostLimit)) 登录")
		case .connected: return pick("Connected", "已连接")
		case .failed(.refused): return pick("Sign-in refused", "登录被拒绝")
		case .failed(.teamMismatch): return pick("Different sign-in team", "登录团队不同")
		case .failed(.unexpected): return pick("Stopped an unexpected page", "已拦下一个意外的页面")
		case .failed: return pick("Can't reach this Mac", "连不上这台 Mac")
		}
	}
	func accessibility(name: String, host: String, status: RemoteStatus) -> String {
		let said = self.status(status, hostLimit: 253)
		return pick(
			"Remote Mac \(name), \(host): \(said). Everything in this window happens on that Mac.",
			"远程 Mac \(name)，\(host)：\(said)。这个窗口里的一切都发生在那台 Mac 上。")
	}
	var tryAgain: String { pick("Try again", "重试") }
	func problemTitle(_ problem: RemoteProblem, host: String) -> String {
		switch problem {
		case .refused: return pick("\(host) would not let you in", "\(host) 不让你进入")
		case .teamMismatch: return teamMismatchTitle()
		case .unexpected: return pick("Stopped a page of another site", "已拦下另一个网站的页面")
		default: return pick("Can't reach \(host)", "连不上 \(host)")
		}
	}
	func problemDetail(_ problem: RemoteProblem, name: String, host: String) -> String {
		switch problem {
		case .offline: return pick("This Mac has no internet connection.", "这台 Mac 没有联网。")
		case .hostNotFound: return pick("\(host) is not a known address.", "\(host) 不是一个已知的地址。")
		case .timedOut: return pick("\(name) did not answer in time. It may be asleep.", "\(name) 没有及时响应，它可能在休眠。")
		case .secure: return pick("A secure connection to \(host) could not be made.", "无法与 \(host) 建立安全连接。")
		case .refused(let status):
			return pick(
				"\(name) answered \(status). The email address you signed in with may not be on its list of allowed addresses (Settings › Remote access on that Mac), or remote access is off there.",
				"\(name) 返回了 \(status)。你登录用的邮箱可能不在它的允许名单里（那台 Mac 的“设置 › 远程访问”），或者那里的远程访问是关闭的。")
		case .http(let status):
			return pick(
				"\(name) answered HTTP \(status). It may be asleep, or omp-webui may not be running there.",
				"\(name) 返回了 HTTP \(status)。它可能在休眠，或者那里没有运行 omp-webui。")
		case .teamMismatch(let target, let pinned): return teamMismatch(name: name, host: target, pinned: pinned)
		case .unexpected(let target):
			return pick(
				"\(name) led this window to \(displayHost(target, limit: 80)), which is not its sign-in. The page was taken off the screen. Try again starts over.",
				"\(name) 把这个窗口带到了 \(displayHost(target, limit: 80))，那不是它的登录页。那个页面已被撤下，不再显示。点“重试”会重新开始。")
		case .other(let reason): return reason
		}
	}
	func teamMismatchTitle() -> String { pick("The sign-in moved to a different team", "登录换到了另一个团队") }
	func teamMismatch(name: String, host: String, pinned: String?) -> String {
		if let pinned {
			return pick(
				"\(name) now sends you to sign in at \(host), but it was added with the team “\(pinned)”. Nothing was loaded. If you expected this, forget the Mac and add it again.",
				"\(name) 现在让你到 \(host) 登录，但添加它时记下的团队是“\(pinned)”。没有加载任何内容。如果你预期有这个变化，请先忘记这台 Mac，再重新添加。")
		}
		return pick(
			"\(name) now sends you to sign in at \(host), a team it did not have when it was added. Nothing was loaded. If you expected this, forget the Mac and add it again.",
			"\(name) 现在让你到 \(host) 登录，那是添加它时没有的团队。没有加载任何内容。如果你预期有这个变化，请先忘记这台 Mac，再重新添加。")
	}
	func pageSays(_ name: String) -> String { pick("\(name) says", "\(name) 说") }
	/// The line in the panel where a file the Mac's page offers is saved: where it comes from.
	func saveMessage(file: String, mac: String) -> String {
		pick("“\(file)” comes from \(mac), another Mac.", "“\(file)”来自另一台 Mac：\(mac)。")
	}
	/// The line in the panel where the person picks what the Mac's page is sent: where it goes.
	func openMessage(mac: String) -> String {
		pick("Choose what to send to \(mac), another Mac.", "选择要发送到另一台 Mac（\(mac)）的内容。")
	}
}
