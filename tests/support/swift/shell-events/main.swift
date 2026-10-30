import AppKit
import Foundation

// Harness for macos/shellevents.swift: what the app makes of the server's stream, run as the app runs it, against servers the
// test (tests/unit/macos-shell-events.test.ts) stands up. Prints one JSON object:
//
//   pure     how a line is read, how the pieces of a response are cut into lines, and the request the app makes
//   stream   the messages one `ShellEventStream` hands over, in order, as it follows server `a` (which ends the response, so it
//            reads again), then `b` (a server at another address), is refused by `refused` (and tries again), and is stopped
//
//   harness <a> <b> <refused>      the servers' origins

/// `main.swift` of the app names the app (quit.swift's words say it).
let appName = "omp-webui"

setvbuf(stdout, nil, _IOLBF, 0)

func json(_ value: Any) -> String {
	String(data: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
}

func plain(_ message: ShellMessage) -> [String: Any] {
	switch message {
	case .state(let state, let epoch):
		return [
			"t": "state", "working": state.working, "asking": state.asking, "paused": state.paused, "menuIcon": state.menuIcon,
			"questions": state.questions, "finished": state.finished, "epoch": epoch,
		]
	case .attention(let banner, let seq):
		return [
			"t": "attention", "seq": seq, "id": banner.id, "title": banner.title, "body": banner.body, "liveId": banner.liveId,
			"file": banner.file ?? NSNull(),
		]
	}
}

// MARK: pure

func pure() -> [String: Any] {
	let lines = [
		#"{"t":"state","working":2,"asking":1,"epoch":"E1"}"#,
		#"{"t":"state","working":-1,"asking":0,"epoch":"E1"}"#,
		#"{"t":"state","working":"2","asking":0,"epoch":"E1"}"#,
		#"{"t":"state","working":1,"epoch":"E1"}"#,
		#"{"t":"state","working":1,"asking":0}"#,
		#"{"t":"state","working":1,"asking":0,"epoch":""}"#,
		#"{"t":"attention","seq":4,"id":"L","kind":"asking","title":"T","body":"B","liveId":"L","file":"/s/a.jsonl"}"#,
		#"{"t":"attention","seq":1,"id":"L","kind":"finished","title":"T","body":"B","liveId":"L","file":null}"#,
		#"{"t":"attention","seq":0,"id":"L","title":"T","body":"B","liveId":"L","file":null}"#,
		#"{"t":"attention","id":"L","title":"T","body":"B","liveId":"L","file":null}"#,
		#"{"t":"attention","seq":1,"id":"","title":"T","body":"B","liveId":"L","file":null}"#,
		#"{"t":"attention","seq":1,"id":"L","title":"T","body":"B","liveId":"","file":null}"#,
		#"{"t":"attention","seq":1,"id":"L","title":1,"body":"B","liveId":"L","file":null}"#,
		#"{"t":"later","anything":1}"#,
		#"{"working":1}"#,
		"not json",
		"[1,2]",
		"",
		#"{"t":"state","working":0,"asking":0,"paused":3,"menuIcon":false,"epoch":"E1"}"#,
		#"{"t":"state","working":1,"asking":2,"paused":0,"menuIcon":true,"questions":3,"finished":7,"epoch":"E1"}"#,
		#"{"t":"state","working":0,"asking":0,"questions":-2,"finished":"many","epoch":"E1"}"#,
	]
	var splitter = LineSplitter()
	// One response, cut where the network cut it: in the middle of a line, of a character, and with heartbeats between.
	let bytes = Data("{\"t\":\"state\",\"working\":1,\"asking\":0}\n\n{\"t\":\"attention\",\"id\":\"é\",\"title\":\"日本語\",\"body\":\"B\",\"liveId\":\"é\",\"file\":null}\n\nrest".utf8)
	var pieces: [[String]] = []
	var from = 0
	// Cuts inside the first line, between the bytes of é, between the bytes of 日, and just before the end.
	for cut in [10, 40, 62, 75, 95, bytes.count] {
		pieces.append(splitter.append(Data(bytes[from..<cut])))
		from = cut
	}
	var endless = LineSplitter()
	let big = endless.append(Data(repeating: 0x61, count: LineSplitter.longestLine + 10))
	let afterBig = endless.append(Data("\n{\"t\":\"state\",\"working\":0,\"asking\":0}\n".utf8))

	let origin = URL(string: "http://127.0.0.1:7878")!
	let request = shellEventsRequest(origin: origin, token: "tok", language: .zh)
	let english = shellEventsRequest(origin: origin, token: "tok", language: .en)
	let resumed = shellEventsRequest(origin: origin, token: "tok", language: .zh, epoch: "E 1", since: 7)
	// Where the app was in an epoch is told only as a pair: one of them says nothing.
	let half = shellEventsRequest(origin: origin, token: "tok", language: .zh, epoch: "E1", since: nil)
	return [
		"parsed": lines.map { parseShellMessage($0).map(plain) ?? "nil" as Any },
		"pieces": pieces,
		"endless": ["first": big, "after": afterBig],
		"request": [
			"url": request.url!.absoluteString, "token": request.value(forHTTPHeaderField: "x-omp-webui-token") ?? "",
			"method": request.httpMethod ?? "", "timeout": request.timeoutInterval, "cookies": request.httpShouldHandleCookies,
			"english": english.url!.absoluteString, "resumed": resumed.url!.absoluteString, "half": half.url!.absoluteString,
		],
		"codes": [ShellLanguage.en.code, ShellLanguage.zh.code],
	]
}

// MARK: stream

func spin(_ seconds: TimeInterval, until done: () -> Bool = { false }) {
	let end = Date().addingTimeInterval(seconds)
	while Date() < end && !done() { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
}

func stream() -> [String: Any] {
	let a = URL(string: CommandLine.arguments[1])!
	let b = URL(string: CommandLine.arguments[2])!
	let refused = URL(string: CommandLine.arguments[3])!
	var heard: [[String: Any]] = []
	var marks: [String: Int] = [:]
	// The Mac prefers Chinese: what the server is told to use when the person saved no language.
	let reader = ShellEventStream(token: "tok", language: { .zh }, retryDelay: { _ in 0.05 }) { heard.append(plain($0)) }

	reader.connect(to: a)
	// `a` says a state and a notice (in two pieces), then ends the response: the app reads again, and `a` says a state again.
	spin(10) { heard.count >= 3 }
	marks["afterA"] = heard.count
	reader.connect(to: a)  // the same address: no second connection
	reader.connect(to: b)
	spin(10) { heard.count >= 4 }
	marks["afterB"] = heard.count
	reader.connect(to: refused)
	spin(1.0)
	reader.stop()
	let stoppedAt = Date().timeIntervalSince1970 * 1000
	let stopped = heard.count
	spin(0.5)
	return ["heard": heard, "marks": marks, "silentAfterStop": heard.count == stopped, "stoppedAt": stoppedAt]
}

let report: [String: Any] = ["pure": pure(), "stream": stream()]
print(json(report))
exit(0)
