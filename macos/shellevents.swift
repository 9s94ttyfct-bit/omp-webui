import Foundation

// What the server tells the app on its own (#627): one response that does not end, `GET /api/shell/events`, of newline-delimited
// JSON (server/shell-events.ts has the protocol). The app's notifications and the menu bar icon's menu come from it, so that
// neither needs a window or a page: how many conversations work and how many wait for an answer, how many unattended questions
// are open and how many runs finished (#705), and a notification for each conversation that needs somebody, with its words (in
// the language the person saved, else this Mac's).

/// Where it is read, under the server's origin.
let shellEventsPath = "api/shell/events"

/// One line of the stream.
enum ShellMessage: Equatable {
	/// The counts of the menu bar icon and whether it is wanted beside the window; `epoch` names the server's run.
	case state(ShellState, epoch: String)
	/// A conversation needs somebody (a notification to show); `seq` numbers the notices of an epoch from 1.
	case attention(Banner, seq: Int)
}

/// The message a line is, or nil for anything else (a line a newer server sends that this app does not know, or damage).
func parseShellMessage(_ line: String) -> ShellMessage? {
	guard let data = line.data(using: .utf8), let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
		let type = json["t"] as? String
	else { return nil }
	switch type {
	case "state":
		guard let working = json["working"] as? Int, let asking = json["asking"] as? Int, working >= 0, asking >= 0,
			let epoch = json["epoch"] as? String, !epoch.isEmpty
		else { return nil }
		let paused = max(0, json["paused"] as? Int ?? 0)
		let menuIcon = json["menuIcon"] as? Bool ?? true
		let questions = max(0, json["questions"] as? Int ?? 0)
		let finished = max(0, json["finished"] as? Int ?? 0)
		return .state(
			ShellState(working: working, asking: asking, paused: paused, menuIcon: menuIcon, questions: questions, finished: finished),
			epoch: epoch)
	case "attention":
		guard let id = json["id"] as? String, !id.isEmpty, let title = json["title"] as? String, let body = json["body"] as? String,
			let liveId = json["liveId"] as? String, !liveId.isEmpty, let seq = json["seq"] as? Int, seq >= 1
		else { return nil }
		let file = (json["file"] as? String).flatMap { $0.isEmpty ? nil : $0 }
		return .attention(Banner(id: id, title: title, body: body, liveId: liveId, file: file), seq: seq)
	default:
		return nil
	}
}

/// Text that arrives in pieces of any size, as lines: a piece may end in the middle of one. Empty lines (the server's heartbeat)
/// are not lines. A line that never ends is not kept for ever.
struct LineSplitter {
	private var pending = Data()
	static let longestLine = 1 << 20

	/// The complete lines the piece finished, in order.
	mutating func append(_ piece: Data) -> [String] {
		pending.append(piece)
		var lines: [String] = []
		while let end = pending.firstIndex(of: 0x0A) {
			let line = pending[pending.startIndex..<end]
			pending = Data(pending[(end + 1)...])
			if !line.isEmpty { lines.append(String(decoding: line, as: UTF8.self)) }
		}
		if pending.count > LineSplitter.longestLine { pending = Data() }
		return lines
	}
}

extension ShellLanguage {
	/// The language as the server's `?lang=` names it (the interface languages of the page).
	var code: String { self == .zh ? "zh-CN" : "en" }
}

