import AppKit

// Harness for macos/droppaths.swift (and `isOwnPage`, which the drop bridge shares with notifications.swift): what the
// drop bridge makes of a drag's file URLs, what it keeps for the page and for how long. Prints one JSON object.
//
//   harness <an existing, empty directory to make the files in>
//
// Headless: no window, no app. A drag's pasteboard is a private named NSPasteboard, released at the end. A
// WKScriptMessage cannot be built outside WebKit, so the sender check is the pure `isOwnPage` the handler calls.

func describe(_ items: [DroppedItem]) -> [[String: Any]] {
	items.map { ["name": $0.name, "path": $0.path, "directory": $0.directory, "size": $0.size] }
}

/// A clock the test moves by hand.
final class Clock {
	var date = Date(timeIntervalSince1970: 1_000_000)
	func advance(_ seconds: TimeInterval) { date = date.addingTimeInterval(seconds) }
}

/// A drag's pasteboard: private to this run, so the user's clipboard and other runs are never touched.
func withPasteboard(_ body: (NSPasteboard) -> Void) {
	let board = NSPasteboard(name: NSPasteboard.Name("ompw-drop-test-\(UUID().uuidString)"))
	defer { board.releaseGlobally() }
	body(board)
}

func drag(_ board: NSPasteboard, files urls: [URL]) {
	board.clearContents()
	_ = board.writeObjects(urls as [NSURL])
}

func dragText(_ board: NSPasteboard, _ text: String) {
	board.clearContents()
	_ = board.setString(text, forType: .string)
}

