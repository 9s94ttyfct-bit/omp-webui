import AppKit
import Foundation
import WebKit

// Harness for macos/remotemacs.swift, macos/remotepolicy.swift and the page's bridge of macos/remotemenu.swift (#614, #628):
// which addresses and names a remote Mac may have, the saved list as the app reads it (the local server writes the file), the
// data store a Mac's window signs in with (one for each Cloudflare team), what the app asks the server for and what it makes of
// the answers, what the page's switcher may ask, what a probe's answer means, what a window onto a remote Mac follows, how it
// is labelled and worded, and which requests its web view refuses. No window, no server of the app, no network but the
// loopback servers of the test's. Prints one JSON object (see tests/unit/macos-remote.test.ts). Modes:
//
//   pure <dir> [webkit]  everything that is plain values; `dir` is a scratch directory (it holds `vectors.json`, the addresses and names to try, and the saved-list files); `webkit` also has WebKit compile the blocker
//   client <live> <dead> <hang>  the app's client of the server's routes against the test's stub on port `live`, a port nothing listens on, and a stub that never answers
//   order <port>         a windowless web view on the test's http server: the order of the delegate's calls for a redirect chain, a page's
//                        own navigations and a chain that passes the Mac's own address, replayed through the navigator
//   vectors <0|1> <ports> [blank]  a windowless web view whose page tries 16 ways to reach 127.0.0.1 (one port each, comma separated),
//                        with the blocker (1) or without (0), in an http page or in about:blank; the test counts connections per port
//   window <dir> <portsA> <portsB>  the app's own menu, session, window and pop-out objects, made as the app makes them and never
//                        ordered in (never on the screen): labels, layout, the bar's widths, bridges and blocker, to a host that never resolves

/// `main.swift` of the app names the app; the words say its name.
let appName = "omp-webui"

setvbuf(stdout, nil, _IOLBF, 0)

