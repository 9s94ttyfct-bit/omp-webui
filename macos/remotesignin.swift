import Foundation
import WebKit

// The sign-ins of the other Macs, handed to this Mac's own server so that it can run commands there (`remote_run`, server/remote-run):
// the Cloudflare Access token (`CF_Authorization`) each Mac's window signed in with, read from that Mac's data store
// (`RemoteMac.storeIdentifier`, `accessToken`) and posted to the server's local-only `/api/macs/<id>/sign-in`; a `DELETE` there
// when the store holds none any more (signed out, run out). The server keeps it in memory only, and never shows it to a page.
// The token is in that request's body and nowhere else: it is never logged, and only a status is.
//
// It is handed over when the server is up (and again after it was started again: it kept nothing), when the list of Macs changes
// (the server's file, `remote-macs.json`, is watched), when a Mac's window has signed in, and when the cookies of a store in use
// change. What the server holds is known (`handed`), so the same token is not sent twice to one server.

/// What the server was last handed for a Mac.
enum HandedSignIn: Equatable {
	/// Nothing: the server holds no sign-in of the Mac (what a server that has just started holds of every Mac).
	case nothing
	/// This token. A token the server refused as lapsed (400) is kept as handed too: sending it again would change nothing.
	case token(String)
	/// A call that did not get an answer that says: the next sync hands over what there is, whatever it is.
	case unsure
}

@available(macOS 14.0, *)
final class RemoteSignIns: NSObject, WKHTTPCookieStoreObserver {
	/// How long after a change the stores are read: a sign-in sets its cookies one after the other.
	static let debounce: TimeInterval = 1

	private let list: RemoteMacStore
	private let client: RemoteMacsClient
	private let server: () -> (origin: URL, token: String)?
	/// The data stores of the listed Macs that exist, held while their cookies are watched. A store that is no Mac's any more is let
	/// go of at once (`listChanged`): one that is held cannot be deleted.
	private var stores: [UUID: WKWebsiteDataStore] = [:]
	/// What the server that is up now holds of each Mac (absent: `.nothing`).
	private var handed: [UUID: HandedSignIn] = [:]
	/// Which start of the server the calls are for: an answer from the one before is not what this one holds.
	private var generation = 0
	private var pending: DispatchWorkItem?
	private var watcher: DispatchSourceFileSystemObject?
	/// The list as it was when the stores were last read.
	private var known: [RemoteMac] = []

	init(list: RemoteMacStore, client: RemoteMacsClient, server: @escaping () -> (origin: URL, token: String)?) {
		self.list = list
		self.client = client
		self.server = server
	}

	deinit {
		watcher?.cancel()
		for store in stores.values { store.httpCookieStore.remove(self) }
	}

	/// The server is up (it was started, or started again): it holds no sign-in, and is handed every one there is.
	func serverStarted() {
		generation += 1
		handed = [:]
		watch()
		sync()
	}

	/// Something changed the list or a sign-in (a window signed in, a Mac was signed out of or forgotten): the stores are read again
	/// in a moment. A store of a Mac that is no longer listed is let go of now, so that it can be deleted.
	func listChanged() {
		let wanted = Set(list.list.macs.map(\.storeIdentifier))
		for (id, store) in stores where !wanted.contains(id) {
			store.httpCookieStore.remove(self)
			stores[id] = nil
		}
		schedule()
	}

	func cookiesDidChange(in cookieStore: WKHTTPCookieStore) { schedule() }

	private func schedule() {
		guard server() != nil else { return }
		pending?.cancel()
		let work = DispatchWorkItem { [weak self] in self?.sync() }
		pending = work
		DispatchQueue.main.asyncAfter(deadline: .now() + RemoteSignIns.debounce, execute: work)
	}

	/// The file of the list is written into place by the server (a new file renamed over the old one), which is a change of the
	/// folder: the list is read again then, and the stores when it is another list.
	private func watch() {
		guard watcher == nil else { return }
		let fd = open(list.file.deletingLastPathComponent().path, O_EVTONLY)
		guard fd >= 0 else { return }
		let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
		source.setEventHandler { [weak self] in
			guard let self, self.list.list.macs != self.known else { return }
			self.listChanged()
		}
		source.setCancelHandler { close(fd) }
		source.resume()
		watcher = source
	}

	/// Read the store of every listed Mac and hand the server what it does not hold yet. Only stores that exist are opened (opening
	/// one makes it): a Mac whose window was never opened has no sign-in.
	private func sync() {
		pending?.cancel()
		pending = nil
		guard server() != nil else { return }
		let macs = list.list.macs
		known = macs
		handed = handed.filter { id, _ in macs.contains { $0.id == id } }
		WKWebsiteDataStore.fetchAllDataStoreIdentifiers { [weak self] existing in
			DispatchQueue.main.async {
				guard let self else { return }
				// The list as it is now: a Mac forgotten meanwhile has a store that is about to be deleted.
				let macs = self.list.list.macs
				let present = Set(existing)
				let wanted = Set(macs.map(\.storeIdentifier)).intersection(present)
				for (id, store) in self.stores where !wanted.contains(id) {
					store.httpCookieStore.remove(self)
					self.stores[id] = nil
				}
				for id in wanted where self.stores[id] == nil {
					let store = WKWebsiteDataStore(forIdentifier: id)
					store.httpCookieStore.add(self)
					self.stores[id] = store
				}
				for mac in macs {
					guard let store = self.stores[mac.storeIdentifier] else {
						self.hand(nil, to: mac.id)
						continue
					}
					store.httpCookieStore.getAllCookies { [weak self] cookies in
						DispatchQueue.main.async { self?.hand(accessToken(host: mac.host, cookies: cookies), to: mac.id) }
					}
				}
			}
		}
	}

	/// Hand `jwt` (nil: none) to the server for the Mac `id`, unless it holds that already.
	private func hand(_ jwt: String?, to id: UUID) {
		guard list.list.mac(id: id) != nil else { return }
		let now: HandedSignIn = jwt.map { .token($0) } ?? .nothing
		if (handed[id] ?? .nothing) == now { return }
		handed[id] = now
		let generation = self.generation
		let done: (Result<Void, MacsServerError>) -> Void = { [weak self] result in
			guard let self, self.generation == generation, case .failure(let error) = result else { return }
			switch error {
			case .refused(400, _) where jwt != nil:
				// Lapsed, or not a token: the server kept nothing, and there is nothing to take back.
				NSLog("omp-webui: a Mac's sign-in was not taken by the server (HTTP 400)")
			case .refused(let status, _):
				NSLog("omp-webui: a Mac's sign-in could not be handed to the server (HTTP \(status))")
				if self.handed[id] == now { self.handed[id] = .unsure }
			case .unreachable:
				if self.handed[id] == now { self.handed[id] = .unsure }
			}
		}
		if let jwt { client.handOver(id: id, jwt: jwt, completion: done) } else { client.takeBack(id: id, completion: done) }
	}
}
