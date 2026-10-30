import CryptoKit
import Foundation

// The list of other Macs this app can open a window onto (#614, the switcher #628): what a Mac's record holds, which names and
// addresses are accepted, the file the list is read from, what the app asks its own server for to change it, the data store a
// Mac's window signs in with, and the probe that looks at an address before it is saved. The list belongs to the local server,
// which is its only writer (`<data dir>/remote-macs.json`, server/saved-macs.ts): the app reads the file as it is now (so the
// Macs menu works while the server is down) and asks the server, over its local-only routes, to add, rename or forget a Mac.
// All of it is plain values and functions, so that it runs in a harness (tests/support/swift/remote/main.swift) without a
// window or a network. The windows are `remotewindow.swift`; what a window may do with a navigation, and the words, are
// `remotepolicy.swift`.

// MARK: - Address

/// Why a typed address cannot be a remote Mac's.
enum AddressProblem: Error, Equatable {
	case empty
	/// Another scheme than `https` (the scheme that was typed).
	case notHTTPS(String)
	case userInfo
	case port
	case path
	/// An IP address, in any spelling a URL parser would read as one (`1.2.3.4`, `127.1`, `0x7f.1`, `[::1]`).
	case ipAddress
	case trailingDot
	case notASCII
	/// A name that is only ever on a private network: `localhost`, `*.local`…
	case localName
	/// `*.cloudflareaccess.com`: that is the team's sign-in, never the Mac.
	case accessDomain
	case notDomainName
}

/// The last label of a name that only a private network knows.
private let privateTopLevels: Set<String> = ["local", "localhost", "internal", "lan", "localdomain"]

/// Lower-case the letters A–Z and nothing else (as `asciiLower` in shared/remote.ts does): the server compares ASCII.
func asciiLower(_ text: String) -> String {
	String(String.UnicodeScalarView(text.unicodeScalars.map { ("A"..."Z").contains($0) ? Unicode.Scalar($0.value + 32)! : $0 }))
}

private func isLabel(_ label: String) -> Bool {
	guard (1...63).contains(label.utf8.count), label.first != "-", label.last != "-" else { return false }
	return label.utf8.allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2d }
}

/// A last label a URL parser reads as a number, which makes the whole host an IPv4 address (WHATWG URL, "ends in a number").
func isNumericLabel(_ label: String) -> Bool {
	if label.isEmpty { return false }
	if label.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) { return true }
	guard label.hasPrefix("0x") else { return false }
	return label.dropFirst(2).utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
}

/// The host of an address a person typed: `omp.example.com`, `https://omp.example.com` and `https://omp.example.com/` are the
/// same Mac. The window shows `https://<host>/` and nothing else, so only what is a public DNS name of the shape the server's
/// own `hostname` setting takes (shared/remote.ts `hostnameOf`) is accepted: no port (the tunnel is on 443), no user name, no
/// path, no IP address, no private name, no trailing dot, and only ASCII (an international name is written in its `xn--` form).
func parseRemoteAddress(_ input: String) -> Result<String, AddressProblem> {
	var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
	if text.isEmpty { return .failure(.empty) }
	if let marker = text.range(of: "://") {
		let scheme = String(text[..<marker.lowerBound])
		guard scheme.lowercased() == "https" else { return .failure(.notHTTPS(scheme)) }
		text = String(text[marker.upperBound...])
	}
	let end = text.firstIndex { "/?#".contains($0) } ?? text.endIndex
	let authority = String(text[..<end])
	let rest = text[end...]
	if !rest.isEmpty && rest != "/" { return .failure(.path) }
	if authority.isEmpty { return .failure(.empty) }
	if authority.contains("@") { return .failure(.userInfo) }
	if authority.hasPrefix("[") { return .failure(.ipAddress) }
	if let colon = authority.firstIndex(of: ":") {
		let after = authority[authority.index(after: colon)...]
		return .failure(!after.isEmpty && after.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 } ? .port : .notDomainName)
	}
	if authority.unicodeScalars.contains(where: { !$0.isASCII }) { return .failure(.notASCII) }
	let host = asciiLower(authority)
	if host.hasSuffix(".") { return .failure(.trailingDot) }
	let labels = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
	if let last = labels.last, isNumericLabel(last) { return .failure(.ipAddress) }
	if let last = labels.last, privateTopLevels.contains(last) || host.hasSuffix(".home.arpa") { return .failure(.localName) }
	if host == "cloudflareaccess.com" || host.hasSuffix(".cloudflareaccess.com") { return .failure(.accessDomain) }
	guard host.utf8.count <= 253, labels.count >= 2, labels.allSatisfy(isLabel), labels.last!.contains(where: { $0.isLetter })
	else { return .failure(.notDomainName) }
	return .success(host)
}