func json(_ value: Any) -> String {
	String(data: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
}

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "pure"

// MARK: descriptions

func describe(_ problem: AddressProblem) -> String {
	switch problem {
	case .empty: return "empty"
	case .notHTTPS(let scheme): return "notHTTPS:\(scheme)"
	case .userInfo: return "userInfo"
	case .port: return "port"
	case .path: return "path"
	case .ipAddress: return "ipAddress"
	case .trailingDot: return "trailingDot"
	case .notASCII: return "notASCII"
	case .localName: return "localName"
	case .accessDomain: return "accessDomain"
	case .notDomainName: return "notDomainName"
	}
}

func describe(_ problem: RemoteMacProblem) -> String {
	switch problem {
	case .name(.empty): return "name:empty"
	case .name(.tooLong): return "name:tooLong"
	case .name(.characters): return "name:characters"
	case .name(.taken(let other)): return "name:taken:\(other)"
	case .address(let a): return "address:\(describe(a))"
	case .hostTaken(let other): return "hostTaken:\(other)"
	case .full: return "full"
	}
}

func describe(_ result: ProbeResult) -> String {
	switch result {
	case .access(let team): return "access:\(team)"
	case .redirected(let host): return "redirected:\(host)"
	case .forbidden: return "forbidden"
	case .open(let status): return "open:\(status)"
	case .httpError(let status): return "httpError:\(status)"
	case .unreachable(let failure): return "unreachable:\(failure)"
	}
}

func describe(_ verdict: RemoteVerdict) -> String {
	switch verdict {
	case .allow: return "allow"
	case .signIn(let team): return "signIn:\(team)"
	case .signInStep: return "signInStep"
	case .openExternally: return "openExternally"
	case .cancel: return "cancel"
	case .teamMismatch(let host): return "teamMismatch:\(host)"
	}
}

func describe(_ phase: RemotePhase) -> String {
	switch phase {
	case .loading: return "loading"
	case .signingIn: return "signingIn"
	case .connected: return "connected"
	}
}

func parse(_ text: String) -> String {
	switch parseRemoteAddress(text) {
	case .success(let host): return "ok:\(host)"
	case .failure(let problem): return describe(problem)
	}
}

func parseName(_ text: String) -> String {
	switch parseRemoteName(text) {
	case .success(let name): return "ok:\(name)"
	case .failure(.empty): return "empty"
	case .failure(.tooLong): return "tooLong"
	case .failure(.characters): return "characters"
	case .failure(.taken(let other)): return "taken:\(other)"
	}
}

func outcome<T>(_ result: Result<T, RemoteMacProblem>, _ ok: (T) -> String) -> String {
	switch result {
	case .success(let value): return "ok:\(ok(value))"
	case .failure(let problem): return describe(problem)
	}
}

// MARK: the navigator, replayed

/// The addresses of the replays (the names are what the events say: `decide:team`).
let replayURLs: [String: String] = [
	"own": "https://omp.example.com/", "ownAuth": "https://omp.example.com/cdn-cgi/access/authorized?code=1",
	"team": "https://myteam.cloudflareaccess.com/cdn-cgi/access/login/omp.example.com", "idp": "https://login.idp.example/auth",
	"idp2": "https://login2.idp.example/", "evil": "https://evil.example/",
]

/// Feed events to a `RemoteNavigator` and say what it made of each: `decide:<name>` (a main-frame decision), `start`
/// (`didStartProvisionalNavigation`), `redirect` (`didReceiveServerRedirect…`), `commit:<name>`, `fail` (a failure or a cancel).
/// The replay ends at the first decision that cancels or the first load that is stopped: nothing after it would have happened.
func replay(_ events: [String], site: RemoteSite) -> [String] {
	var navigator = RemoteNavigator()
	var out: [String] = []
	for event in events {
		let parts = event.split(separator: ":", maxSplits: 1).map(String.init)
		switch parts[0] {
		case "decide":
			let verdict = navigator.decide(url: URL(string: replayURLs[parts[1]]!), site: site, mainFrame: true, clicked: false)
			out.append("decide \(parts[1]) → \(describe(verdict))")
			if verdict == .cancel { return out }
		case "start":
			let stop = navigator.started()
			out.append("start → \(stop ? "stop" : "go")")
			if stop { return out }
		case "redirect":
			navigator.redirected()
			out.append("redirect")
		case "commit":
			switch navigator.committed(URL(string: replayURLs[parts[1]]!), site: site) {
			case .ignored: out.append("commit \(parts[1]) → ignored")
			case .moved(let phase, let pin): out.append("commit \(parts[1]) → \(describe(phase)) pin=\(pin ?? "-")")
			case .unexpected(let host): out.append("commit \(parts[1]) → unexpected \(host) (\(describe(navigator.phase)))")
			}
		case "fail":
			navigator.ended()
			out.append("fail")
		default:
			out.append("?\(event)")
		}
	}
	return out
}

/// What a request to the server came to, in one line: `ok:<what>`, `unreachable`, or `refused:<status>:<the server's words>`.
func served<T>(_ result: Result<T, MacsServerError>, _ ok: (T) -> String) -> String {
	switch result {
	case .success(let value): return "ok:\(ok(value))"
	case .failure(.unreachable): return "unreachable"
	case .failure(.refused(let status, let message)): return "refused:\(status):\(message)"
	}
}

// MARK: pure

func pure(directory: URL) -> [String: Any] {
	var report: [String: Any] = [:]

	// Addresses and names: the inputs are the test's (tests/support/mac-vectors.ts, which the server's own parser is held to as
	// well): the harness says what each one is.
	let vectors = (try! JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("vectors.json")))) as! [String: [String]]
	var addressReport: [String: String] = [:]
	for text in vectors["addresses"]! { addressReport[text] = parse(text) }
	report["addresses"] = addressReport
	var nameReport: [String: String] = [:]
	for text in vectors["names"]! { nameReport[text] = parseName(text) }
	report["names"] = nameReport
	// What two names are compared by (`foldedName`): the fold of each name the test names, so that it can say which are one.
	let foldReport: [String] = vectors["folds"]!.map { foldedName($0) }
	report["folds"] = foldReport

	let now = Date(timeIntervalSince1970: 1_800_000_000.75)

	// The list the app reads: what a name and an address are checked against.
	func make(_ name: String, _ host: String, team: String? = nil, id: UUID = UUID(), store: UUID = UUID()) -> RemoteMac {
		RemoteMac(id: id, name: name, host: host, team: team, storeId: store, added: now, lastConnected: nil)
	}
	let a = make("Mac A", "omp.example.com", team: "myteam")
	let b = make("Mac B", "b.example.com")
	let list = RemoteMacList([a, b])
	var steps: [String: String] = [:]
	steps["lookup"] = list.mac(id: b.id)?.name ?? "nil"
	steps["lookupUnknown"] = list.mac(id: UUID())?.name ?? "nil"
	steps["newOk"] = outcome(list.checkNew(name: "  Mac C ", address: "https://C.example.com/")) { "\($0.name)@\($0.host)" }
	// Case, accents and width do not make a name another one: the name is what tells two windows apart.
	steps["sameNameLowerCase"] = outcome(list.checkNew(name: "mac a", address: "c.example.com")) { $0.name }
	steps["sameNameAccents"] = outcome(list.checkNew(name: "MAC Á", address: "c.example.com")) { $0.name }
	steps["sameNameWidth"] = outcome(list.checkNew(name: "Ｍac A", address: "c.example.com")) { $0.name }
	steps["sameHost"] = outcome(list.checkNew(name: "Mac C", address: "https://OMP.example.com/")) { $0.name }
	steps["badName"] = outcome(list.checkNew(name: "\n", address: "c.example.com")) { $0.name }
	steps["badAddress"] = outcome(list.checkNew(name: "Mac C", address: "127.0.0.1")) { $0.name }
	steps["renameToTaken"] = outcome(list.checkRename(id: b.id, to: " MAC a ")) { $0 }
	steps["renameToOwnCase"] = outcome(list.checkRename(id: a.id, to: "MAC A")) { $0 }
	steps["renameUnchanged"] = outcome(list.checkRename(id: a.id, to: "Mac A")) { $0 }
	steps["renameInvalid"] = outcome(list.checkRename(id: a.id, to: "\n")) { $0 }
	let full = RemoteMacList((0..<RemoteMacList.limit).map { make("Mac \($0)", "m\($0).example.com") })
	steps["limit"] = String(RemoteMacList.limit)
	steps["fullCount"] = String(full.macs.count)
	steps["checkNewWhenFull"] = outcome(full.checkNew(name: "Another", address: "x.example.com")) { $0.name }
	report["list"] = steps

	// The data store of a Mac's window: the Macs of one Cloudflare team share one, any other has its own.
	let teamsSeen = ["myteam", "otherteam", "a", "a-b-1", String(repeating: "x", count: 63)]
	func bits(_ id: UUID) -> [Int] { [Int(id.uuid.6 >> 4), Int(id.uuid.8 >> 6)] }
	let s1 = make("S1", "s1.example.com", team: "myteam"), s2 = make("S2", "s2.example.com", team: "myteam")
	let s3 = make("S3", "s3.example.com", team: "otherteam"), s4 = make("S4", "s4.example.com"), s5 = make("S5", "s5.example.com")
	func label(_ id: UUID) -> String {
		for team in teamsSeen where teamStoreIdentifier(team) == id { return "team:\(team)" }
		for (name, mac) in [("s1", s1), ("s2", s2), ("s3", s3), ("s4", s4), ("s5", s5)] where mac.storeId == id { return "own:\(name)" }
		return "?"
	}
	report["teamStores"] = [
		"myteam": teamStoreIdentifier("myteam").uuidString, "otherteam": teamStoreIdentifier("otherteam").uuidString,
		"a": teamStoreIdentifier("a").uuidString, "stable": teamStoreIdentifier("myteam") == teamStoreIdentifier("myteam"),
		"distinct": Set(teamsSeen.map { teamStoreIdentifier($0) }).count, "teams": teamsSeen.count,
		"bits": teamsSeen.map { bits(teamStoreIdentifier($0)) },
		"notTheMacs": teamStoreIdentifier("myteam") != s1.storeId && teamStoreIdentifier("myteam") != s1.id,
	] as [String: Any]
	report["storeChoice"] = [
		"teamMacUsesTeamStore": s1.storeIdentifier == teamStoreIdentifier("myteam"),
		"sameTeamShares": s1.storeIdentifier == s2.storeIdentifier,
		"otherTeamDiffers": s3.storeIdentifier != s1.storeIdentifier && s3.storeIdentifier == teamStoreIdentifier("otherteam"),
		"noTeamUsesOwn": s4.storeIdentifier == s4.storeId,
		"noTeamsDiffer": s4.storeIdentifier != s5.storeIdentifier,
		"teamIsNotOwn": s1.storeIdentifier != s1.storeId,
		// Forgetting: a store goes only when no Mac that is left uses it, and the Mac's own old store goes as well.
		"forgetWhileTeamStays": storesToRemove(forgetting: s1, remaining: [s1, s2, s3, s4]).map(label),
		"forgetLastOfTeam": storesToRemove(forgetting: s1, remaining: [s1, s3, s4]).map(label),
		"forgetNoTeam": storesToRemove(forgetting: s4, remaining: [s1, s4, s5]).map(label),
		"forgetOnlyMac": storesToRemove(forgetting: s3, remaining: [s3]).map(label),
	] as [String: Any]
	// What forgetting a Mac takes out of a store that stays (`removeOriginData`): the pure rules.
	let o1 = make("O1", "a.example.com", team: "myteam"), o2 = make("O2", "b.example.com", team: "myteam")
	let o3 = make("O3", "c.other.org", team: "myteam"), o4 = make("O4", "d.example.com", team: "otherteam")
	report["originRules"] = [
		"cookieOwnHost": cookieIsOwn(domain: "a.example.com", host: "a.example.com"),
		"cookieOwnDotHostAnyCase": cookieIsOwn(domain: ".A.Example.COM", host: "a.example.com"),
		"cookieParentIsNot": !cookieIsOwn(domain: ".example.com", host: "a.example.com"),
		"cookieSiblingIsNot": !cookieIsOwn(domain: "b.example.com", host: "a.example.com"),
		"cookieLongerNameIsNot": !cookieIsOwn(domain: "xa.example.com", host: "a.example.com"),
		"cookieChildIsNot": !cookieIsOwn(domain: "x.a.example.com", host: "a.example.com"),
		"recordOfTheDomain": recordHolds("example.com", host: "a.example.com"),
		"recordOfTheHost": recordHolds("a.example.com", host: "a.example.com"),
		"recordLookalikeIsNot": !recordHolds("ample.com", host: "a.example.com") && !recordHolds("xa.example.com", host: "a.example.com"),
		// A sibling of the same store under the same domain keeps the record whole; one of another store does not.
		"siblingKeepsTheRecord": recordsToRemove(forgetting: o1, remaining: [o1, o2, o3], recordNames: ["example.com", "other.org"]),
		"lastOfTheDomainTakesIt": recordsToRemove(forgetting: o1, remaining: [o1, o3], recordNames: ["example.com", "other.org", "a.example.com"]),
		"otherStoreDoesNotCount": recordsToRemove(forgetting: o1, remaining: [o1, o4], recordNames: ["example.com"]),
		"noRecordNoRemoval": recordsToRemove(forgetting: o1, remaining: [o1], recordNames: ["other.org"]),
	] as [String: Any]

	// The file: the server writes it, the app only reads it.
	var file: [String: Any] = [:]
	let fileManager = FileManager.default
	func fresh(_ name: String) -> URL {
		let url = directory.appendingPathComponent(name)
		try! fileManager.createDirectory(at: url, withIntermediateDirectories: true)
		return url
	}
	func read(_ url: URL) -> String { (try? String(contentsOf: url, encoding: .utf8)) ?? "<missing>" }
	func mode(_ url: URL) -> Int { ((try? fileManager.attributesOfItem(atPath: url.path))?[.posixPermissions] as? Int) ?? -1 }
	func listing(of url: URL) -> [String] { ((try? fileManager.contentsOfDirectory(atPath: url.path)) ?? []).sorted() }
	func modified(_ url: URL) -> Double { ((try? fileManager.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? -1 }
	/// What the server does: the new text in a file of its own, renamed into place (a new inode).
	func serverWrites(_ text: String, to url: URL) {
		let temporary = url.deletingLastPathComponent().appendingPathComponent("remote-macs.json.\(UUID().uuidString).tmp")
		try! text.write(to: temporary, atomically: false, encoding: .utf8)
		precondition(rename(temporary.path, url.path) == 0)
	}
	func shape(_ store: RemoteMacStore) -> [String: Any] {
		let macs = store.list.macs
		return [
			"names": macs.map(\.name), "hosts": macs.map(\.host), "ids": macs.map { $0.id.uuidString },
			"stores": macs.map { $0.storeId.uuidString }, "teams": macs.map { $0.team ?? "nil" },
			"added": macs.map { $0.added.timeIntervalSince1970 }, "last": macs.map { $0.lastConnected?.timeIntervalSince1970 ?? -1 },
		]
	}

	// A list that is not there is an empty list: of a data dir with no file, and of one that is not there at all (which stays so).
	let clean = fresh("clean")
	let absent = RemoteMacStore(directory: clean)
	file["missingReadsEmpty"] = absent.list.macs.isEmpty
	file["missingFileStaysMissing"] = !fileManager.fileExists(atPath: absent.file.path) && listing(of: clean).isEmpty
	let nowhere = directory.appendingPathComponent("not-yet/deeper")
	let none = RemoteMacStore(directory: nowhere)
	file["missingDirectoryReadsEmpty"] = none.list.macs.isEmpty
	file["missingDirectoryStaysMissing"] = !fileManager.fileExists(atPath: nowhere.path)
	file["fileName"] = RemoteMacStore.fileName

	// What v0.11.12's app wrote (capital UUIDs, `"key" : value`) and what the server writes (lower case) read the same.
	let legacyText = """
		{
		  "macs" : [
		    {
		      "added" : "2026-10-23T09:00:00Z",
		      "host" : "omp.example.com",
		      "id" : "3F2504E0-4F89-11D3-9A0C-0305E82C3301",
		      "lastConnected" : "2027-01-15T08:00:00Z",
		      "name" : "Mac A",
		      "storeId" : "7C9E6679-7425-40DE-944B-E07FC1F90AE7",
		      "team" : "myteam"
		    },
		    {
		      "added" : "2026-10-23T09:30:00Z",
		      "host" : "b.example.com",
		      "id" : "9B2D5C1E-0A6F-4C58-8E21-5D3B7A9F4E10",
		      "lastConnected" : null,
		      "name" : "Mac B",
		      "storeId" : "1E4F8A22-6B3C-4D79-A0E5-C2F7B9D81A34",
		      "team" : null
		    }
		  ],
		  "version" : 1
		}

		"""
	// What the server writes: `JSON.stringify(…, null, 2)`, identifiers as `crypto.randomUUID` makes them (lower case).
	let serverText = """
		{
		  "macs": [
		    {
		      "added": "2026-10-23T09:00:00Z",
		      "host": "omp.example.com",
		      "id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
		      "lastConnected": "2027-01-15T08:00:00Z",
		      "name": "Mac A",
		      "storeId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
		      "team": "myteam"
		    },
		    {
		      "added": "2026-10-23T09:30:00Z",
		      "host": "b.example.com",
		      "id": "9b2d5c1e-0a6f-4c58-8e21-5d3b7a9f4e10",
		      "lastConnected": null,
		      "name": "Mac B",
		      "storeId": "1e4f8a22-6b3c-4d79-a0e5-c2f7b9d81a34",
		      "team": null
		    }
		  ],
		  "version": 1
		}

		"""
	let legacyDir = fresh("legacy"), serverDir = fresh("server")
	serverWrites(legacyText, to: legacyDir.appendingPathComponent(RemoteMacStore.fileName))
	serverWrites(serverText, to: serverDir.appendingPathComponent(RemoteMacStore.fileName))
	file["legacy"] = shape(RemoteMacStore(directory: legacyDir))
	file["server"] = shape(RemoteMacStore(directory: serverDir))
	file["serverTextHasLowerCaseIds"] = serverText.contains("3f2504e0-4f89-11d3-9a0c-0305e82c3301") && !serverText.contains("3F2504E0")
	file["idsEitherCase"] = UUID(uuidString: "3f2504e0-4f89-11d3-9a0c-0305e82c3301") == UUID(uuidString: "3F2504E0-4F89-11D3-9A0C-0305E82C3301")

	// `list` is the file as it is now: read again when the server replaced it or it was edited, not read again when nothing changed.
	let live = fresh("live")
	let liveFile = live.appendingPathComponent(RemoteMacStore.fileName)
	let follower = RemoteMacStore(directory: live)
	func names(_ store: RemoteMacStore) -> [String] { store.list.macs.map(\.name) }
	func record(_ name: String, host: String, id: String, store: String) -> String {
		"""
		{ "added": "2026-10-23T09:00:00Z", "host": "\(host)", "id": "\(id)", "lastConnected": null, "name": "\(name)", "storeId": "\(store)", "team": null }
		"""
	}
	func listText(_ records: [String]) -> String { "{\"macs\":[\(records.joined(separator: ","))],\"version\":1}\n" }
	let r1 = record("Alpha", host: "a.example.com", id: "11111111-1111-4111-8111-111111111111", store: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	let r2 = record("Beta", host: "b.example.com", id: "22222222-2222-4222-8222-222222222222", store: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	var reread: [String: [String]] = [:]
	reread["beforeFile"] = names(follower)
	serverWrites(listText([r1]), to: liveFile)
	reread["afterFirstWrite"] = names(follower)
	serverWrites(listText([r1, r2]), to: liveFile)
	reread["afterReplace"] = names(follower)
	// Edited in place by a person, to a text of another size.
	try! listText([r2]).write(to: liveFile, atomically: false, encoding: .utf8)
	reread["afterEditInPlace"] = names(follower)
	// A same-sized edit that leaves the time as it was cannot be seen by the stamp: the list read before is kept (nothing re-reads a file that looks the same).
	let stamp = fileStamp(atPath: liveFile.path)!
	try! listText([r2]).replacingOccurrences(of: "Beta", with: "Bola").write(to: liveFile, atomically: false, encoding: .utf8)
	var times = [timespec(tv_sec: stamp.seconds, tv_nsec: stamp.nanoseconds), timespec(tv_sec: stamp.seconds, tv_nsec: stamp.nanoseconds)]
	_ = utimensat(AT_FDCWD, liveFile.path, &times, 0)
	reread["sameStamp"] = names(follower)
	reread["freshReaderSeesIt"] = names(RemoteMacStore(directory: live))
	serverWrites("not json at all", to: liveFile)
	reread["afterGarbage"] = names(follower)
	serverWrites(listText([r1]), to: liveFile)
	reread["afterRepair"] = names(follower)
	file["reread"] = reread

	// A file that cannot be trusted is what can be read of it, never an error, and is left as it is (no `.damaged` copy, no rewrite).
	let damaged = fresh("damaged")
	let damagedFile = damaged.appendingPathComponent(RemoteMacStore.fileName)
	try! "not json at all".write(to: damagedFile, atomically: false, encoding: .utf8)
	try! fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: damagedFile.path)
	let beforeModified = modified(damagedFile)
	let broken = RemoteMacStore(directory: damaged)
	for _ in 0..<3 { _ = broken.list }
	file["garbageReadsEmpty"] = broken.list.macs.isEmpty
	file["garbageUntouched"] = read(damagedFile) == "not json at all" && mode(damagedFile) == 0o600 && modified(damagedFile) == beforeModified
	file["garbageDirectory"] = listing(of: damaged)
	// A file that cannot be opened reads as an empty list and is tried again (a permission that is given back).
	let locked = fresh("locked")
	let lockedFile = locked.appendingPathComponent(RemoteMacStore.fileName)
	serverWrites(listText([r1, r2]), to: lockedFile)
	try! fileManager.setAttributes([.posixPermissions: 0], ofItemAtPath: lockedFile.path)
	let lockedStore = RemoteMacStore(directory: locked)
	let canStillRead = (try? Data(contentsOf: lockedFile)) != nil
	file["unreadableReadsEmpty"] = canStillRead ? true : lockedStore.list.macs.isEmpty
	try! fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: lockedFile.path)
	file["unreadableRecovers"] = names(lockedStore) == ["Alpha", "Beta"]
	file["unreadableMode"] = mode(lockedFile)

	// The store never writes: every file it was pointed at is as it was, and nothing was made beside it.
	let quiet = fresh("quiet")
	let quietFile = quiet.appendingPathComponent(RemoteMacStore.fileName)
	serverWrites(listText([r1, r2]), to: quietFile)
	try! fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: quietFile.path)
	let quietBefore = (text: read(quietFile), mode: mode(quietFile), modified: modified(quietFile), listing: listing(of: quiet))
	let reader = RemoteMacStore(directory: quiet)
	for _ in 0..<5 { _ = reader.list; _ = reader.list.mac(id: UUID()) }
	_ = RemoteMacStore(directory: quiet).list
	file["neverWrites"] = [
		"text": read(quietFile) == quietBefore.text, "mode": mode(quietFile) == quietBefore.mode,
		"modified": modified(quietFile) == quietBefore.modified, "listing": listing(of: quiet) == quietBefore.listing,
		"read": names(reader),
	] as [String: Any]

	// Entries of the file that do not fit are left out; the others are read.
	let uuid = { UUID().uuidString }
	func entry(
		_ name: Any = "Mac", host: Any = "m.example.com", id: String? = nil, store: String? = nil, team: Any = NSNull(),
		added: Any = "2026-10-23T09:00:00Z", last: Any = NSNull()
	) -> [String: Any] {
		["id": id ?? uuid(), "name": name, "host": host, "team": team, "storeId": store ?? uuid(), "added": added, "lastConnected": last]
	}
	func decoded(_ macs: [[String: Any]], version: Any = 1) -> [String: Any] {
		let data = try! JSONSerialization.data(withJSONObject: ["version": version, "macs": macs])
		let macs = decodeRemoteMacs(data).macs
		return [
			"names": macs.map(\.name), "hosts": macs.map(\.host), "teams": macs.map { $0.team ?? "nil" },
			"last": macs.map { $0.lastConnected?.timeIntervalSince1970 ?? -1 },
		]
	}
	let sharedId = uuid()
	var decodes: [String: Any] = [:]
	decodes["good"] = decoded([entry("A", host: "a.example.com"), entry("B", host: "b.example.com", last: "2026-10-24T01:02:03Z")])
	decodes["badHost"] = decoded([entry("A", host: "127.0.0.1"), entry("B", host: "b.example.com")])
	decodes["upperHost"] = decoded([entry("A", host: "A.example.com")])
	decodes["badName"] = decoded([entry("\u{202E}A", host: "a.example.com"), entry("B", host: "b.example.com")])
	decodes["badId"] = decoded([entry("A", host: "a.example.com", id: "nope"), entry("B", host: "b.example.com")])
	decodes["badStore"] = decoded([entry("A", host: "a.example.com", store: "nope"), entry("B", host: "b.example.com")])
	decodes["badDate"] = decoded([entry("A", host: "a.example.com", added: "yesterday")])
	decodes["badLastConnected"] = decoded([entry("A", host: "a.example.com", last: "yesterday")])
	decodes["badTeam"] = decoded([entry("A", host: "a.example.com", team: "a.b")])
	decodes["teamNotAString"] = decoded([entry("A", host: "a.example.com", team: 7)])
	decodes["goodTeam"] = decoded([entry("A", host: "a.example.com", team: "myteam")])
	decodes["duplicateName"] = decoded([entry("A", host: "a.example.com"), entry("a", host: "b.example.com")])
	decodes["duplicateHost"] = decoded([entry("A", host: "a.example.com"), entry("B", host: "a.example.com")])
	decodes["duplicateId"] = decoded([entry("A", host: "a.example.com", id: sharedId), entry("B", host: "b.example.com", id: sharedId)])
	decodes["duplicateStore"] = decoded([entry("A", host: "a.example.com", store: sharedId), entry("B", host: "b.example.com", store: sharedId)])
	decodes["tooMany"] = decoded((0..<12).map { entry("M\($0)", host: "m\($0).example.com") })
	decodes["notAnEntry"] = decoded([["id": 1]])
	decodes["version2"] = decoded([entry("A", host: "a.example.com")], version: 2)
	decodes["noVersion"] = ["names": decodeRemoteMacs(Data("{\"macs\":[]}".utf8)).macs.map(\.name)]
	decodes["notAnObject"] = ["names": decodeRemoteMacs(Data("[]".utf8)).macs.map(\.name)]
	decodes["notJSON"] = ["names": decodeRemoteMacs(Data("not json".utf8)).macs.map(\.name)]
	decodes["emptyData"] = ["names": decodeRemoteMacs(Data()).macs.map(\.name)]
	decodes["empty"] = decoded([])
	decodes["fractionalDate"] = decoded([entry("A", host: "a.example.com", added: "2026-10-23T09:00:00.500Z")])
	file["decodes"] = decodes
	report["file"] = file

	// What the app asks the server, and what it makes of the answers: nothing of this is a network call.
	let origin = URL(string: "http://127.0.0.1:7878")!
	let idA = UUID(uuidString: "3F2504E0-4F89-11D3-9A0C-0305E82C3301")!
	func shaped(_ call: MacsCall) -> [String: Any] {
		let request = macsRequest(call, origin: origin, token: "launch-token")
		return [
			"method": request.httpMethod ?? "", "url": request.url?.absoluteString ?? "",
			"token": request.value(forHTTPHeaderField: "x-omp-webui-token") ?? "<none>",
			"app": request.value(forHTTPHeaderField: "x-omp-webui") ?? "<none>",
			"type": request.value(forHTTPHeaderField: "content-type") ?? "<none>",
			"body": request.httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? "<none>", "timeout": request.timeoutInterval,
		]
	}
	report["requests"] = [
		"add": shaped(.add(name: "Studio", address: "studio.example.com", team: nil)),
		"addWithTeam": shaped(.add(name: "Café \"quoted\" 💻", address: "https://Studio.example.com/", team: "myteam")),
		"rename": shaped(.rename(id: idA, name: "Mac Z")),
		"remove": shaped(.remove(id: idA)),
		"connected": shaped(.connected(id: idA)),
		"pin": shaped(.pin(id: idA, team: "myteam")),
		"shortTimeout": macsRequest(.connected(id: idA), origin: origin, token: "t", timeout: 0.5).timeoutInterval,
		"defaultTimeout": macsRequestTimeout,
	] as [String: Any]
	func answerText(_ name: String, team: String? = nil) -> String {
		"""
		{"mac":{"id":"3f2504e0-4f89-11d3-9a0c-0305e82c3301","name":"\(name)","host":"omp.example.com","team":\(team.map { "\"\($0)\"" } ?? "null"),"storeId":"7c9e6679-7425-40de-944b-e07fc1f90ae7","added":"2026-10-23T09:00:00Z","lastConnected":null}}
		"""
	}
	func mac(_ status: Int, _ body: String) -> String {
		served(macsReplyMac(status: status, data: Data(body.utf8))) { "\($0.name)@\($0.host)#\($0.team ?? "nil")" }
	}
	func removed(_ status: Int, _ body: String) -> String { served(macsReplyRemoved(status: status, data: Data(body.utf8))) { "removed" } }
	let taken = "{\"error\":\"Another Mac is already called “Mac A”\",\"problem\":{\"kind\":\"name\",\"code\":\"taken\",\"taken\":\"Mac A\"}}"
	report["replies"] = [
		"mac": mac(200, answerText("Mac A")), "macWithTeam": mac(200, answerText("Mac A", team: "myteam")),
		"refusedWithProblem": mac(400, taken), "notFound": mac(404, "{\"error\":\"No such Mac\"}"),
		"forbidden": mac(403, "{\"error\":\"The list of Macs is changed on this computer only\"}"),
		"wrongMethod": mac(405, "{\"error\":\"POST required\"}"), "emptyMessage": mac(400, "{\"error\":\"\"}"),
		"notJSON": mac(502, "<html>Bad gateway</html>"), "okButNotJSON": mac(200, "not json"),
		"okButNoMac": mac(200, "{\"ok\":true}"), "okButBadRecord": mac(200, "{\"mac\":{\"id\":\"nope\"}}"),
		"removed": removed(200, "{\"ok\":true}"), "removedNotOk": removed(200, "{\"ok\":false}"),
		"removedNotFound": removed(404, "{\"error\":\"No such Mac\"}"), "removedEmptyBody": removed(500, ""),
	]
	// With no server (it is not up yet, or no more) every change is `unreachable`, and answered later, on the main queue.
	var noServer: [String: String] = [:]
	let down = RemoteMacsClient(server: { nil })
	var answered = 0
	var calledBack = false
	down.add(name: "A", address: "a.example.com", team: nil) { noServer["add"] = served($0) { $0.name }; answered += 1 }
	calledBack = answered > 0
	down.rename(id: idA, to: "B") { noServer["rename"] = served($0) { $0.name }; answered += 1 }
	down.remove(id: idA) { noServer["remove"] = served($0) { "removed" }; answered += 1 }
	down.connected(id: idA)
	down.pin(id: idA, team: "myteam")
	runLoop(until: { answered == 3 }, seconds: 5)
	noServer["calledBackAtOnce"] = String(calledBack)
	report["noServer"] = noServer

	// What the page's switcher may ask: `open` with the id of a Mac, or `add`; nothing else, and only from the UI's own page.
	func action(_ body: Any) -> String {
		switch macsBridgeAction(body: body) {
		case .open(let id)?: return "open:\(id.uuidString)"
		case .add?: return "add"
		case nil: return "nil"
		}
	}
	let upper = "3F2504E0-4F89-11D3-9A0C-0305E82C3301"
	report["bridgeActions"] = [
		"open": action(["type": "open", "id": upper]), "openLower": action(["type": "open", "id": upper.lowercased()]),
		"openNoId": action(["type": "open"]), "openBadId": action(["type": "open", "id": "nope"]),
		"openEmptyId": action(["type": "open", "id": ""]), "openNumberId": action(["type": "open", "id": 7]),
		"openNullId": action(["type": "open", "id": NSNull()]), "openHost": action(["type": "open", "host": "evil.example"]),
		"openUrl": action(["type": "open", "id": "https://evil.example/"]), "add": action(["type": "add"]),
		"addExtra": action(["type": "add", "id": upper, "host": "evil.example"]),
		"remove": action(["type": "remove", "id": upper]), "rename": action(["type": "rename", "id": upper, "name": "x"]),
		"upperType": action(["type": "OPEN", "id": upper]), "emptyType": action(["type": ""]), "numberType": action(["type": 1]),
		"noType": action(["id": upper]), "string": action("open"), "list": action([["type": "add"]]), "null": action(NSNull()),
		"number": action(7), "empty": action([String: Any]()),
	]
	let own = URL(string: "http://127.0.0.1:7878")
	func request(
		scheme: String = "http", host: String = "127.0.0.1", port: Int = 7878, main: Bool = true, origin: URL? = own
	) -> String {
		switch macsBridgeRequest(isMainFrame: main, scheme: scheme, host: host, port: port, origin: origin, body: ["type": "add"]) {
		case .add?: return "allowed"
		case .open?: return "open"
		case nil: return "refused"
		}
	}
	report["bridgeSenders"] = [
		"own": request(), "subframe": request(main: false), "otherPort": request(port: 7879), "otherHost": request(host: "localhost"),
		"remoteHost": request(scheme: "https", host: "omp.example.com", port: 443), "https": request(scheme: "https"), "noOrigin": request(origin: nil),
		"noPort": request(origin: URL(string: "http://127.0.0.1")),
	]
	// The handler itself: it replies to every message, calls the app only for a good one, and shows the sheet after the reply.
	var opened: [UUID] = [], shown = 0
	let bridge = MacsBridge(origin: { own }, open: { opened.append($0); return $0 == idA }, add: { shown += 1 })
	func send(_ body: Any, main: Bool = true, port: Int = 7878) -> String {
		var reply: Any?
		bridge.handle(isMainFrame: main, scheme: "http", host: "127.0.0.1", port: port, body: body) { reply = $0 }
		guard let reply = reply as? [String: Any], let ok = reply["ok"] as? Bool else { return "no reply" }
		return "ok:\(ok)"
	}
	var handler: [String: Any] = [:]
	handler["openSaved"] = send(["type": "open", "id": upper])
	handler["openUnknown"] = send(["type": "open", "id": "00000000-0000-4000-8000-000000000404"])
	handler["openBad"] = send(["type": "open", "id": "nope"])
	handler["wrongType"] = send(["type": "close"])
	handler["notAnObject"] = send("add")
	handler["foreignPort"] = send(["type": "open", "id": upper], port: 80)
	handler["subframe"] = send(["type": "add"], main: false)
	handler["openedAfterRefusals"] = opened.map(\.uuidString)
	handler["shownAfterRefusals"] = shown
	handler["add"] = send(["type": "add"])
	handler["shownBeforeNextTurn"] = shown
	spin(0.1)
	handler["shownAfterNextTurn"] = shown
	report["bridgeHandler"] = handler

	// Probes.
	let probes: [(String, Int?, String?, Int?)] = [
		("access", 302, "https://myteam.cloudflareaccess.com/cdn-cgi/access/login/omp.example.com?kid=1&redirect_url=%2F", nil),
		("accessUpper", 302, "https://MyTeam.CloudflareAccess.com/x", nil),
		("accessOther3xx", 307, "https://myteam.cloudflareaccess.com/", nil),
		("relative", 302, "/cdn-cgi/access/login", nil),
		("elsewhere", 302, "https://evil.example/login", nil),
		("http", 302, "http://myteam.cloudflareaccess.com/x", nil),
		("dottedTeam", 301, "https://a.b.cloudflareaccess.com/", nil),
		("bareAccessDomain", 302, "https://cloudflareaccess.com/", nil),
		("noLocation", 302, nil, nil),
		("forbidden", 403, nil, nil),
		("ok", 200, nil, nil),
		("notFound", 404, nil, nil),
		("badGateway", 502, nil, nil),
		("tunnelDown", 530, nil, nil),
		("offline", nil, nil, NSURLErrorNotConnectedToInternet),
		("lost", nil, nil, NSURLErrorNetworkConnectionLost),
		("noHost", nil, nil, NSURLErrorCannotFindHost),
		("dns", nil, nil, NSURLErrorDNSLookupFailed),
		("timeout", nil, nil, NSURLErrorTimedOut),
		("untrusted", nil, nil, NSURLErrorServerCertificateUntrusted),
		("secure", nil, nil, NSURLErrorSecureConnectionFailed),
		("cannotConnect", nil, nil, NSURLErrorCannotConnectToHost),
		("unknown", nil, nil, nil),
	]
	var probeReport: [String: String] = [:]
	for (name, status, location, failure) in probes {
		probeReport[name] = describe(classifyProbe(host: "omp.example.com", status: status, location: location, failure: failure))
	}
	report["probes"] = probeReport
	report["teams"] = [
		"myteam.cloudflareaccess.com", "MYTEAM.cloudflareaccess.com", "a.b.cloudflareaccess.com", "cloudflareaccess.com",
		"myteam.cloudflareaccess.com.evil.com", "my_team.cloudflareaccess.com",
	].map { accessTeam(ofHost: $0) ?? "nil" }

	// What a window follows.
	let site = RemoteSite(host: "omp.example.com", team: "myteam")
	let unpinned = RemoteSite(host: "omp.example.com", team: nil)
	func verdict(
		_ url: String?, phase: RemotePhase = .connected, user: Bool = false, main: Bool = true, site: RemoteSite = site
	) -> String {
		describe(remoteNavigationVerdict(url: url.flatMap { URL(string: $0) }, site: site, phase: phase, userInitiated: user, mainFrame: main))
	}
	let team = "https://myteam.cloudflareaccess.com/cdn-cgi/access/login/omp.example.com"
	let other = "https://otherteam.cloudflareaccess.com/cdn-cgi/access/login/omp.example.com"
	var verdicts: [String: String] = [:]
	for phase in [RemotePhase.loading, .signingIn, .connected] {
		let p = describe(phase)
		verdicts["own/\(p)"] = verdict("https://omp.example.com/", phase: phase)
		verdicts["ownUpper/\(p)"] = verdict("https://OMP.example.com/x?y=1#z", phase: phase)
		verdicts["ownPort443/\(p)"] = verdict("https://omp.example.com:443/", phase: phase)
		verdicts["ownTrailingDot/\(p)"] = verdict("https://omp.example.com./", phase: phase)
		verdicts["ownOtherPort/\(p)"] = verdict("https://omp.example.com:8443/", phase: phase)
		verdicts["ownOtherPortClicked/\(p)"] = verdict("https://omp.example.com:8443/", phase: phase, user: true)
		verdicts["ownHTTP/\(p)"] = verdict("http://omp.example.com/", phase: phase)
		verdicts["ownHTTPClicked/\(p)"] = verdict("http://omp.example.com/", phase: phase, user: true)
		verdicts["team/\(p)"] = verdict(team, phase: phase)
		verdicts["teamUnpinned/\(p)"] = verdict(team, phase: phase, site: unpinned)
		verdicts["otherTeam/\(p)"] = verdict(other, phase: phase)
		verdicts["otherTeamUnpinned/\(p)"] = verdict(other, phase: phase, site: unpinned)
		verdicts["teamPort/\(p)"] = verdict("https://myteam.cloudflareaccess.com:8443/", phase: phase)
		verdicts["teamWithDot/\(p)"] = verdict("https://a.b.cloudflareaccess.com/", phase: phase)
		verdicts["idp/\(p)"] = verdict("https://login.idp.example/auth", phase: phase)
		verdicts["idpClicked/\(p)"] = verdict("https://login.idp.example/auth", phase: phase, user: true)
		verdicts["accessApex/\(p)"] = verdict("https://cloudflareaccess.com/", phase: phase)
		verdicts["lookalike/\(p)"] = verdict("https://omp.example.com.evil.com/", phase: phase)
		verdicts["pathLookalike/\(p)"] = verdict("https://evil.com/omp.example.com", phase: phase)
		verdicts["userinfoToEvil/\(p)"] = verdict("https://omp.example.com@evil.com/", phase: phase)
		verdicts["userinfoToOwn/\(p)"] = verdict("https://evil.com@omp.example.com/", phase: phase)
		verdicts["mailto/\(p)"] = verdict("mailto:a@b.example", phase: phase)
		verdicts["mailtoClicked/\(p)"] = verdict("mailto:a@b.example", phase: phase, user: true)
		verdicts["blank/\(p)"] = verdict("about:blank", phase: phase)
		verdicts["blob/\(p)"] = verdict("blob:https://omp.example.com/1234", phase: phase)
		verdicts["file/\(p)"] = verdict("file:///etc/passwd", phase: phase, user: true)
		verdicts["data/\(p)"] = verdict("data:text/html,x", phase: phase, user: true)
		verdicts["javascript/\(p)"] = verdict("javascript:alert(1)", phase: phase, user: true)
		verdicts["ssh/\(p)"] = verdict("ssh://host", phase: phase, user: true)
		verdicts["retry/\(p)"] = verdict("\(remoteRetryScheme):", phase: phase)
		verdicts["nil/\(p)"] = verdict(nil, phase: phase)
		verdicts["frameAnywhere/\(p)"] = verdict("https://anything.example/", phase: phase, main: false)
		verdicts["frameHTTP/\(p)"] = verdict("http://anything.example/", phase: phase, main: false)
		verdicts["frameData/\(p)"] = verdict("data:text/html,x", phase: phase, main: false)
		verdicts["frameFile/\(p)"] = verdict("file:///x", phase: phase, main: false)
		verdicts["frameMailto/\(p)"] = verdict("mailto:a@b.example", phase: phase, user: true, main: false)
		// A link the person clicked goes to the browser, but never an address of this Mac or its network (the browser has no blocker).
		for (name, url) in [
			("loopbackClicked", "https://127.0.0.1:7878/api/meta"), ("loopbackHTTPClicked", "http://127.0.0.1:7878/api/meta"),
			("localhostClicked", "https://localhost/"), ("localhostDotClicked", "http://localhost./"),
			("lanClicked", "http://192.168.1.2/"), ("singleLabelClicked", "https://router/"), ("localClicked", "https://nas.local/"),
			("multicastClicked", "https://224.0.0.251/"), ("publicHTTPClicked", "http://example.com/"),
		] {
			verdicts["\(name)/\(p)"] = verdict(url, phase: phase, user: true)
		}
	}
	report["verdicts"] = verdicts

	var phases: [String: String] = [:]
	func afterCommit(_ url: String?, _ previous: RemotePhase, viaHop: Bool = false, site: RemoteSite = site) -> String {
		remotePhase(afterCommit: url.flatMap { URL(string: $0) }, site: site, previous: previous, viaHop: viaHop).map(describe)
			?? "unexpected"
	}
	phases["own"] = afterCommit("https://omp.example.com/", .loading)
	phases["ownDeep"] = afterCommit("https://omp.example.com/api/x", .signingIn)
	phases["accessEndpoint"] = afterCommit("https://omp.example.com/cdn-cgi/access/authorized?code=1", .signingIn)
	phases["accessEndpointWhenConnected"] = afterCommit("https://omp.example.com/cdn-cgi/access/logout", .connected)
	phases["accessEndpointWhenLoading"] = afterCommit("https://omp.example.com/cdn-cgi/access/x", .loading)
	phases["team"] = afterCommit(team, .loading)
	phases["teamWhenConnected"] = afterCommit(team, .connected)
	phases["otherTeam"] = afterCommit(other, .loading)
	phases["otherTeamWhenSigningIn"] = afterCommit(other, .signingIn)
	phases["teamUnpinnedLoading"] = afterCommit(other, .loading, site: unpinned)
	phases["teamUnpinnedSigningIn"] = afterCommit(other, .signingIn, site: unpinned)
	phases["teamUnpinnedConnected"] = afterCommit(other, .connected, site: unpinned)
	phases["idp"] = afterCommit("https://login.idp.example/", .signingIn)
	// An identity provider's page that nothing led to is not kept; one the chain's redirect led to is the sign-in.
	phases["idpLoading"] = afterCommit("https://login.idp.example/", .loading)
	phases["idpConnected"] = afterCommit("https://login.idp.example/", .connected)
	phases["idpLoadingViaHop"] = afterCommit("https://login.idp.example/", .loading, viaHop: true)
	phases["idpConnectedViaHop"] = afterCommit("https://login.idp.example/", .connected, viaHop: true)
	phases["blank"] = afterCommit("about:blank", .connected)
	phases["blankLoading"] = afterCommit("about:blank", .loading)
	phases["http"] = afterCommit("http://omp.example.com/", .connected)
	phases["httpForeign"] = afterCommit("http://evil.example/", .signingIn)
	phases["nil"] = afterCommit(nil, .signingIn)
	report["phases"] = phases
	report["teamToPin"] = [
		(team, RemotePhase.loading, unpinned), (team, .signingIn, unpinned), (team, .connected, unpinned), (team, .loading, site),
		("https://omp.example.com/", .loading, unpinned), ("https://login.idp.example/", .loading, unpinned),
		("http://myteam.cloudflareaccess.com/", .loading, unpinned), ("https://a.b.cloudflareaccess.com/", .loading, unpinned),
	].map { teamToPin(afterCommit: URL(string: $0.0), site: $0.2, previous: $0.1) ?? "nil" }

	// What counts as the person clicking: a real event a moment ago, and one link a second to another app.
	var gesture = RemoteGesture()
	var gestures: [String: Bool] = [:]
	gestures["noEvent"] = gesture.isFresh(at: 100)
	gesture.noteEvent(at: 100)
	gestures["same"] = gesture.isFresh(at: 100)
	gestures["after0.9"] = gesture.isFresh(at: 100.9)
	gestures["after1.0"] = gesture.isFresh(at: 101)
	gestures["after5"] = gesture.isFresh(at: 105)
	gestures["before"] = gesture.isFresh(at: 99)
	// One event, one use: the first link opens, the same event opens no other and does not go full screen either.
	gestures["firstOpen"] = gesture.consumeForExternalOpen(at: 100.2)
	gestures["freshAfterUse"] = gesture.isFresh(at: 100.3)
	gestures["secondOpenSameEvent"] = gesture.consumeForExternalOpen(at: 100.4)
	gestures["fullScreenSameEvent"] = gesture.consume(at: 100.4)
	// A new event a moment later still waits for the second a link needs.
	gesture.noteEvent(at: 100.5)
	gestures["openTooSoon"] = gesture.consumeForExternalOpen(at: 100.6)
	gesture.noteEvent(at: 101.3)
	gestures["openAfterASecond"] = gesture.consumeForExternalOpen(at: 101.4)
	// Full screen uses its event up too, once.
	gesture.noteEvent(at: 200)
	gestures["fullScreenFirst"] = gesture.consume(at: 200.1)
	gestures["fullScreenSecond"] = gesture.consume(at: 200.2)
	gestures["openAfterFullScreen"] = gesture.consumeForExternalOpen(at: 200.3)
	// A stale event is no click, and neither is one that has not happened yet.
	gesture.noteEvent(at: 300)
	gestures["staleConsume"] = gesture.consume(at: 302)
	// The clock going back (a stale stamp) does not lock the link for good, and an older event does not lower a newer one.
	var back = RemoteGesture()
	back.noteEvent(at: 100)
	_ = back.consumeForExternalOpen(at: 100.2)
	back.noteEvent(at: 40)
	gestures["clockWentBack"] = back.consumeForExternalOpen(at: 40.1)
	back.noteEvent(at: 500)
	back.noteEvent(at: 50)
	gestures["olderEventDoesNotLowerIt"] = back.isFresh(at: 500.5)
	report["gestures"] = gestures
	// Which events are a gesture: a mouse button; Return, keypad Enter and Space pressed once. Letters, other keys and a held key are not.
	report["gestureEvents"] = [
		RemoteGesture.counts(isMouse: true, keyCode: 0, isRepeat: false), RemoteGesture.counts(isMouse: true, keyCode: 0, isRepeat: true),
		RemoteGesture.counts(isMouse: false, keyCode: 36, isRepeat: false), RemoteGesture.counts(isMouse: false, keyCode: 76, isRepeat: false),
		RemoteGesture.counts(isMouse: false, keyCode: 49, isRepeat: false), RemoteGesture.counts(isMouse: false, keyCode: 36, isRepeat: true),
		RemoteGesture.counts(isMouse: false, keyCode: 49, isRepeat: true), RemoteGesture.counts(isMouse: false, keyCode: 0, isRepeat: false),
		RemoteGesture.counts(isMouse: false, keyCode: 53, isRepeat: false), RemoteGesture.counts(isMouse: false, keyCode: 48, isRepeat: false),
	]

	// How the window reads navigations, replayed in the orders WebKit gives them (the `order` mode records those from a real web view).
	let pinned = site, unpinnedSite = unpinned
	let signIn = ["decide:own", "start", "decide:team", "redirect"]
	report["navigator"] = [
		// Own address, the team's sign-in, the identity provider's redirect: the sign-in chain with no page of the team shown.
		"redirectChain": replay(signIn + ["decide:idp", "redirect", "commit:idp"], site: pinned),
		"redirectChainTwoProviders": replay(
			signIn + ["decide:idp", "redirect", "decide:idp2", "redirect", "commit:idp2"], site: pinned),
		// The team's sign-in page is shown: from there the person (or the page's own redirect) goes to the provider.
		"teamPageThenProvider": replay(
			signIn + ["commit:team", "decide:idp", "start", "redirect", "commit:idp"], site: pinned),
		"providerCallbackBack": replay(
			signIn + ["commit:team", "decide:idp", "redirect", "commit:idp", "decide:team", "redirect", "decide:ownAuth", "redirect", "decide:own", "redirect", "commit:own"],
			site: pinned),
		// A page that starts a navigation to the team's sign-in and another behind it: the second is stopped when it starts, or cancelled.
		"scriptNavigationAfterFail": replay(
			["decide:own", "start", "commit:own", "decide:team", "start", "fail", "decide:evil", "start"], site: pinned),
		"scriptNavigationRacing": replay(
			["decide:own", "start", "commit:own", "decide:team", "start", "decide:evil", "start"], site: pinned),
		"redirectThenStart": replay(signIn + ["decide:idp", "start"], site: pinned),
		// The Mac's own address ends the chain: after Access hands the login back, a redirect of the Mac's own is not the sign-in's.
		"ownLegThenEvil": replay(signIn + ["decide:ownAuth", "redirect", "decide:evil"], site: pinned),
		"ownLegThenEvilCommitted": replay(signIn + ["decide:ownAuth", "redirect", "commit:evil"], site: pinned),
		"ownLegThenIdp": replay(signIn + ["decide:ownAuth", "redirect", "decide:idp", "redirect", "commit:idp"], site: pinned),
		"ownLegConnected": replay(signIn + ["decide:ownAuth", "redirect", "decide:own", "redirect", "commit:own"], site: pinned),
		// A page of another site that nothing led to is not kept, and the window starts over.
		"strayCommit": replay(["decide:own", "commit:own", "commit:evil", "decide:own"], site: pinned),
		// The team is kept from a sign-in that was shown, for a Mac with none; not from one that was only decided.
		"pinFromCommit": replay(signIn + ["commit:team"], site: unpinnedSite),
		"pinKnown": replay(signIn + ["commit:team"], site: pinned),
		"noPinFromDecision": replay(signIn + ["decide:ownAuth", "redirect", "commit:own"], site: unpinnedSite),
		// A session that ended while connected: the sign-in again, in the same window.
		"signInAgain": replay(
			["decide:own", "start", "commit:own", "decide:own", "start", "decide:team", "redirect", "commit:team", "decide:idp", "start", "redirect", "commit:idp"],
			site: pinned),
		// A failure ends the chain: what the page tries next is no step of a sign-in.
		"failureEndsChain": replay(signIn + ["fail", "decide:evil"], site: pinned),
	] as [String: [String]]
	report["displayHost"] = [
		displayHost("omp.example.com"), displayHost(String(repeating: "a", count: 40)), displayHost(String(repeating: "a", count: 41)),
		displayHost("accounts.google.com." + String(repeating: "x", count: 60) + ".evil.example"), displayHost("a.example.com", limit: 5),
	]

	let popOut = [
		"https://omp.example.com/?popout#/s/a/agent/b", "https://omp.example.com/?popout", "https://omp.example.com:443/?popout",
		"https://OMP.example.com/?popout", "http://omp.example.com/?popout", "https://other.example.com/?popout",
		"https://omp.example.com:8443/?popout", "https://omp.example.com/x?popout", "https://omp.example.com/", "https://omp.example.com/?other",
	]
	report["popOut"] = popOut.map { isRemotePopOutRequest(URL(string: $0), host: "omp.example.com") }
	report["popOutNil"] = isRemotePopOutRequest(nil, host: "omp.example.com")

	func page(_ main: Bool, _ scheme: String, _ host: String, _ port: Int, _ phase: RemotePhase) -> Bool {
		isRemotePage(isMainFrame: main, scheme: scheme, host: host, port: port, site: site, phase: phase)
	}
	report["bridge"] = [
		page(true, "https", "omp.example.com", 0, .connected), page(true, "https", "omp.example.com", 443, .connected),
		page(true, "HTTPS", "OMP.example.com", 0, .connected), page(false, "https", "omp.example.com", 0, .connected),
		page(true, "https", "omp.example.com", 0, .signingIn), page(true, "https", "omp.example.com", 0, .loading),
		page(true, "http", "omp.example.com", 0, .connected), page(true, "https", "myteam.cloudflareaccess.com", 0, .connected),
		page(true, "https", "omp.example.com", 8443, .connected), page(true, "https", "evil.com", 0, .connected),
	]

	// Labels.
	let long = String(repeating: "word ", count: 60)
	report["titles"] = [
		remoteWindowTitle(name: "Mac A", pageTitle: "Fix login bug", language: .en),
		remoteWindowTitle(name: "Mac A", pageTitle: "Fix login bug", language: .zh),
		remoteWindowTitle(name: "Mac A", pageTitle: nil, language: .en),
		remoteWindowTitle(name: "Mac A", pageTitle: "   \n ", language: .en),
		remoteWindowTitle(name: "Mac A", pageTitle: "a\u{202E}b\u{0000}c\n\td", language: .en),
		remoteWindowTitle(name: "Mac A", pageTitle: "  many   spaces  ", language: .en),
		remoteWindowTitle(name: "Mac A", pageTitle: long, language: .en),
		remoteWindowTitle(name: "Mac A", pageTitle: "Mac A (remote)", language: .en),
	]
	let statuses: [(String, RemoteStatus)] = [
		("connecting", .connecting), ("signingIn", .signingIn(host: "myteam.cloudflareaccess.com")), ("connected", .connected),
		("refused", .failed(.refused(status: 403))), ("offline", .failed(.offline)),
		("mismatch", .failed(.teamMismatch(host: "x.cloudflareaccess.com", pinned: "myteam"))),
		("unexpected", .failed(.unexpected(host: "evil.example"))),
	]
	var strips: [String: [String]] = [:]
	for (name, status) in statuses {
		strips[name] = [ShellLanguage.en, .zh].map { remoteStripText(name: "Mac A", host: "omp.example.com", status: status, language: $0) }
	}
	report["strips"] = strips
	func problemName(_ problem: RemoteProblem?) -> String {
		guard let problem else { return "nil" }
		switch problem {
		case .offline: return "offline"
		case .hostNotFound: return "hostNotFound"
		case .timedOut: return "timedOut"
		case .secure: return "secure"
		case .refused(let status): return "refused:\(status)"
		case .http(let status): return "http:\(status)"
		case .teamMismatch(let host, let pinned): return "teamMismatch:\(host):\(pinned ?? "nil")"
		case .unexpected(let host): return "unexpected:\(host)"
		case .other(let text): return "other:\(text)"
		}
	}
	report["problems"] = [
		problemName(remoteProblem(urlErrorCode: NSURLErrorNotConnectedToInternet, description: "d")),
		problemName(remoteProblem(urlErrorCode: NSURLErrorCannotFindHost, description: "d")),
		problemName(remoteProblem(urlErrorCode: NSURLErrorTimedOut, description: "d")),
		problemName(remoteProblem(urlErrorCode: NSURLErrorServerCertificateUntrusted, description: "d")),
		problemName(remoteProblem(urlErrorCode: NSURLErrorBadURL, description: "the reason")),
		problemName(remoteProblem(httpStatus: 200)),
		problemName(remoteProblem(httpStatus: 302)),
		problemName(remoteProblem(httpStatus: 399)),
		problemName(remoteProblem(httpStatus: 401)),
		problemName(remoteProblem(httpStatus: 403)),
		problemName(remoteProblem(httpStatus: 404)),
		problemName(remoteProblem(httpStatus: 502)),
	]

	// Hues.
	let fixed = UUID(uuidString: "3F2504E0-4F89-11D3-9A0C-0305E82C3301")!
	var seen = Set<Int>()
	var counts = [Int](repeating: 0, count: remoteHues.count)
	for _ in 0..<2000 {
		let index = remoteHueIndex(for: UUID())
		seen.insert(index)
		counts[index] += 1
	}
	report["hues"] = [
		"degrees": remoteHues, "fixedTwice": [remoteHueIndex(for: fixed), remoteHueIndex(for: fixed)],
		"fixed": remoteHueIndex(for: fixed), "seen": seen.sorted(), "min": counts.min()!, "max": counts.max()!,
	]

	// The page for a Mac that did not answer.
	report["errorPage"] = remoteErrorPage(
		name: "<b>\"Mac\"</b> & co", host: "omp.example.com", problem: .other("<script>alert(1)</script>"), language: .en)
	report["errorPageZh"] = remoteErrorPage(name: "Mac A", host: "omp.example.com", problem: .refused(status: 403), language: .zh)

	// Words: every sentence in both languages.
	let w = [RemoteWords(.en), RemoteWords(.zh)]
	func both(_ make: (RemoteWords) -> String) -> [String] { w.map(make) }
	var words: [String: [String]] = [:]
	words["menuTitle"] = both { $0.menuTitle }
	words["noMacs"] = both { $0.noMacs }
	words["addMac"] = both { $0.addMac }
	words["manageMacs"] = both { $0.manageMacs }
	words["addTitle"] = both { $0.addTitle }
	words["addDetail"] = both { $0.addDetail }
	words["nameLabel"] = both { $0.nameLabel }
	words["addressLabel"] = both { $0.addressLabel }
	words["namePlaceholder"] = both { $0.namePlaceholder }
	words["check"] = both { $0.check }
	words["add"] = both { $0.add }
	words["addAnyway"] = both { $0.addAnyway }
	words["cancel"] = both { $0.cancel }
	words["ok"] = both { $0.ok }
	words["checking"] = both { $0.checking("omp.example.com") }
	let allProblems: [RemoteMacProblem] = [
		.name(.empty), .name(.tooLong), .name(.characters), .name(.taken("Mac A")), .address(.empty), .address(.notHTTPS("http")),
		.address(.userInfo), .address(.port), .address(.path), .address(.ipAddress), .address(.trailingDot), .address(.notASCII),
		.address(.localName), .address(.accessDomain), .address(.notDomainName), .hostTaken("Mac A"), .full,
	]
	for problem in allProblems { words["problem:\(describe(problem))"] = both { $0.problem(problem) } }
	let allProbes: [ProbeResult] = [
		.access(team: "myteam"), .redirected(host: "evil.example"), .redirected(host: ""), .forbidden, .open(status: 200),
		.httpError(status: 502), .unreachable(.offline), .unreachable(.hostNotFound), .unreachable(.timedOut), .unreachable(.secure),
		.unreachable(.other),
	]
	for probe in allProbes { words["probe:\(describe(probe))"] = both { $0.probe(probe, host: "omp.example.com") } }
	words["addAnywayNote"] = both { $0.addAnywayNote }
	words["manageTitle"] = both { $0.manageTitle }
	words["manageDetail"] = both { $0.manageDetail }
	words["done"] = both { $0.done }
	words["signOut"] = both { $0.signOut }
	words["forget"] = both { $0.forget }
	words["addressLine"] = both { $0.addressLine("omp.example.com") }
	words["teamLine"] = both { $0.teamLine("myteam") }
	words["teamLineNone"] = both { $0.teamLine(nil) }
	words["lastConnected"] = both { $0.lastConnectedLine(now) }
	words["lastConnectedNever"] = both { $0.lastConnectedLine(nil) }
	words["signedOut"] = both { $0.signedOut("Mac A") }
	words["signedOutShared"] = both { $0.signedOutShared("Mac A", others: ["Mac B"]) }
	words["signedOutSharedMany"] = both { $0.signedOutShared("Mac A", others: ["Mac B", "Mac C"]) }
	words["forgetTitle"] = both { $0.forgetTitle("Mac A") }
	words["forgetDetail"] = both { $0.forgetDetail }
	words["forgetButton"] = both { $0.forgetButton }
	words["cannotForget"] = both { $0.cannotForget("Mac A") }
	words["cannotSave"] = both { $0.cannotSave }
	words["cannotOpen"] = both { $0.cannotOpen }
	words["cannotProtect"] = both { $0.cannotProtect }
	words["forgotButSignInKept"] = both { $0.forgotButSignInKept("Mac A") }
	words["serverDown"] = both { $0.serverDown }
	words["working"] = both { $0.working }
	words["remoteTag"] = both { $0.remoteTag }
	words["windowLabel"] = both { $0.windowLabel("Mac A") }
	words["disconnect"] = both { $0.disconnect }
	for (name, status) in statuses { words["status:\(name)"] = both { $0.status(status) } }
	words["accessibility"] = both { $0.accessibility(name: "Mac A", host: "omp.example.com", status: .connected) }
	words["tryAgain"] = both { $0.tryAgain }
	let allFailures: [RemoteProblem] = [
		.offline, .hostNotFound, .timedOut, .secure, .refused(status: 403), .http(status: 502),
		.teamMismatch(host: "x.cloudflareaccess.com", pinned: "myteam"), .teamMismatch(host: "x.cloudflareaccess.com", pinned: nil),
		.unexpected(host: "login.idp.example"), .unexpected(host: String(repeating: "x", count: 100) + ".example"),
	]
	for (index, problem) in allFailures.enumerated() {
		words["problemTitle:\(index)"] = both { $0.problemTitle(problem, host: "omp.example.com") }
		words["problemDetail:\(index)"] = both { $0.problemDetail(problem, name: "Mac A", host: "omp.example.com") }
	}
	words["pageSays"] = both { $0.pageSays("Mac A") }
	words["saveMessage"] = both { $0.saveMessage(file: "x.zip", mac: "Mac A") }
	words["openMessage"] = both { $0.openMessage(mac: "Mac A") }
	report["words"] = words
	report["wordsMention"] = [
		"name": both { $0.problem(.name(.taken("Mac A"))) }.map { $0.contains("Mac A") },
		"host": both { $0.probe(.forbidden, host: "omp.example.com") }.map { $0.contains("omp.example.com") },
		"team": both { $0.probe(.access(team: "myteam"), host: "omp.example.com") }.map { $0.contains("myteam") },
		"status": both { $0.problem(.hostTaken("Mac A")) }.map { $0.contains("Mac A") },
		"shared": both { $0.signedOutShared("Mac A", others: ["Mac B", "Mac C"]) }.map { $0.contains("Mac A") && $0.contains("Mac B") && $0.contains("Mac C") },
		"kept": both { $0.forgotButSignInKept("Mac A") }.map { $0.contains("Mac A") },
	]
	report["language"] = [
		ShellLanguage(stored: "zh-CN", preferred: ["en-US"]) == .zh, ShellLanguage(stored: "en", preferred: ["zh-Hans"]) == .en,
		ShellLanguage(stored: nil, preferred: ["zh-Hans-CN"]) == .zh, ShellLanguage(stored: nil, preferred: ["fr"]) == .en,
	]

	// An answer that says it is to be saved is one, whatever its type; a plain one, or one that only mentions the word, is not.
	let saveUrl = URL(string: "https://omp.example.com/api/folder/download")!
	func saveAnswer(_ disposition: String?) -> URLResponse {
		HTTPURLResponse(
			url: saveUrl, statusCode: 200, httpVersion: "HTTP/1.1",
			headerFields: disposition.map { ["Content-Disposition": $0] } ?? [:])!
	}
	report["attachment"] = [
		remoteIsAttachment(saveAnswer("attachment")),
		remoteIsAttachment(saveAnswer("attachment; filename=\"a.txt\"")),
		remoteIsAttachment(saveAnswer(" Attachment ;filename*=UTF-8''a.txt")),
		remoteIsAttachment(saveAnswer("inline")),
		remoteIsAttachment(saveAnswer("inline; filename=\"attachment\"")),
		remoteIsAttachment(saveAnswer("attachments")),
		remoteIsAttachment(saveAnswer(nil)),
		remoteIsAttachment(URLResponse(url: saveUrl, mimeType: "text/plain", expectedContentLength: 1, textEncodingName: nil)),
		remoteIsAttachment(nil),
	]

	// The blocker.
	let rules = (try! JSONSerialization.jsonObject(with: Data(remoteContentRules().utf8))) as! [[String: Any]]
	report["ruleCount"] = rules.count
	report["ruleActions"] = Set(rules.map { (($0["action"] as? [String: Any])?["type"] as? String) ?? "?" }).sorted()
	let filters = rules.map { (($0["trigger"] as? [String: Any])?["url-filter"] as? String) ?? "" }
	let expressions = filters.map { try! NSRegularExpression(pattern: $0, options: [.caseInsensitive]) }
	func blocked(_ url: String) -> Bool {
		let range = NSRange(url.startIndex..., in: url)
		return expressions.contains { $0.firstMatch(in: url, options: [], range: range) != nil }
	}
	let mustBlock = [
		"http://127.0.0.1:7878/api/meta", "https://127.0.0.1/", "http://127.255.255.254:1/", "ws://127.0.0.1:7878/ws", "wss://localhost/x",
		"https://localhost/x", "http://localhost:7878", "http://localhost", "https://LOCALHOST/", "http://10.0.0.5/", "http://10.255.255.255",
		"https://192.168.1.2:8080/x", "http://192.168.0.1", "http://172.16.0.1/", "http://172.20.1.1/", "http://172.31.255.255/",
		"http://100.64.0.1/", "http://100.100.100.100/", "http://100.127.255.255/", "http://169.254.169.254/latest", "http://0.0.0.0:80/",
		"https://foo.local/", "https://foo.local:8080/x", "https://printer.localhost:3000/", "http://[::1]:7878/", "http://[fe80::1]/",
		"https://evil@x.example/", "https://user:pw@127.0.0.1/", "https://a.b.local", "ws://10.1.2.3:9/",
		// The same, over https and wss (the scheme rules do not decide these), and with the dot that ends a name.
		"https://10.0.0.5/", "https://172.16.0.1/", "https://172.31.255.255:8443/", "https://100.64.0.1/", "https://100.127.255.255/",
		"https://169.254.169.254/latest", "https://0.0.0.0/", "wss://192.168.1.2/s", "https://localhost./", "https://localhost.:7878/",
		"https://foo.localhost./", "https://x.local./", "https://x.local.:8080/", "wss://localhost./s",
		// Names of a private network: single labels (finished by a search domain), `.lan`, `.internal`, `.home.arpa`, `.localdomain`.
		"https://router/", "https://router./", "https://router:8080/", "https://nas.lan/", "https://nas.lan./", "https://x.internal/",
		"https://printer.home.arpa/", "https://host.localdomain:81/", "wss://nas/ws",
		// Ranges beyond the private ones: IETF protocol assignments, benchmarking, multicast, reserved, broadcast.
		"https://192.0.0.8/", "https://198.18.0.1/", "https://198.19.255.255/", "https://224.0.0.1/", "https://239.255.255.250/",
		"https://240.0.0.1/", "https://255.255.255.255/",
		// Every http and ws request: the window is https only.
		"http://example.com/", "http://omp.example.com/api", "ws://example.com/socket", "HTTP://EXAMPLE.COM/",
	]
	let mustAllow = [
		"https://omp.example.com/", "https://omp.example.com:443/x", "https://omp.example.com/api/folder?path=/etc/hosts",
		"https://172.15.0.1/", "https://172.32.0.1/", "https://100.63.0.1/", "https://100.128.0.1/", "https://11.0.0.1/", "https://192.169.0.1/",
		"https://169.253.0.1/", "https://example.com/127.0.0.1/path", "https://example.com/?next=http://localhost/",
		"https://example.com/?u=a@b", "https://localhost.example.com/", "https://notlocal.example.com/", "https://foo.local.example.com/",
		"https://127.example.com/", "https://192.168.1.2.example.com/", "https://example.com/@x", "https://team.cloudflareaccess.com/login",
		"https://8.8.8.8/", "https://1.1.1.1:443/", "https://192.0.1.1/", "https://198.17.255.255/", "https://198.20.0.1/",
		"https://223.255.255.255/", "https://example.com./", "https://xn--mp-hna.example.com/", "https://a.example.com/http://x/",
		"wss://omp.example.com/ws", "https://internal.example.com/", "https://lan.example.com/", "https://home.arpa.example.com/",
	]
	report["blocked"] = mustBlock.filter { !blocked($0) }
	report["notBlocked"] = mustAllow.filter { blocked($0) }

	// What may be handed to another app: the address rules without the scheme rules (a link to `http://example.com/` is the
	// browser's), and numeric hosts that are not dotted decimal.
	let externalMustBlock = [
		"http://127.0.0.1:7878/api/meta", "https://127.0.0.1/", "http://localhost./", "https://LOCALHOST:1/", "http://192.168.1.2/",
		"https://10.1.1.1/", "https://router/", "https://nas.local./", "https://x.internal/", "https://224.0.0.251/", "https://198.18.1.1/",
		"https://user@example.com/", "http://[::1]:7878/", "https://2130706433/", "https://0x7f.1/", "https://127.1/", "https://017700000001/",
	]
	let externalMustAllow = [
		"http://example.com/", "https://example.com/", "http://omp.example.com/", "https://omp.example.com/a?b=c", "https://8.8.8.8/",
		"https://xn--mp-hna.example.com/", "https://example.com./", "https://198.20.0.1/", "https://sub.example.co.uk/x",
	]
	report["externalNotBlocked"] = externalMustBlock.filter { !isRemoteBlocked(URL(string: $0)!) }
	report["externalBlocked"] = externalMustAllow.filter { isRemoteBlocked(URL(string: $0)!) }
	return report
}

