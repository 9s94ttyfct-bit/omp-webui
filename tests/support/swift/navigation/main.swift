import Foundation

// Harness for macos/navigation.swift's `movedPageURL`: where a pop-out's page goes when the server came back at another
// address (#378). Prints one JSON object of what it answers for each case (see tests/unit/macos-navigation.test.ts); a
// case it answers nil for is null.

let old = URL(string: "http://127.0.0.1:7878")!
let moved = URL(string: "http://127.0.0.1:7879")!

func ask(_ address: String?, from: URL = old, to: URL = moved) -> Any {
	movedPageURL(address.flatMap { URL(string: $0) }, from: from, to: to)?.absoluteString ?? NSNull()
}

let report: [String: Any] = [
	"popOut": ask("http://127.0.0.1:7878/?popout#/s/%2Ftmp%2Fa.jsonl/agent/Scout"),
	"browser": ask("http://127.0.0.1:7878/?popout#/live/L1/browser"),
	"pathAndQuery": ask("http://127.0.0.1:7878/api/meta?x=1&y=2"),
	"alreadyMoved": ask("http://127.0.0.1:7879/?popout#/s/a/agent/b"),
	"otherPort": ask("http://127.0.0.1:7000/?popout"),
	"otherHost": ask("http://example.com:7878/?popout"),
	"otherScheme": ask("https://127.0.0.1:7878/?popout"),
	"blank": ask("about:blank"),
	"none": ask(nil),
	"samePort": ask("http://127.0.0.1:7878/?popout#/s/a/agent/b", to: old),
]
let json = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
print(String(decoding: json, as: UTF8.self))