/// A Cloudflare team name as the server takes it (shared/remote.ts `TEAM`): letters, digits and dashes.
func isTeamName(_ text: String) -> Bool {
	(1...63).contains(text.utf8.count) && text.utf8.allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2d }
}

// MARK: - Name

enum NameProblem: Error, Equatable {
	case empty
	case tooLong
	/// A control or format character (a line break, a right-to-left override…): a name is shown in the window's title and bar.
	case characters
	/// Another Mac already has this name (its name as saved).
	case taken(String)
}

let remoteNameLimit = 60

/// What two names are compared by: case, accents, width and compatibility forms do not make a name another one, since the name is
/// what tells two windows apart. The same definition as the server's `foldMacName` (shared/macs.ts), held to the same cases
/// (`NAME_SAME` and `NAME_DIFFERENT` in tests/support/mac-vectors.ts): NFKD, the marks dropped, lower case, upper case and lower
/// case again (the full mappings of Unicode, so `ß`, `ẞ` and `ss`, and `σ` and `Σ`, are the same letters), a final sigma `ς` written
/// `σ` (the server's `toLowerCase` reads a sigma by its place in a word and Swift's `lowercased()` does not, so neither decides),
/// then NFC. Foundation's `folding(options:)` is not it: it agrees on some of these letters and not on others (`ß`, `ς`, `Ǆ`), and a
/// name the server saved as another one's could then be dropped by the app's list when it reads the file.
func foldedName(_ name: String) -> String {
	var letters = String.UnicodeScalarView()
	for scalar in name.decomposedStringWithCompatibilityMapping.unicodeScalars where !foldedAwayCategories.contains(scalar.properties.generalCategory) {
		letters.append(scalar)
	}
	var folded = String.UnicodeScalarView()
	for scalar in String(letters).lowercased().uppercased().lowercased().unicodeScalars {
		folded.append(scalar == "\u{3C2}" ? "\u{3C3}" : scalar)
	}
	return String(folded).precomposedStringWithCanonicalMapping
}

/// The marks: what NFKD leaves of an accent (general category M, as `\p{M}` is in the server's fold).
private let foldedAwayCategories: Set<Unicode.GeneralCategory> = [.nonspacingMark, .spacingMark, .enclosingMark]

private let forbiddenCategories: Set<Unicode.GeneralCategory> = [
	.control, .format, .lineSeparator, .paragraphSeparator, .privateUse, .surrogate, .unassigned,
]

/// The name as it would be kept (trimmed), or why it is not one. Uniqueness is the list's to check (`RemoteMacList`).
func parseRemoteName(_ input: String) -> Result<String, NameProblem> {
	let name = input.trimmingCharacters(in: .whitespacesAndNewlines)
	if name.isEmpty { return .failure(.empty) }
	if name.count > remoteNameLimit { return .failure(.tooLong) }
	if name.unicodeScalars.contains(where: { forbiddenCategories.contains($0.properties.generalCategory) }) { return .failure(.characters) }
	return .success(name)
}

// MARK: - The record and the list

struct RemoteMac: Equatable {
	var id: UUID
	var name: String
	/// The address's host (`omp.example.com`): validated, lower case.
	var host: String
	/// The Cloudflare team whose sign-in this Mac sends people to, kept the first time it is seen: a later redirect to another
	/// team is refused. nil until known.
	var team: String?
	/// This Mac's own data store, the one it had before its team was known (and the one it still has while it is not): the
	/// identifier is kept in the file for as long as the Mac is listed, so that forgetting the Mac can remove what is left in it.
	var storeId: UUID
	var added: Date
	var lastConnected: Date?