// MARK: rules

/// Whether WebKit compiles the blocker (a list it refuses would keep a window from ever opening).
func compileRules(_ done: @escaping (Bool, String) -> Void) {
	WKContentRuleListStore.default().compileContentRuleList(
		forIdentifier: "ompw-remote-harness", encodedContentRuleList: remoteContentRules()
	) { list, error in
		done(list != nil, error.map { String(describing: $0) } ?? "none")
	}
}

func runLoop(until condition: () -> Bool, seconds: TimeInterval) {
	let deadline = Date().addingTimeInterval(seconds)
	while !condition() && Date() < deadline { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
}

/// What a hostile page tries, one vector for each port (a listener of the test's counts the connections that reach it: nothing on
/// the way answers, so a request the blocker lets through can only connect). `vectorNames` is the order of the ports.
let vectorNames = [
	"fetchLoopback", "fetchLocalhost", "fetchLocalhostDot", "fetchDecimal", "fetchHex", "fetchShort", "fetchSubLocalhost", "xhr", "wss",
	"worker", "eventSource", "beacon", "img", "iframe", "httpFetch", "wsPlain",
]

let vectorsScript = #"""
const out = {};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const at = (i) => ports[i];
const attempts = {
	fetchLoopback: () => fetch("https://127.0.0.1:" + at(0) + "/", { mode: "no-cors" }),
	fetchLocalhost: () => fetch("https://localhost:" + at(1) + "/", { mode: "no-cors" }),
	fetchLocalhostDot: () => fetch("https://localhost.:" + at(2) + "/", { mode: "no-cors" }),
	fetchDecimal: () => fetch("https://2130706433:" + at(3) + "/", { mode: "no-cors" }),
	fetchHex: () => fetch("https://0x7f.1:" + at(4) + "/", { mode: "no-cors" }),
	fetchShort: () => fetch("https://127.1:" + at(5) + "/", { mode: "no-cors" }),
	fetchSubLocalhost: () => fetch("https://foo.localhost:" + at(6) + "/", { mode: "no-cors" }),
	xhr: () => new Promise((resolve) => {
		const x = new XMLHttpRequest();
		x.open("GET", "https://127.0.0.1:" + at(7) + "/");
		x.onloadend = () => resolve();
		x.send();
	}),
	wss: () => new Promise((resolve) => {
		const s = new WebSocket("wss://127.0.0.1:" + at(8) + "/");
		s.onerror = s.onclose = () => resolve();
	}),
	worker: () => new Promise((resolve) => {
		const source = "fetch('https://127.0.0.1:" + at(9) + "/', { mode: 'no-cors' }).catch(() => {}).then(() => postMessage('done'));";
		const w = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
		w.onmessage = w.onerror = () => resolve();
	}),
	eventSource: () => new Promise((resolve) => {
		const e = new EventSource("https://127.0.0.1:" + at(10) + "/");
		e.onerror = () => { e.close(); resolve(); };
	}),
	beacon: () => { navigator.sendBeacon("https://127.0.0.1:" + at(11) + "/", "x"); },
	img: () => new Promise((resolve) => {
		const i = new Image();
		i.onload = i.onerror = () => resolve();
		i.src = "https://127.0.0.1:" + at(12) + "/i.png";
	}),
	iframe: () => new Promise((resolve) => {
		const f = document.createElement("iframe");
		f.onload = f.onerror = () => resolve();
		f.src = "https://127.0.0.1:" + at(13) + "/";
		(document.body || document.documentElement).appendChild(f);
	}),
	httpFetch: () => fetch("http://127.0.0.1:" + at(14) + "/", { mode: "no-cors" }),
	wsPlain: () => new Promise((resolve) => {
		const s = new WebSocket("ws://127.0.0.1:" + at(15) + "/");
		s.onerror = s.onclose = () => resolve();
	}),
};
for (const [name, attempt] of Object.entries(attempts)) {
	try { await Promise.race([attempt(), wait(2500)]); out[name] = "settled"; } catch (e) { out[name] = "threw"; }
}
out.serviceWorker = typeof navigator.serviceWorker;
return JSON.stringify(out);
"""#

/// Run every vector in `web`'s page (it needs a page: any, about:blank included), then give late connections a moment.
func runVectors(on web: WKWebView, ports: [String]) -> Any {
	var reply: String?
	web.callAsyncJavaScript(vectorsScript, arguments: ["ports": ports], in: nil, in: .page) { result in
		switch result {
		case .success(let value): reply = (value as? String) ?? "not a string"
		case .failure(let error): reply = "error: \(error)"
		}
	}
	runLoop(until: { reply != nil }, seconds: 90)
	spin(1.5)
	return (try? JSONSerialization.jsonObject(with: Data((reply ?? "").utf8))) ?? reply ?? "nothing"
}

/// A windowless web view that runs every vector, with or without the blocker, in an http page (so that the page itself is no
/// obstacle: what does not connect is the blocker's doing) or in `about:blank` (what a remote window's own pages are).
func vectors(ports: [String], blocker: Bool, blank: Bool) -> [String: Any] {
	let configuration = WKWebViewConfiguration()
	configuration.websiteDataStore = .nonPersistent()
	if blocker {
		var compiled: WKContentRuleList?
		var finished = false
		WKContentRuleListStore.default().compileContentRuleList(
			forIdentifier: "ompw-remote-harness", encodedContentRuleList: remoteContentRules()
		) { list, _ in
			compiled = list
			finished = true
		}
		runLoop(until: { finished }, seconds: 20)
		guard let compiled else { return ["error": "the blocker did not compile"] }
		configuration.userContentController.add(compiled)
	}
	let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: configuration)
	web.loadHTMLString("<!doctype html><title>v</title><body></body>", baseURL: blank ? nil : URL(string: "http://example.com/"))
	runLoop(until: { web.url != nil && !web.isLoading }, seconds: 10)
	return ["results": runVectors(on: web, ports: ports)]
}

// MARK: order

/// Records what a web view calls its delegate with, in order: `decide:<path>` (a main-frame decision), `start`, `redirect`,
/// `commit:<path>`, `fail:<code>`. It allows everything.
///
/// `pageNavigatesTo`, when it is set, is the address the page itself then goes to: its script is run when the delegate reports
/// that the navigation whose path is `afterStarting` has started, so the page's navigation is its own (as a timer's would be),
/// and it follows the first one by construction rather than by time. A page's timer is the race: under load it can fire before
/// the request it interrupts has reached the server (which then records the opposite order), or after the wait below, and the
/// test took 26 s and failed under load while it passed alone.
final class OrderRecorder: NSObject, WKNavigationDelegate {
	var events: [String] = []
	/// The address the page navigates itself to, and the path of the navigation that its script waits for.
	var pageNavigatesTo: String?
	var afterStarting = ""
	/// The path of the last navigation a decision was reported for: the page's script waits for that one to start.
	private var decided = ""

	func webView(
		_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
	) {
		if action.targetFrame?.isMainFrame ?? true, let url = action.request.url, url.scheme == "http" {
			events.append("decide:\(url.path)")
			decided = url.path
		}
		decisionHandler(.allow)
	}

	func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
		events.append("start")
		if let pageNavigatesTo, decided == afterStarting {
			self.pageNavigatesTo = nil
			webView.evaluateJavaScript("location = '\(pageNavigatesTo)'", completionHandler: nil)
		}
	}
	func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
		events.append("redirect")
	}
	func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { events.append("commit:\(webView.url?.path ?? "-")") }
	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		events.append("fail:\((error as NSError).code)")
	}
}

/// Which of the replay's addresses each path of the test's server stands for.
let orderKeys: [String: String] = [
	"/chain": "own", "/script": "own", "/leg": "own", "/team": "team", "/team-slow": "team", "/team2": "team", "/idp": "idp",
	"/own": "ownAuth", "/evil": "evil",
]

/// Load each path of the test's server (http, on loopback) in a web view of its own, record the order of the delegate's calls,
/// and replay the recording through the navigator with the paths read as the addresses they stand for: the shell relies on
/// this order (a redirect is decided and reported with no load of its own; a navigation of the page is decided and starts).
///
/// The `script` case is the page's own navigations: to a sign-in that never answers, and then, once that one has started,
/// to another site (see `OrderRecorder.pageNavigatesTo`: the second follows WebKit's report of the first, not a timer). The
/// wait is a bound on the whole run, not the thing that makes the order: a run that reaches it never saw the last commit, and
/// says so (`timedOut`) rather than reporting a shorter list as the order. Each of the three is bounded so that all of them
/// together stay below the test's own timeout: a hang is then reported as `timedOut`, not as a killed test.
func order(port: String) -> [String: Any] {
	var report: [String: Any] = [:]
	let site = RemoteSite(host: "omp.example.com", team: "myteam")
	for (name, last) in [("chain", "/idp"), ("script", "/evil"), ("leg", "/evil")] {
		let recorder = OrderRecorder()
		if name == "script" {
			recorder.afterStarting = "/team-slow"
			recorder.pageNavigatesTo = "/evil"
		}
		let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 300, height: 200), configuration: WKWebViewConfiguration())
		web.navigationDelegate = recorder
		web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/\(name)")!))
		runLoop(until: { recorder.events.contains("commit:\(last)") }, seconds: 45)
		let events = recorder.events
		if !events.contains("commit:\(last)") {
			report[name] = ["events": events, "replayed": [] as [String], "timedOut": true] as [String: Any]
			continue
		}
		let keyed = events.map { event -> String in
			guard let range = event.range(of: ":"), ["decide", "commit"].contains(String(event[..<range.lowerBound])) else { return event }
			let kind = String(event[..<range.lowerBound]), path = String(event[range.upperBound...])
			return "\(kind):\(orderKeys[path] ?? "?\(path)")"
		}.map { $0.hasPrefix("fail") ? "fail" : $0 }
		report[name] = ["events": events, "replayed": replay(keyed, site: site)] as [String: Any]
	}
	return report
}

// MARK: client

/// The app's client of the server's routes against the test's stubs on loopback (the test records what reaches the live one): every
/// kind of change on a stub that answers, the answers a server gives when it says no, a port nothing listens on, and a stub that never
/// answers (with a short timeout, so that the test does not wait the five seconds).
func clientRun(live: Int, dead: Int, hang: Int) -> [String: Any] {
	let token = "launch-token-1"
	let known = UUID(uuidString: "3F2504E0-4F89-11D3-9A0C-0305E82C3301")!
	let missing = UUID(uuidString: "00000000-0000-4000-8000-000000000404")!
	func client(_ port: Int, timeout: TimeInterval = macsRequestTimeout) -> RemoteMacsClient {
		RemoteMacsClient(timeout: timeout, server: { (URL(string: "http://127.0.0.1:\(port)")!, token) })
	}
	var onMain = true
	/// Start a change, wait for its answer on the main queue, and say what it came to.
	func call<T>(_ ok: @escaping (T) -> String, _ start: (@escaping (Result<T, MacsServerError>) -> Void) -> Void) -> String {
		var answer: String?
		start { result in
			onMain = onMain && Thread.isMainThread
			answer = served(result, ok)
		}
		runLoop(until: { answer != nil }, seconds: 15)
		return answer ?? "no answer"
	}
	let describeMac: (RemoteMac) -> String = { "\($0.name)@\($0.host)#\($0.team ?? "nil")" }
	let done: (()) -> String = { _ in "removed" }
	let c = client(live)
	var results: [String: String] = [:]
	results["add"] = call(describeMac) { c.add(name: "Studio", address: "studio.example.com", team: "myteam", completion: $0) }
	results["addNoTeam"] = call(describeMac) { c.add(name: "Plain", address: "plain.example.com", team: nil, completion: $0) }
	results["addRefused"] = call(describeMac) { c.add(name: "Taken", address: "t.example.com", team: nil, completion: $0) }
	results["rename"] = call(describeMac) { c.rename(id: known, to: "Renamed", completion: $0) }
	results["renameRefused"] = call(describeMac) { c.rename(id: known, to: "Taken", completion: $0) }
	results["renameMissing"] = call(describeMac) { c.rename(id: missing, to: "Anything", completion: $0) }
	results["remove"] = call(done) { c.remove(id: known, completion: $0) }
	results["removeMissing"] = call(done) { c.remove(id: missing, completion: $0) }
	// The two that are not waited for: they go out, and nothing is said of how they came out.
	c.connected(id: known)
	c.pin(id: known, team: "myteam")
	c.connected(id: missing)
	spin(1.0)
	// A port nothing listens on, and a server that never answers: the server is not there, in the same words.
	let nobody = client(dead)
	results["deadAdd"] = call(describeMac) { nobody.add(name: "X", address: "x.example.com", team: nil, completion: $0) }
	results["deadRename"] = call(describeMac) { nobody.rename(id: known, to: "X", completion: $0) }
	results["deadRemove"] = call(done) { nobody.remove(id: known, completion: $0) }
	nobody.connected(id: known)
	nobody.pin(id: known, team: "myteam")
	let patient = client(hang, timeout: 0.5)
	let began = Date()
	results["hangAdd"] = call(describeMac) { patient.add(name: "X", address: "x.example.com", team: nil, completion: $0) }
	let waited = Date().timeIntervalSince(began)
	return ["results": results, "onMainQueue": onMain, "hangWaited": waited]
}

// MARK: window

/// What the app's `main.swift` has and `remotewindow.swift` uses: the page's theme script (empty here: the harness posts to the
/// bridge itself) and a CSS colour. The harness does not run the app.
final class AppDelegate {
	static let themeScript = ""
}

extension NSColor {
	convenience init?(cssHex css: String) {
		var hex = css.trimmingCharacters(in: .whitespaces)
		guard hex.hasPrefix("#") else { return nil }
		hex.removeFirst()
		if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
		guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
		self.init(
			srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
			blue: CGFloat(value & 0xff) / 255, alpha: 1)
	}
}

func spin(_ seconds: TimeInterval) { runLoop(until: { false }, seconds: seconds) }

func frame(_ rect: NSRect) -> [Double] { [rect.minX, rect.minY, rect.width, rect.height].map { Double($0) } }

func colour(_ color: NSColor) -> [Double] {
	let c = color.usingColorSpace(.sRGB) ?? color
	return [c.redComponent, c.greenComponent, c.blueComponent, c.alphaComponent].map { (Double($0) * 1000).rounded() / 1000 }
}

/// What the local server does with the saved list: the file, in the shape it writes (lower-case identifiers, whole seconds), written
/// whole into place (the app only ever reads it).
func writeSavedList(_ macs: [RemoteMac], in directory: URL) {
	let formatter = ISO8601DateFormatter()
	let records: [[String: Any]] = macs.map { mac in
		[
			"id": mac.id.uuidString.lowercased(), "name": mac.name, "host": mac.host, "team": mac.team ?? NSNull(),
			"storeId": mac.storeId.uuidString.lowercased(), "added": formatter.string(from: mac.added),
			"lastConnected": mac.lastConnected.map(formatter.string(from:)) ?? NSNull(),
		]
	}
	let data = try! JSONSerialization.data(withJSONObject: ["version": 1, "macs": records], options: [.sortedKeys, .prettyPrinted])
	try! data.write(to: directory.appendingPathComponent(RemoteMacStore.fileName), options: .atomic)
}

/// What forgetting a Mac takes out of a data store that stays, on a real (not persistent) store: the cookies of its own host go,
/// and those of its sibling, of the parent domain and of the team's Access sign-in stay.
func originData() -> [String: Any] {
	let when = Date(timeIntervalSince1970: 1_800_000_000)
	func mac(_ name: String, _ host: String) -> RemoteMac {
		RemoteMac(id: UUID(), name: name, host: host, team: "myteam", storeId: UUID(), added: when, lastConnected: nil)
	}
	let a = mac("A", "a.example.com"), b = mac("B", "b.example.com")
	let store = WKWebsiteDataStore.nonPersistent()
	func cookie(_ name: String, _ domain: String) -> HTTPCookie {
		HTTPCookie(properties: [.name: name, .value: "1", .domain: domain, .path: "/"])!
	}
	let planted = [
		cookie("a-host", "a.example.com"), cookie("a-dot", ".a.example.com"), cookie("b-host", "b.example.com"),
		cookie("parent", ".example.com"), cookie("access", "myteam.cloudflareaccess.com"),
	]
	var set = 0
	for planted in planted { store.httpCookieStore.setCookie(planted) { set += 1 } }
	runLoop(until: { set == planted.count }, seconds: 20)
	func names() -> [String] {
		var found: [String]?
		store.httpCookieStore.getAllCookies { found = $0.map(\.name).sorted() }
		runLoop(until: { found != nil }, seconds: 20)
		return found ?? []
	}
	let before = names()
	var finished = false
	removeOriginData(of: a, remaining: [a, b], from: store) { finished = true }
	runLoop(until: { finished }, seconds: 20)
	return ["before": before, "finished": finished, "after": names()]
}

/// Which data store a window's session is given: two Macs of one Cloudflare team the same one (the team's, by its identifier), a Mac
/// of another team or of none another. The stores are not-persistent ones made on the identifier the session asks for (a store of
/// the real identifier lives on disk), kept by identifier as WebKit does; the local window's own default store is not touched.
@available(macOS 14.0, *)
func teamStores(controller: RemoteMacsController) -> [String: Any] {
	let when = Date(timeIntervalSince1970: 1_800_000_000)
	func make(_ name: String, _ team: String?) -> RemoteMac {
		RemoteMac(id: UUID(), name: name, host: "\(name.lowercased()).invalid", team: team, storeId: UUID(), added: when, lastConnected: nil)
	}
	let macs = [make("T1", "myteam"), make("T2", "myteam"), make("T3", "otherteam"), make("T4", nil), make("T5", nil)]
	let main = WKWebViewConfiguration()
	main.websiteDataStore = .default()
	var made: [UUID: WKWebsiteDataStore] = [:]
	var asked: [UUID] = []
	var sessions: [RemoteMacSession] = []
	var stores: [WKWebsiteDataStore] = []
	for mac in macs {
		let session = RemoteMacSession(mac: mac, language: { .en }, owner: controller)
		session.rememberFrames = false
		session.makeDataStore = { id in
			asked.append(id)
			let store = made[id] ?? .nonPersistent()
			made[id] = store
			return store
		}
		var started: Bool?
		session.start(show: false) { started = $0 }
		runLoop(until: { started != nil }, seconds: 20)
		if started == true, let web = session.windows.first?.web { stores.append(web.configuration.websiteDataStore) }
		sessions.append(session)
	}
	let sessionsMain = sessions.compactMap { $0.windows.first?.web.configuration.websiteDataStore }
	var out: [String: Any] = [:]
	out["asked"] = asked.map(\.uuidString)
	out["expected"] = [
		teamStoreIdentifier("myteam"), teamStoreIdentifier("myteam"), teamStoreIdentifier("otherteam"), macs[3].storeId, macs[4].storeId,
	].map(\.uuidString)
	out["sessionStores"] = stores.count
	out["sameTeamSameStore"] = stores.count == 5 && stores[0] === stores[1]
	out["otherTeamAnotherStore"] = stores.count == 5 && stores[2] !== stores[0]
	out["noTeamOwnStores"] = stores.count == 5 && stores[3] !== stores[0] && stores[3] !== stores[2] && stores[3] !== stores[4]
	out["noneIsTheDefault"] = !sessionsMain.isEmpty && sessionsMain.allSatisfy { $0 !== WKWebsiteDataStore.default() }
	out["mainConfigurationUntouched"] = main.websiteDataStore === WKWebsiteDataStore.default()
	for session in sessions { session.disconnect() }
	spin(0.3)
	out["windowsAfterDisconnect"] = sessions.map { $0.windows.count }
	return out
}

/// The app's own menu, window and session objects, made as the app makes them and never put on the screen (a window that is not
/// ordered in is not shown), with a web view on a non-persistent store, to a host that never resolves (`.invalid`).
func windows(directory: URL, portsA: [String], portsB: [String]) -> [String: Any] {
	var out: [String: Any] = [:]
	var language = ShellLanguage.en
	let controller = RemoteMacsController(directory: directory, server: { nil }, language: { language }, refreshLanguage: {})
	let menu = controller.menuItem.submenu!
	func shown() -> [[String: Any]] {
		controller.menuNeedsUpdate(menu)
		return menu.items.map { item in
			item.isSeparatorItem
				? ["separator": true] as [String: Any]
				: [
					"title": item.title, "enabled": item.isEnabled && (item.action == nil || controller.validateMenuItem(item)),
					"on": item.state == .on, "tip": item.toolTip ?? "",
				]
		}
	}
	out["menuTitle"] = menu.title
	out["menuEmpty"] = shown()
	// The server writes the list; the app's menu reads the file as it is now.
	let macId = UUID(uuidString: "3F2504E0-4F89-11D3-9A0C-0305E82C3301")!
	writeSavedList(
		[RemoteMac(id: macId, name: "Mac A", host: "omp.invalid", team: nil, storeId: UUID(), added: Date(timeIntervalSince1970: 1_800_000_000), lastConnected: nil)],
		in: directory)
	let mac = controller.store.list.mac(id: macId)!
	// A Mac the list does not have is not opened (and no session is made for it).
	out["openUnknown"] = controller.open(UUID())
	out["noSessionForUnknown"] = controller.sessions.isEmpty
	out["menuOne"] = shown()

	let session = RemoteMacSession(mac: mac, language: { language }, owner: controller)
	session.rememberFrames = false
	var started: Bool?
	var titleAtStart = ""
	session.makeDataStore = { _ in .nonPersistent() }
	session.start(show: false) {
		started = $0
		titleAtStart = session.windows.first?.window.title ?? ""
	}
	runLoop(until: { started != nil }, seconds: 20)
	out["started"] = started ?? false
	out["titleAtStart"] = titleAtStart
	guard started == true, let window = session.windows.first else { return out }
	var everVisible = window.window.isVisible
	let content = window.window.contentView as? RemoteContentView
	func failed() -> Bool {
		if case .failed = window.status { return true }
		return false
	}

	// The Mac never answers: the window says so, in a page of its own, and its title still starts with the Mac's name.
	runLoop(until: { failed() && window.window.title.contains("reach") }, seconds: 40)
	out["failed"] = failed()
	out["titleAfterFailure"] = window.window.title
	out["strip"] = content?.strip.accessibilityLabel() ?? ""
	content?.layoutSubtreeIfNeeded()
	if let content {
		out["layout"] = ["content": frame(content.frame), "strip": frame(content.strip.frame), "web": frame(content.web.frame)]
	}
	out["contentIsRemote"] = content != nil && content?.web === window.web
	out["closable"] = window.window.styleMask.contains(.closable)
	out["delegateIsWindow"] = window.window.delegate === window
	out["fullScreenPrimary"] = window.window.collectionBehavior.contains(.fullScreenPrimary)

	// The page renames itself: the Mac's name stays in front.
	var done = false
	window.web.evaluateJavaScript("document.title = 'Totally the local Mac'") { _, _ in done = true }
	runLoop(until: { done && window.window.title.contains("Totally") }, seconds: 10)
	out["titleAfterRename"] = window.window.title
	done = false
	window.web.evaluateJavaScript("document.title = '\\u{202E}evil\\ntitle'") { _, _ in done = true }
	runLoop(until: { done && window.window.title.contains("evil") }, seconds: 10)
	out["titleAfterTricks"] = window.window.title

	// The words follow the language, and a renamed Mac is renamed in the title and the bar.
	language = .zh
	window.renamed()
	out["titleZh"] = window.window.title
	out["stripZh"] = content?.strip.accessibilityLabel() ?? ""
	language = .en
	session.renamed(to: "Mac Z")
	out["titleRenamed"] = window.window.title
	out["stripRenamed"] = content?.strip.accessibilityLabel() ?? ""

	// A page that is not the Mac's own signed-in page gets no answer from the bridges.
	let before = colour(window.window.backgroundColor)
	window.web.evaluateJavaScript("window.webkit.messageHandlers.ompwTheme.postMessage('#ff0000')", completionHandler: nil)
	spin(0.8)
	out["themeRefused"] = before == colour(window.window.backgroundColor)

	// The blocker is in the configuration the window really has: what this page tries never connects (the test counts connections).
	out["pageTried"] = runVectors(on: window.web, ports: portsA)

	// The bar names the host that has the page, whatever the width: a long host is cut in its middle and shown by its end, the state
	// keeps its room before who does, and who gives way (it goes when there is no room for it).
	var strips: [String: Any] = [:]
	let longHost = "accounts.google.com." + String(repeating: "x", count: 60) + ".evil.example"
	for width in [1280.0, 700.0, 640.0, 520.0, 420.0] {
		for (name, status) in [("short", RemoteStatus.signingIn(host: "login.example-idp.com")), ("long", .signingIn(host: longHost))] {
			let strip = RemoteStrip(hue: 205)
			strip.frame = NSRect(x: 0, y: 0, width: width, height: RemoteStrip.height)
			strip.set(
				parts: remoteStripParts(name: "Mac A", host: "omp.example.com", status: status, language: .en), disconnect: "Disconnect",
				accessibility: "")
			strip.layoutSubtreeIfNeeded()
			let shown = strip.shown, frames = strip.labelFrames
			strips["\(name)/\(Int(width))"] = [
				"tag": shown.tag, "who": shown.who, "whoHidden": shown.whoHidden, "status": shown.status, "statusFits": strip.statusFits,
				"tagFrame": frame(frames.tag), "whoFrame": frame(frames.who), "statusFrame": frame(frames.status),
				"buttonFrame": frame(frames.button),
			] as [String: Any]
		}
	}
	out["stripWidths"] = strips
	out["minWidth"] = RemoteWindow.minWidth
	out["windowMinSize"] = [window.window.minSize.width, window.window.minSize.height]

	// A pop-out is made from the configuration WebKit hands over (a copy of the window's): it keeps the blocker, the label and the
	// bridges. Only the first window is "the Mac's own"; when it is closed, choosing the Mac brings a new one.
	let popWeb = session.openPopOut(configuration: window.web.configuration, features: WKWindowFeatures(), near: window.window)
	out["popOutOpened"] = popWeb != nil
	let pop = session.windows.first { $0.isPopOut }
	out["popOutTitle"] = pop?.window.title ?? ""
	out["popOutMinWidth"] = pop?.window.minSize.width ?? 0
	if let popWeb {
		popWeb.loadHTMLString("<!doctype html><title>pop</title><body></body>", baseURL: nil)
		runLoop(until: { popWeb.url != nil && !popWeb.isLoading }, seconds: 10)
		spin(0.3)
		out["popOutTried"] = runVectors(on: popWeb, ports: portsB)
	}
	window.close()
	spin(0.2)
	out["afterMainClosed"] = session.windows.map { $0.isPopOut ? "popout" : "main" }
	session.bringForward()
	out["afterReopen"] = session.windows.map { $0.isPopOut ? "popout" : "main" }
	spin(0.3)
	out["reopenedNeverShown"] = session.windows.allSatisfy { !$0.window.isVisible }

	everVisible = everVisible || window.window.isVisible
	session.disconnect()
	spin(0.3)
	out["windowsAfterDisconnect"] = session.windows.count
	out["everVisible"] = everVisible
	// Which data store each Mac's window gets: the team's, shared by the Macs of the team.
	out["stores"] = teamStores(controller: controller)
	// What forgetting a Mac takes out of a store that stays.
	out["originData"] = originData()
	return out
}

/// The blocker lists WebKit compiled for this run are not kept: they live in the harness's own folder of WebKit's, and a fixed name
/// each would otherwise stay there.
func removeRules() {
	var pending = 0
	for id in ["ompw-remote-harness", "ompw-remote-1"] {
		pending += 1
		WKContentRuleListStore.default().removeContentRuleList(forIdentifier: id) { _ in pending -= 1 }
	}
	runLoop(until: { pending == 0 }, seconds: 5)
}

/// What reads the notices of another Mac (macos/remotenotify.swift, #656): which of a window's cookies sign the request in, how long a
/// failing stream waits, and the request the stream is made with. Plain values only; no network.
func notifyRun() -> [String: Any] {
	let now = Date(timeIntervalSince1970: 1_800_000_000)
	func cookie(_ name: String, domain: String, path: String = "/", expires: Date? = nil) -> HTTPCookie {
		var properties: [HTTPCookiePropertyKey: Any] = [.name: name, .value: "v-\(name)", .domain: domain, .path: path, .secure: "TRUE"]
		if let expires { properties[.expires] = expires }
		return HTTPCookie(properties: properties)!
	}
	/// The names a header carries, sorted, or "nil".
	func names(_ header: String?) -> Any {
		guard let header else { return "nil" }
		return header.split(separator: ";").map { String($0.split(separator: "=")[0]).trimmingCharacters(in: .whitespaces) }.sorted()
	}
	let host = "mac.example.com"
	let access = cookie("CF_Authorization", domain: host)
	let token = cookie("ompw_token", domain: host)
	let signIn: [String: Any] = [
		"both": names(remoteSignInHeader(host: host, cookies: [access, token], now: now)),
		// Another cookie of the store is never sent, and neither is one of another site.
		"others": names(remoteSignInHeader(host: host, cookies: [access, token, cookie("analytics", domain: host), cookie("ompw_token", domain: "evil.test")], now: now)),
		// Access's is required: without it the request would be sent to Access's sign-in page.
		"noAccess": names(remoteSignInHeader(host: host, cookies: [token], now: now)),
		"onlyAccess": names(remoteSignInHeader(host: host, cookies: [access], now: now)),
		"expired": names(remoteSignInHeader(host: host, cookies: [cookie("CF_Authorization", domain: host, expires: now.addingTimeInterval(-1)), token], now: now)),
		"live": names(remoteSignInHeader(host: host, cookies: [cookie("CF_Authorization", domain: host, expires: now.addingTimeInterval(60)), token], now: now)),
		"wholeDomain": names(remoteSignInHeader(host: host, cookies: [cookie("CF_Authorization", domain: ".example.com"), token], now: now)),
		"otherSite": names(remoteSignInHeader(host: host, cookies: [cookie("CF_Authorization", domain: "other.example.org"), token], now: now)),
		"otherPath": names(remoteSignInHeader(host: host, cookies: [cookie("CF_Authorization", domain: host, path: "/elsewhere"), token], now: now)),
		"noCookies": names(remoteSignInHeader(host: host, cookies: [], now: now)),
	]
	let delays = [1, 2, 3, 8, 9, 20].map { remoteNotifyRetryDelay($0) }
	let request = eventsRequest(
		origin: URL(string: "https://\(host)")!, path: remoteNotifyPath, headers: ["Cookie": "CF_Authorization=x; ompw_token=y"],
		language: .en, epoch: "e1", since: 7)
	return [
		"signIn": signIn,
		"delays": delays,
		"request": [
			"url": request.url!.absoluteString, "cookie": request.value(forHTTPHeaderField: "Cookie") ?? "nil",
			"token": request.value(forHTTPHeaderField: "x-omp-webui-token") ?? "nil",
			"handlesCookies": request.httpShouldHandleCookies, "timeout": request.timeoutInterval,
		] as [String: Any],
	]
}

if mode == "pure" {
	let directory = URL(fileURLWithPath: CommandLine.arguments[2])
	var report = pure(directory: directory)
	// WebKit compiles the blocker: it needs the web view framework and a window server session, not a window.
	if CommandLine.arguments.contains("webkit") {
		let app = NSApplication.shared
		app.setActivationPolicy(.prohibited)
		var answer: (Bool, String)?
		compileRules { answer = ($0, $1) }
		runLoop(until: { answer != nil }, seconds: 20)
		report["compiles"] = answer.map { ["ok": $0.0, "error": $0.1] as [String: Any] } ?? ["ok": false, "error": "no answer"]
		print(json(report))
		removeRules()
	} else {
		print(json(report))
	}
} else if mode == "client" {
	let ports = CommandLine.arguments[2...4].map { Int($0)! }
	print(json(clientRun(live: ports[0], dead: ports[1], hang: ports[2])))
} else if mode == "order" {
	let app = NSApplication.shared
	app.setActivationPolicy(.prohibited)
	print(json(order(port: CommandLine.arguments[2])))
} else if mode == "vectors" {
	let app = NSApplication.shared
	app.setActivationPolicy(.prohibited)
	let ports = CommandLine.arguments[3].split(separator: ",").map(String.init)
	print(json(vectors(ports: ports, blocker: CommandLine.arguments[2] == "1", blank: CommandLine.arguments.contains("blank"))))
	removeRules()
} else if mode == "window" {
	let app = NSApplication.shared
	app.setActivationPolicy(.prohibited)
	let a = CommandLine.arguments[3].split(separator: ",").map(String.init)
	let b = CommandLine.arguments[4].split(separator: ",").map(String.init)
	print(json(windows(directory: URL(fileURLWithPath: CommandLine.arguments[2]), portsA: a, portsB: b)))
	removeRules()
} else if mode == "notify" {
	print(json(notifyRun()))
}