@main struct Harness {
	static func main() {
		let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
		let fm = FileManager.default
		let file = root.appendingPathComponent("a note.txt")
		let other = root.appendingPathComponent("b.bin")
		let empty = root.appendingPathComponent("empty")
		let folder = root.appendingPathComponent("a folder")
		let missing = root.appendingPathComponent("gone.txt")
		try! Data("hello".utf8).write(to: file)
		try! Data(count: 1234).write(to: other)
		try! Data().write(to: empty)
		try! fm.createDirectory(at: folder, withIntermediateDirectories: false)
		try! Data("inside".utf8).write(to: folder.appendingPathComponent("in.txt"))
		var report: [String: Any] = [:]

		// Which items file URLs are.
		var items: [String: Any] = [:]
		items["files"] = describe(droppedItems([file, folder, other, empty]))
		items["missing"] = describe(droppedItems([missing, file]))
		items["notFile"] = describe(droppedItems([URL(string: "https://example.com/x.txt")!, file]))
		items["none"] = describe(droppedItems([]))
		// A file reference URL (what a drag can carry) is resolved to the path.
		let reference = (file as NSURL).fileReferenceURL()
		items["referenceMade"] = reference != nil
		items["reference"] = describe(droppedItems(reference.map { [$0] } ?? []))
		// The cap counts items, not URLs: what is not on disk takes no place.
		let many = Array(repeating: missing, count: 10) + Array(repeating: file, count: maxDroppedItems) + [other]
		let capped = droppedItems(many)
		items["capped"] = [
			"count": capped.count, "max": maxDroppedItems, "lastName": capped.last?.name ?? "",
			"allFirst": capped.allSatisfy { $0.name == "a note.txt" },
		]
		items["justUnderCap"] = droppedItems(Array(repeating: file, count: maxDroppedItems - 1) + [other, other]).count
		report["items"] = items

		// What the page is told.
		let answer = dropAnswer(droppedItems([other, folder, file]))
		let data = try? JSONSerialization.data(withJSONObject: answer, options: [.sortedKeys])
		report["answer"] = [
			"valid": JSONSerialization.isValidJSONObject(answer),
			"json": data.flatMap { String(data: $0, encoding: .utf8) } ?? "",
			"keys": Array(answer.keys),
			"empty": JSONSerialization.isValidJSONObject(dropAnswer([])),
			"emptyCount": (dropAnswer([])["items"] as? [Any])?.count ?? -1,
		]

		// Which messages are the request.
		let bodies: [(String, Any)] = [
			("paths", ["type": "paths"]),
			("path", ["type": "path"]),
			("Paths", ["type": "Paths"]),
			("empty type", ["type": ""]),
			("number type", ["type": 1]),
			("null type", ["type": NSNull()]),
			("no type", ["kind": "paths"]),
			("empty object", [String: Any]()),
			("string", "paths"),
			("array", ["paths"]),
			("number", 1),
			("null", NSNull()),
		]
		report["requests"] = bodies.map { ["body": $0.0, "request": isDropRequest($0.1)] as [String: Any] }
		report["handlerName"] = DropPaths.handlerName
		report["keepSeconds"] = dropKeepSeconds

		// The page a message comes from.
		let origin = URL(string: "http://127.0.0.1:7878/")
		report["ownPage"] = [
			isOwnPage(scheme: "http", host: "127.0.0.1", port: 7878, origin: origin),
			isOwnPage(scheme: "http", host: "127.0.0.1", port: 7879, origin: origin),
			isOwnPage(scheme: "http", host: "localhost", port: 7878, origin: origin),
			isOwnPage(scheme: "https", host: "127.0.0.1", port: 7878, origin: origin),
			isOwnPage(scheme: "http", host: "127.0.0.1", port: 7878, origin: nil),
			isOwnPage(scheme: "http", host: "evil.example", port: 7878, origin: origin),
		]

		// What a drop keeps for the page.
		var kept: [String: Any] = [:]
		func scenario(_ name: String, _ body: (NSPasteboard, Clock, DropPaths) -> Any) {
			withPasteboard { board in
				let clock = Clock()
				let drops = DropPaths(origin: { origin }, now: { clock.date })
				kept[name] = body(board, clock, drops)
			}
		}
		scenario("once") { board, _, drops in
			drag(board, files: [file, folder])
			drops.capture(from: board)
			let first = describe(drops.take())
			return ["first": first, "second": describe(drops.take())]
		}
		scenario("neverCaptured") { _, _, drops in describe(drops.take()) }
		scenario("fresh") { board, clock, drops in
			drag(board, files: [file])
			drops.capture(from: board)
			clock.advance(14)
			return describe(drops.take())
		}
		scenario("stale") { board, clock, drops in
			drag(board, files: [file])
			drops.capture(from: board)
			clock.advance(16)
			return ["stale": describe(drops.take()), "after": describe(drops.take())]
		}
		scenario("staleStaysGone") { board, clock, drops in
			drag(board, files: [file])
			drops.capture(from: board)
			clock.advance(16)
			_ = drops.take()
			clock.advance(-16)
			return describe(drops.take())
		}
		scenario("textReplaces") { board, _, drops in
			drag(board, files: [file])
			drops.capture(from: board)
			dragText(board, "just some words")
			drops.capture(from: board)
			return describe(drops.take())
		}
		scenario("linkReplaces") { board, _, drops in
			drag(board, files: [file])
			drops.capture(from: board)
			board.clearContents()
			_ = board.writeObjects([URL(string: "https://example.com/page")! as NSURL])
			drops.capture(from: board)
			return describe(drops.take())
		}
		scenario("newerReplaces") { board, _, drops in
			drag(board, files: [file])
			drops.capture(from: board)
			drag(board, files: [other])
			drops.capture(from: board)
			return describe(drops.take())
		}
		scenario("ageFromLastDrag") { board, clock, drops in
			drag(board, files: [file])
			drops.capture(from: board)
			clock.advance(10)
			drag(board, files: [other])
			drops.capture(from: board)
			clock.advance(10)
			return describe(drops.take())
		}
		scenario("gone") { board, _, drops in
			drag(board, files: [missing])
			drops.capture(from: board)
			return describe(drops.take())
		}
		report["kept"] = kept

		let json = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
		print(String(decoding: json, as: UTF8.self))
		exit(0)
	}
}