	/// The data store of this Mac's window: its cookies, its login, its page storage. Not the app's own, so that the local
	/// server's token cookie is in none of them. The Macs of one Cloudflare team share one (`teamStoreIdentifier`), so that one
	/// Access sign-in, the session cookie of `<team>.cloudflareaccess.com`, covers them all; a Mac whose team is not known has
	/// its own, and nothing of it is in another's.
	var storeIdentifier: UUID { team.map(teamStoreIdentifier) ?? storeId }
}

/// The identifier of the data store the Macs of one Cloudflare team share: the same on every launch with no file of its own, so
/// it is made from the team's name. UUID version 5 in form (name based, hashed with SHA-256, the first 16 bytes with the
/// version and variant bits set) under a namespace string of this app's own, so that no other program's identifier is it.
func teamStoreIdentifier(_ team: String) -> UUID {
	var bytes = Array(SHA256.hash(data: Data("omp-webui/remote-team/\(team)".utf8)).prefix(16))
	bytes[6] = (bytes[6] & 0x0f) | 0x50
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return NSUUID(uuidBytes: bytes) as UUID
}

/// The data stores to delete when `mac` has been taken out of the list (`remaining`: the Macs that are left): its shared team
/// store and its own, but a store only when no Mac that is left uses it (another Mac of the team is still signed in there).
func storesToRemove(forgetting mac: RemoteMac, remaining: [RemoteMac]) -> [UUID] {
	let inUse = Set(remaining.filter { $0.id != mac.id }.map(\.storeIdentifier))
	var stores: [UUID] = []
	for id in [mac.storeIdentifier, mac.storeId] where !inUse.contains(id) && !stores.contains(id) { stores.append(id) }
	return stores
}

/// Whether a cookie of `domain` is the Mac at `host`'s own: one it set for its own host (`omp.example.com`, or `.omp.example.com`
/// as a cookie's domain is written). A cookie for a parent domain (`.example.com`) is not: the other Macs of the team, under the
/// same domain, may be using it.
func cookieIsOwn(domain: String, host: String) -> Bool {
	let domain = domain.lowercased()
	return domain == host || domain == "." + host
}

/// What a data store keeps besides its cookies is in records named for a registrable domain (`WKWebsiteDataRecord.displayName`),
/// not for a host: the page storage of `a.example.com` and of `b.example.com` is in the one record `example.com`. Whether the
/// record of `name` holds the Mac at `host`'s page storage.
func recordHolds(_ name: String, host: String) -> Bool {
	let name = name.lowercased()
	return host == name || host.hasSuffix("." + name)
}

/// The records of a store that stays (another Mac of the team is signed in there) to delete when `mac` has been forgotten: the
/// records that hold its page storage and no page storage of a Mac that is left, since a record cannot be cut by host. A record
/// a Mac that is left shares stays whole (the forgotten Mac's cookies are deleted on their own, by host: they are the sign-in).
func recordsToRemove(forgetting mac: RemoteMac, remaining: [RemoteMac], recordNames: [String]) -> [String] {
	let others = remaining.filter { $0.id != mac.id && $0.storeIdentifier == mac.storeIdentifier }
	return recordNames.filter { name in recordHolds(name, host: mac.host) && !others.contains { recordHolds(name, host: $0.host) } }
}

enum RemoteMacProblem: Error, Equatable {
	case name(NameProblem)
	case address(AddressProblem)
	/// This host is saved already (under that name).
	case hostTaken(String)
	case full
}

/// The Macs this app knows, at most `limit`, in the order they were added.
struct RemoteMacList: Equatable {
	static let limit = 10
	let macs: [RemoteMac]

	init(_ macs: [RemoteMac] = []) { self.macs = macs }

	func mac(id: UUID) -> RemoteMac? { macs.first { $0.id == id } }

	/// The name and host a new Mac would have, or what is wrong with them.
	func checkNew(name: String, address: String) -> Result<(name: String, host: String), RemoteMacProblem> {
		if macs.count >= RemoteMacList.limit { return .failure(.full) }
		let kept: String
		switch parseRemoteName(name) {
		case .success(let value): kept = value
		case .failure(let problem): return .failure(.name(problem))
		}
		if let other = macs.first(where: { foldedName($0.name) == foldedName(kept) }) { return .failure(.name(.taken(other.name))) }
		switch parseRemoteAddress(address) {
		case .success(let host):
			if let other = macs.first(where: { $0.host == host }) { return .failure(.hostTaken(other.name)) }
			return .success((kept, host))
		case .failure(let problem): return .failure(.address(problem))
		}
	}

