import AppKit
import WebKit

// Notifications of other Macs' conversations (#656): a conversation of a Mac this app has a window onto asks the person something, or
// finishes, and the app says so with a notification of its own, while its window is closed too. The Mac sends them from
// `GET /api/notify/events` (server/shell-events.ts has the protocol: the stream is the one this app's own server gives it, `shellevents.swift`).
//
// The stream is signed in exactly as the Mac's window is: the same two cookies that window's own sign-in left in its data store, Cloudflare
// Access's (`CF_Authorization`, which Access checks at its edge and the Mac's server checks again, for its team, application and the
// allowed emails) and the server's own access token. No other credential exists, and none is made: a Mac whose window was never signed in has
// nothing to read with, and the app reads nothing from it. The request goes to the Mac's own https address and to no other (a redirect, which
// is Access asking somebody to sign in, is not followed and is not read), and the cookies are sent to that host only.
//
// What the person turns on is, for each Mac, in the Macs menu (off until they do): a connection the app keeps open for as long as it runs is not
// something to open for every Mac it has ever been given. The same rule decides when a notification is wanted as for the app's own
// conversations (`isLooking`): not while that Mac's window is the one in use and shows the conversation.

/// Where another Mac's notices are read, under its own address.
let remoteNotifyPath = "api/notify/events"

/// The two cookies a window onto a Mac is signed in with: Cloudflare Access's, and the Mac's own access token.
let remoteSignInCookies: Set<String> = ["CF_Authorization", "ompw_token"]

/// Whether a browser would send `cookie` to `host` for `path` now: not past its end, for that host (a cookie set with a domain, as
/// `.example.com`, is for it and its subdomains; one set without is for that host alone), and for that part of the site.
func remoteCookieApplies(_ cookie: HTTPCookie, host: String, path: String, now: Date) -> Bool {
	if let end = cookie.expiresDate, end <= now { return false }
	let domain = cookie.domain.lowercased()
	let forHost = domain.hasPrefix(".") ? (host == String(domain.dropFirst()) || host.hasSuffix(domain)) : host == domain
	let base = cookie.path.isEmpty ? "/" : cookie.path
	return forHost && (base == "/" || path == base || path.hasPrefix(base.hasSuffix("/") ? base : base + "/"))
}

/// The `Cookie` header that signs a request to the Mac at `host` in: its sign-in cookies that are good for that host now, and no other
/// cookie the store holds. Nil unless Cloudflare Access's is there: without it Access sends the request to its sign-in, which nothing
/// here reads.
func remoteSignInHeader(host: String, cookies: [HTTPCookie], now: Date = Date()) -> String? {
	let own = cookies.filter {
		remoteSignInCookies.contains($0.name) && remoteCookieApplies($0, host: host, path: "/" + remoteNotifyPath, now: now)
	}
	guard own.contains(where: { $0.name == "CF_Authorization" }) else { return nil }
	return HTTPCookie.requestHeaderFields(with: own)["Cookie"]
}

/// How long a stream of another Mac waits to try again after that many failures in a row: it is a network, and a Mac that is off, or a sign-in that
/// has run out, is not a reason to ask every few seconds (a person who signs in again is read at once, `RemoteNotifier.reconnect`).
func remoteNotifyRetryDelay(_ failures: Int) -> TimeInterval { min(2 * pow(2, Double(failures - 1)), 300) }

extension Banner {
	/// The notification for a conversation of `mac`: named by the Mac under its title, replaced only by a later one of the same
	/// conversation of the same Mac, and opening that Mac's window when it is clicked.
	func onMac(_ mac: RemoteMac) -> Banner {
		Banner(
			id: "\(mac.id.uuidString)/\(id)", title: title, body: body, liveId: liveId, file: file, subtitle: mac.name,
			macId: mac.id.uuidString)
	}
}

// MARK: - What the person turned on

/// Which Macs the person wants notifications from.
protocol RemoteNotifyChoices: AnyObject {
	func isOn(_ id: UUID) -> Bool
	func set(_ id: UUID, on: Bool)
	/// Forget the choice for every Mac that is not in `ids`: the Mac was forgotten.
	func keep(only ids: Set<UUID>)
}

/// The choices as the app keeps them: the app's own preferences, not the local server's (the list of Macs is the server's, the app's
/// reading of it is not).
final class DefaultsRemoteNotifyChoices: RemoteNotifyChoices {
	static let key = "remoteNotifyMacs"
	private let defaults: UserDefaults