/// The request for a stream under `origin` at `path`, signed in with `headers`, in the Mac's language, which the server uses when the
/// person saved none. `epoch` and `since` say where the app was when it stopped reading, so that the notices it missed are sent again.
func eventsRequest(
	origin: URL, path: String, headers: [String: String], language: ShellLanguage, epoch: String? = nil, since: Int? = nil
) -> URLRequest {
	var components = URLComponents(url: origin.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
	components.queryItems = [URLQueryItem(name: "lang", value: language.code)]
	if let epoch, let since { components.queryItems?.append(contentsOf: [URLQueryItem(name: "epoch", value: epoch), URLQueryItem(name: "since", value: String(since))]) }
	var request = URLRequest(url: components.url!)
	for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
	request.cachePolicy = .reloadIgnoringLocalCacheData
	// What it is signed in with is what it is given (a `Cookie` header, for another Mac's): the system's own cookie handling adds none.
	request.httpShouldHandleCookies = false
	// The server says it is there every 15 s: a response that is silent for three times that has stalled.
	request.timeoutInterval = 45
	return request
}

/// The request for this app's own server's stream: with the app's token.
func shellEventsRequest(
	origin: URL, token: String, language: ShellLanguage, epoch: String? = nil, since: Int? = nil
) -> URLRequest {
	eventsRequest(
		origin: origin, path: shellEventsPath, headers: ["x-omp-webui-token": token], language: language, epoch: epoch, since: since)
}

/// How a stream makes its request: where it reads (`origin`), the language, and where it was in the server's run (`epoch`, `since`).
/// The answer is given when it is ready, since what signs a request in may take a moment to be had (another Mac's cookies are in a
/// web data store); nil: there is nothing to sign in with yet, and the reader tries again after a pause.
typealias EventsRequestMaker = (URL, ShellLanguage, String?, Int?, @escaping (URLRequest?) -> Void) -> Void

/// The app reading the stream for as long as it runs: it begins when the server is up, begins again when the server comes up at
/// another address, and goes on after the connection breaks (the server restarted, a stall) until it is stopped. Messages are
/// handed over on the main queue.
final class ShellEventStream: NSObject, URLSessionDataDelegate {
	private let makeRequest: EventsRequestMaker
	private let language: () -> ShellLanguage
	private let onMessage: (ShellMessage) -> Void
	private var session: URLSession!
	private var task: URLSessionDataTask?
	private var origin: URL?
	private var splitter = LineSplitter()
	/// Connections that failed since one worked: how long the next try waits.
	private var failures = 0
	private var retry: DispatchWorkItem?
	/// Counts the connections made: what an earlier one says after a later began is not heard.
	private var generation = 0
	private let retryDelay: (Int) -> TimeInterval
	/// Where the app was in the server's run when it last read: the server's epoch, and the last notice of it that came. After the
	/// connection breaks, the server is asked for what came after (`shellEventsRequest`).
	private var epoch: String?
	private var lastSeq = 0

	/// `retryDelay`: seconds to wait after that many failures in a row (tests shorten it).
	init(
		makeRequest: @escaping EventsRequestMaker, language: @escaping () -> ShellLanguage,
		retryDelay: @escaping (Int) -> TimeInterval = { min(0.5 * pow(2, Double($0 - 1)), 10) },
		onMessage: @escaping (ShellMessage) -> Void
	) {
		self.makeRequest = makeRequest
		self.language = language
		self.retryDelay = retryDelay
		self.onMessage = onMessage
		super.init()
		let configuration = URLSessionConfiguration.ephemeral
		configuration.waitsForConnectivity = false
		configuration.urlCache = nil
		session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
	}

	/// The stream of this app's own server, signed in with its token.
	convenience init(
		token: String, language: @escaping () -> ShellLanguage,
		retryDelay: @escaping (Int) -> TimeInterval = { min(0.5 * pow(2, Double($0 - 1)), 10) },
		onMessage: @escaping (ShellMessage) -> Void
	) {
		self.init(
			makeRequest: { origin, language, epoch, since, done in
				done(shellEventsRequest(origin: origin, token: token, language: language, epoch: epoch, since: since))
			},
			language: language, retryDelay: retryDelay, onMessage: onMessage)
	}

	/// Read from the server at `origin` (nil: stop). The same origin as before changes nothing.
	func connect(to origin: URL?) {
		guard origin != self.origin else { return }
		stop()
		self.origin = origin
		if origin != nil { start() }
	}

	func stop() {
		retry?.cancel()
		retry = nil
		generation += 1
		task?.cancel()
		task = nil
		splitter = LineSplitter()
		failures = 0
		origin = nil
	}

	/// Read again now, without waiting out a pause: what the reader is signed in with has changed (the person signed in again).
	func reconnect() {
		guard origin != nil else { return }
		retry?.cancel()
		retry = nil
		task?.cancel()
		task = nil
		failures = 0
		start()
	}

	private func start() {
		retry = nil
		guard let origin else { return }
		generation += 1
		let mine = generation
		splitter = LineSplitter()
		makeRequest(origin, language(), epoch, epoch == nil ? nil : lastSeq) { [weak self] request in
			// Stopped, or begun again, while the request was being made.
			guard let self, self.generation == mine, self.origin != nil else { return }
			guard let request else { return self.again() }
			let made = self.session.dataTask(with: request)
			made.taskDescription = String(mine)
			self.task = made
			made.resume()
		}
	}

	private func isCurrent(_ task: URLSessionTask) -> Bool { task.taskDescription == String(generation) }

	/// The connection ended, or never came: another is made after a pause that grows while they keep failing.
	private func again() {
		task = nil
		guard origin != nil else { return }
		failures += 1
		let work = DispatchWorkItem { [weak self] in self?.start() }
		retry = work
		DispatchQueue.main.asyncAfter(deadline: .now() + retryDelay(failures), execute: work)
	}

	// MARK: URLSessionDataDelegate

	func urlSession(
		_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
		completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
	) {
		guard isCurrent(dataTask) else { return completionHandler(.cancel) }
		// Anything but the stream (the server is another version, or refused the app) is not read.
		guard (response as? HTTPURLResponse)?.statusCode == 200 else { return completionHandler(.cancel) }
		failures = 0
		completionHandler(.allow)
	}

	func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
		guard isCurrent(dataTask) else { return }
		for line in splitter.append(data) {
			guard let message = parseShellMessage(line) else { continue }
			switch message {
			case .state(_, let served): if served != epoch { (epoch, lastSeq) = (served, 0) }
			case .attention(_, let seq): lastSeq = max(lastSeq, seq)
			}
			onMessage(message)
		}
	}

	/// A redirect is not followed: the request is signed in for the address it names, and what it carries (a token, cookies) is not
	/// for another. A server that redirects is one that wants somebody to sign in, and is not read.
	func urlSession(
		_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
		newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
	) {
		completionHandler(nil)
	}

	func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
		guard isCurrent(task) else { return }
		again()
	}
}