	/// The new name for Mac `id`, or what is wrong with it (the Mac's own name is not "taken").
	func checkRename(id: UUID, to name: String) -> Result<String, RemoteMacProblem> {
		let kept: String
		switch parseRemoteName(name) {
		case .success(let value): kept = value
		case .failure(let problem): return .failure(.name(problem))
		}
		if let other = macs.first(where: { $0.id != id && foldedName($0.name) == foldedName(kept) }) {
			return .failure(.name(.taken(other.name)))
		}
		return .success(kept)
	}
}

// MARK: - The file

/// A date in the file: absent (or null), a date, or something that is not one.
private enum Stamp {
	case absent
	case date(Date)
	case invalid
}

private func stamp(_ value: Any?) -> Stamp {
	guard let value, !(value is NSNull) else { return .absent }
	guard let text = value as? String else { return .invalid }
	let plain = ISO8601DateFormatter()
	let fractional = ISO8601DateFormatter()
	fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
	if let date = plain.date(from: text) ?? fractional.date(from: text) { return .date(date) }
	return .invalid
}

/// One record as the file and the server's answers have it (`{ id, name, host, team, storeId, added, lastConnected }`), or nil
/// when it cannot be one. A part that does not fit in a record that is otherwise good (a team that is no team, a date that is
/// none) is left out of it. That the names and hosts of a list are unique is the list's to see (`decodeRemoteMacs`).
func remoteMac(fromRecord e: [String: Any]) -> RemoteMac? {
	guard let idText = e["id"] as? String, let id = UUID(uuidString: idText),
		let storeText = e["storeId"] as? String, let store = UUID(uuidString: storeText),
		let rawName = e["name"] as? String, case .success(let name) = parseRemoteName(rawName),
		let rawHost = e["host"] as? String, case .success(let host) = parseRemoteAddress(rawHost), host == rawHost,
		case .date(let added) = stamp(e["added"])
	else { return nil }
	var team: String?
	if let text = e["team"] as? String, isTeamName(text) { team = text }
	var lastConnected: Date?
	if case .date(let date) = stamp(e["lastConnected"]) { lastConnected = date }
	return RemoteMac(id: id, name: name, host: host, team: team, storeId: store, added: added, lastConnected: lastConnected)
}

/// What a file holds, as far as it can be trusted: `{ "version": 1, "macs": [ … ] }`. A file that is no JSON of this shape holds
/// no Mac; an entry that does not fit, or repeats an id, a store, a host or a name (case, accents and width aside) of one before
/// it, or comes after the tenth, is left out. Ids and stores may be in either case (an older app wrote them in capitals).
func decodeRemoteMacs(_ data: Data) -> RemoteMacList {
	guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], object["version"] as? Int == 1,
		let entries = object["macs"] as? [Any]
	else { return RemoteMacList() }
	var macs: [RemoteMac] = []
	var ids = Set<UUID>(), stores = Set<UUID>()
	for entry in entries {
		guard macs.count < RemoteMacList.limit, let e = entry as? [String: Any], let mac = remoteMac(fromRecord: e),
			!ids.contains(mac.id), !stores.contains(mac.storeId),
			!macs.contains(where: { $0.host == mac.host || foldedName($0.name) == foldedName(mac.name) })
		else { continue }
		macs.append(mac)
		ids.insert(mac.id)
		stores.insert(mac.storeId)
	}
	return RemoteMacList(macs)
}

/// What tells one version of the file from another: the server writes a file of its own and renames it into place, so a change
/// is a new inode, and the time and size say it also for a file that was edited in place.
struct FileStamp: Equatable {
	var seconds: Int
	var nanoseconds: Int
	var size: Int64
	var inode: UInt64
}

func fileStamp(atPath path: String) -> FileStamp? {
	var info = stat()
	guard stat(path, &info) == 0 else { return nil }
	return FileStamp(
		seconds: Int(info.st_mtimespec.tv_sec), nanoseconds: Int(info.st_mtimespec.tv_nsec), size: Int64(info.st_size),
		inode: UInt64(info.st_ino))
}