	init(defaults: UserDefaults = .standard) { self.defaults = defaults }

	private var ids: Set<String> { Set(defaults.stringArray(forKey: DefaultsRemoteNotifyChoices.key) ?? []) }

	func isOn(_ id: UUID) -> Bool { ids.contains(id.uuidString) }

	func set(_ id: UUID, on: Bool) {
		var now = ids
		if on { now.insert(id.uuidString) } else { now.remove(id.uuidString) }
		defaults.set(Array(now).sorted(), forKey: DefaultsRemoteNotifyChoices.key)
	}

	func keep(only keepIds: Set<UUID>) {
		let kept = ids.filter { text in UUID(uuidString: text).map(keepIds.contains) ?? false }
		if kept != ids { defaults.set(Array(kept).sorted(), forKey: DefaultsRemoteNotifyChoices.key) }
	}
}

// MARK: - The streams

/// A stream of each Mac the person turned notifications on for, kept for as long as the app runs and the Mac stays in the list (also while
/// its window is closed, which is the point). A Mac's notices are handed to `hear`, with its id, on the main queue.
@available(macOS 14.0, *)
final class RemoteNotifier {
	private let choices: RemoteNotifyChoices
	private let macs: () -> [RemoteMac]
	private let language: () -> ShellLanguage
	/// The cookies of a Mac's data store, the ones its window signed in with.
	private let cookies: (RemoteMac, @escaping ([HTTPCookie]) -> Void) -> Void
	private let hear: (UUID, ShellMessage) -> Void
	private var streams: [UUID: ShellEventStream] = [:]

	init(
		choices: RemoteNotifyChoices, macs: @escaping () -> [RemoteMac], language: @escaping () -> ShellLanguage,
		cookies: @escaping (RemoteMac, @escaping ([HTTPCookie]) -> Void) -> Void = RemoteNotifier.storedCookies,
		hear: @escaping (UUID, ShellMessage) -> Void
	) {
		self.choices = choices
		self.macs = macs
		self.language = language
		self.cookies = cookies
		self.hear = hear
	}

	/// The cookies in the data store of `mac`'s window. The store is made for this one read and let go of after it: one kept would stand
	/// in the way of deleting it when the Mac is forgotten.
	static func storedCookies(_ mac: RemoteMac, _ done: @escaping ([HTTPCookie]) -> Void) {
		let store = WKWebsiteDataStore(forIdentifier: mac.storeIdentifier)
		store.httpCookieStore.getAllCookies { cookies in
			_ = store
			done(cookies)
		}
	}

	/// Which Macs are being read: the ones the person turned on that the list still has.
	var reading: Set<UUID> { Set(streams.keys) }

	/// Read from the Macs that are turned on and are not read yet, stop reading the ones that are not (turned off, or forgotten).
	func sync() {
		let list = macs()
		choices.keep(only: Set(list.map(\.id)))
		let wanted = list.filter { choices.isOn($0.id) }
		for id in Array(streams.keys) where !wanted.contains(where: { $0.id == id }) {
			streams[id]?.stop()
			streams[id] = nil
		}
		for mac in wanted where streams[mac.id] == nil { streams[mac.id] = stream(for: mac) }
	}

	/// The person signed in to this Mac again: what was read with the old sign-in is read again with the new one, without waiting out
	/// the pause a stream that was refused keeps.
	func reconnect(_ id: UUID) { streams[id]?.reconnect() }

	func stopAll() {
		for stream in streams.values { stream.stop() }
		streams = [:]
	}

	private func stream(for mac: RemoteMac) -> ShellEventStream {
		let id = mac.id
		let stream = ShellEventStream(
			makeRequest: { [weak self] origin, language, epoch, since, done in
				// The Mac as it is now: its team may have been pinned since, which is another data store, and its sign-in is read from there.
				guard let self, let current = self.macs().first(where: { $0.id == id }) else { return done(nil) }
				self.cookies(current) { cookies in
					guard let header = remoteSignInHeader(host: current.host, cookies: cookies) else { return done(nil) }
					done(
						eventsRequest(
							origin: origin, path: remoteNotifyPath, headers: ["cookie": header], language: language, epoch: epoch,
							since: since))
				}
			},
			language: language, retryDelay: remoteNotifyRetryDelay,
			onMessage: { [weak self] message in self?.hear(id, message) })
		stream.connect(to: RemoteSite(host: mac.host).url)
		return stream
	}
}