/// The saved list, read from `remote-macs.json` under the app's data dir (so that an instance with another data dir, a test,
/// never touches the real one). It only reads: the server writes the file, and this never does (no file is made, no mode or time
/// of the file is changed). `list` is the file as it is now, read again when its stamp changed (and never when it did not); a file
/// that is missing is an empty list, one that cannot be read or trusted is what can be read of it. For the main thread.
final class RemoteMacStore {
	static let fileName = "remote-macs.json"
	let file: URL
	private var known: (stamp: FileStamp?, list: RemoteMacList)?

	init(directory: URL) {
		file = directory.appendingPathComponent(RemoteMacStore.fileName)
	}

	var list: RemoteMacList {
		// The stamp is taken before the file is read: a file that is replaced in between is read again the next time.
		let stamp = fileStamp(atPath: file.path)
		if let known, known.stamp == stamp { return known.list }
		guard stamp != nil else {
			known = (nil, RemoteMacList())
			return RemoteMacList()
		}
		// A file that is there and cannot be read now (permissions, a moment's race) is tried again next time.
		guard let data = try? Data(contentsOf: file) else { return RemoteMacList() }
		let list = decodeRemoteMacs(data)
		known = (stamp, list)
		return list
	}
}

// MARK: - Asking the server to change the list

/// Why the server did not make a change.
enum MacsServerError: Error, Equatable {
	/// The app's server is not up (no origin yet, or none any more), refused the connection, or did not answer in time.
	case unreachable
	/// The server answered, and not with what a change gets: its status and its (English) words. A change is refused whole.
	case refused(status: Int, message: String)
}

/// A change of the list, as the app asks for it.
enum MacsCall: Equatable {
	case add(name: String, address: String, team: String?)
	case rename(id: UUID, name: String)
	case remove(id: UUID)
	case connected(id: UUID)
	case pin(id: UUID, team: String)
}

/// How long a change waits for the server (it is on this computer: it answers at once or not at all).
let macsRequestTimeout: TimeInterval = 5

/// The request for a change: the server's own local-only routes, signed in with this launch's token like every other call the
/// app makes (the header that says it is the app and not a page, and the type of the body, on all of them: none is a GET).
func macsRequest(_ call: MacsCall, origin: URL, token: String, timeout: TimeInterval = macsRequestTimeout) -> URLRequest {
	let method: String
	let path: String
	var body: [String: String]?
	switch call {
	case .add(let name, let address, let team):
		method = "POST"
		path = "api/macs"
		body = ["name": name, "address": address]
		if let team { body?["team"] = team }
	case .rename(let id, let name):
		method = "POST"
		path = "api/macs/\(id.uuidString)/rename"
		body = ["name": name]
	case .remove(let id):
		method = "DELETE"
		path = "api/macs/\(id.uuidString)"
	case .connected(let id):
		method = "POST"
		path = "api/macs/\(id.uuidString)/connected"
	case .pin(let id, let team):
		method = "POST"
		path = "api/macs/\(id.uuidString)/team"
		body = ["team": team]
	}
	var request = URLRequest(url: origin.appendingPathComponent(path))
	request.httpMethod = method
	request.setValue(token, forHTTPHeaderField: "x-omp-webui-token")
	request.setValue("1", forHTTPHeaderField: "x-omp-webui")
	request.setValue("application/json", forHTTPHeaderField: "content-type")
	if let body { request.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) }
	request.timeoutInterval = timeout
	return request
}

private func macsReply(status: Int, data: Data) -> Result<[String: Any], MacsServerError> {
	let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
	guard status == 200 else {
		let message = (object?["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
		return .failure(.refused(status: status, message: message ?? "HTTP \(status)"))
	}
	guard let object else { return .failure(.refused(status: status, message: "The answer could not be read")) }
	return .success(object)
}

/// The answer to a change that makes or changes a Mac: `{ "mac": <record> }`, the record as the list holds it now.
func macsReplyMac(status: Int, data: Data) -> Result<RemoteMac, MacsServerError> {
	switch macsReply(status: status, data: data) {
	case .failure(let error): return .failure(error)
	case .success(let object):
		guard let record = object["mac"] as? [String: Any], let mac = remoteMac(fromRecord: record) else {
			return .failure(.refused(status: status, message: "The answer could not be read"))
		}
		return .success(mac)
	}
}

/// The answer to the removal of a Mac: `{ "ok": true }`.
func macsReplyRemoved(status: Int, data: Data) -> Result<Void, MacsServerError> {
	switch macsReply(status: status, data: data) {
	case .failure(let error): return .failure(error)
	case .success(let object):
		guard object["ok"] as? Bool == true else {
			return .failure(.refused(status: status, message: "The answer could not be read"))
		}
		return .success(())
	}
}

/// Asks the app's own server to change the list of Macs. `server` says where it is and the token that signs in (nil: it is not
/// up). The completions run on the main queue, always after the call returned. `timeout`: a test shortens it.
final class RemoteMacsClient {
	private let server: () -> (origin: URL, token: String)?
	private let timeout: TimeInterval
	private let session: URLSession

	init(timeout: TimeInterval = macsRequestTimeout, server: @escaping () -> (origin: URL, token: String)?) {
		self.server = server
		self.timeout = timeout
		let configuration = URLSessionConfiguration.ephemeral
		configuration.httpShouldSetCookies = false
		configuration.httpCookieAcceptPolicy = .never
		configuration.urlCache = nil
		// The server is on this computer: nothing a proxy setting says is for it.
		configuration.connectionProxyDictionary = [:]
		configuration.timeoutIntervalForRequest = timeout
		configuration.timeoutIntervalForResource = timeout
		session = URLSession(configuration: configuration)
	}

	deinit { session.finishTasksAndInvalidate() }

	func add(name: String, address: String, team: String?, completion: @escaping (Result<RemoteMac, MacsServerError>) -> Void) {
		send(.add(name: name, address: address, team: team), decode: macsReplyMac, completion: completion)
	}

	func rename(id: UUID, to name: String, completion: @escaping (Result<RemoteMac, MacsServerError>) -> Void) {
		send(.rename(id: id, name: name), decode: macsReplyMac, completion: completion)
	}

	func remove(id: UUID, completion: @escaping (Result<Void, MacsServerError>) -> Void) {
		send(.remove(id: id), decode: macsReplyRemoved, completion: completion)
	}

	/// A window of this Mac was signed in. Best effort: a failure is not said, the next connection tries again.
	func connected(id: UUID) { send(.connected(id: id), decode: macsReplyMac) { _ in } }

	/// The team of this Mac's sign-in was seen (the server keeps the first one). Best effort, as `connected`.
	func pin(id: UUID, team: String) { send(.pin(id: id, team: team), decode: macsReplyMac) { _ in } }

	private func send<T>(
		_ call: MacsCall, decode: @escaping (Int, Data) -> Result<T, MacsServerError>,
		completion: @escaping (Result<T, MacsServerError>) -> Void
	) {
		guard let server = server() else {
			DispatchQueue.main.async { completion(.failure(.unreachable)) }
			return
		}
		let request = macsRequest(call, origin: server.origin, token: server.token, timeout: timeout)
		session.dataTask(with: request) { data, response, error in
			let result: Result<T, MacsServerError>
			if error == nil, let http = response as? HTTPURLResponse {
				result = decode(http.statusCode, data ?? Data())
			} else {
				result = .failure(.unreachable)
			}
			DispatchQueue.main.async { completion(result) }
		}.resume()
	}
}

// MARK: - What the page asks of the list

/// What the app's own page may ask of the Macs (the script message handler `ompwMacs`, `MacsBridge`).
enum MacsBridgeAction: Equatable {
	/// Open (or bring forward) the window of the saved Mac with this id.
	case open(UUID)
	/// Show the sheet that adds a Mac.
	case add
}

/// What a message of the page asks for: `{ type: "open", id: "<uuid>" }` or `{ type: "add" }`; nil for anything else. The page
/// never names a host or an address: only the id of a Mac the app looks up in its own list (either case of the UUID).
func macsBridgeAction(body: Any) -> MacsBridgeAction? {
	guard let message = body as? [String: Any], let type = message["type"] as? String else { return nil }
	switch type {
	case "open":
		guard let text = message["id"] as? String, let id = UUID(uuidString: text) else { return nil }
		return .open(id)
	case "add": return .add
	default: return nil
	}
}

// MARK: - Looking at an address before it is saved

/// Why a request that was made for a probe did not answer.
enum ProbeFailure: Equatable {
	case offline
	case hostNotFound
	case timedOut
	case secure
	case other
}

func probeFailure(urlErrorCode code: Int) -> ProbeFailure {
	switch code {
	case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorDataNotAllowed: return .offline
	case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: return .hostNotFound
	case NSURLErrorTimedOut: return .timedOut
	case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted,
		NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid, NSURLErrorClientCertificateRejected,
		NSURLErrorClientCertificateRequired:
		return .secure
	default: return .other
	}
}

/// What `GET https://<host>/` without cookies said, with redirects not followed.
enum ProbeResult: Equatable {
	/// Redirected to the sign-in of a Cloudflare Access team: Access is in front, and this is its team.
	case access(team: String)
	/// Redirected somewhere else (the host, "" when the address does not parse).
	case redirected(host: String)
	/// 403 from the server itself: reachable, but not behind Access (or remote access is off on that Mac).
	case forbidden
	/// A page without any sign-in.
	case open(status: Int)
	/// Another answer (a tunnel that has no Mac behind it answers 502, 530…).
	case httpError(status: Int)
	case unreachable(ProbeFailure)
}

/// The team of an Access sign-in address: `https://<team>.cloudflareaccess.com/…`.
func accessTeam(ofHost host: String) -> String? {
	let suffix = ".cloudflareaccess.com"
	let host = host.lowercased()
	guard host.hasSuffix(suffix) else { return nil }
	let team = String(host.dropLast(suffix.count))
	return isTeamName(team) ? team : nil
}

/// What a probe's answer means. `status` and `location` are the answer's; `failure` is the URL error code of a request that
/// got none.
func classifyProbe(host: String, status: Int?, location: String?, failure: Int?) -> ProbeResult {
	guard let status else { return .unreachable(probeFailure(urlErrorCode: failure ?? NSURLErrorUnknown)) }
	if (300...399).contains(status) {
		let target = location.flatMap { URL(string: $0, relativeTo: URL(string: "https://\(host)/")) }
		let targetHost = target?.host?.lowercased() ?? ""
		if target?.scheme?.lowercased() == "https", let team = accessTeam(ofHost: targetHost) { return .access(team: team) }
		return .redirected(host: targetHost)
	}
	if status == 403 { return .forbidden }
	if (200...299).contains(status) { return .open(status: status) }
	return .httpError(status: status)
}

/// Looks at `https://<host>/` the way a browser that has never been there would, and says what answered. No cookies, no
/// credentials, redirects not followed (the redirect is the answer). `completion` runs on the main queue.
final class RemoteProbe: NSObject, URLSessionTaskDelegate {
	private let host: String
	private let completion: (ProbeResult) -> Void
	private var session: URLSession?

	private init(host: String, completion: @escaping (ProbeResult) -> Void) {
		self.host = host
		self.completion = completion
	}

	static func run(host: String, timeout: TimeInterval = 8, completion: @escaping (ProbeResult) -> Void) {
		let probe = RemoteProbe(host: host, completion: completion)
		let configuration = URLSessionConfiguration.ephemeral
		configuration.httpCookieAcceptPolicy = .never
		configuration.httpShouldSetCookies = false
		configuration.urlCache = nil
		configuration.timeoutIntervalForRequest = timeout
		configuration.timeoutIntervalForResource = timeout
		let session = URLSession(configuration: configuration, delegate: probe, delegateQueue: nil)
		probe.session = session
		var request = URLRequest(url: URL(string: "https://\(host)/")!)
		request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
		request.setValue("text/html", forHTTPHeaderField: "Accept")
		session.dataTask(with: request) { _, response, error in
			let http = response as? HTTPURLResponse
			let result = classifyProbe(
				host: host, status: http?.statusCode, location: http?.value(forHTTPHeaderField: "Location"),
				failure: (error as NSError?)?.code)
			// Releases the session, which holds this object as its delegate.
			probe.session?.finishTasksAndInvalidate()
			probe.session = nil
			DispatchQueue.main.async { probe.completion(result) }
		}.resume()
	}

	func urlSession(
		_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
		newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
	) {
		completionHandler(nil)
	}
}
