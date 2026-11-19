import Foundation

/// Reads what a child process prints (the server's standard output and error go to one pipe) as it prints it:
/// `deliver` gets each piece of text, on a background queue, and `atEnd` is called once after the last of them.
///
/// At end of file, when the child has exited and nothing else holds the pipe, the handler removes itself. A
/// `readabilityHandler` that is left in place on a pipe at its end is called again at once, for ever, with nothing to
/// read: after the server stopped, the "server stopped" alert kept a whole CPU core busy for as long as it was open
/// (#311). The end is also how a crash report is known to be complete: a child's last words (the error and stack it
/// died with) are in the pipe when it exits, and only the end of the pipe says that they have all been read (#374).
///
/// A read can end in the middle of a character (a Chinese folder name in a stack trace): the pieces are decoded with
/// `UTF8Pieces`, which keeps such a tail for the next read, so that the alert does not show it as two � (#379).
func followOutput(of handle: FileHandle, _ deliver: @escaping (String) -> Void, atEnd: @escaping () -> Void = {}) {
	// The handler's calls come one after another, never two at once, so the decoder needs no lock.
	let pieces = UTF8Pieces()
	handle.readabilityHandler = { h in
		let data = h.availableData
		if data.isEmpty {
			h.readabilityHandler = nil
			let rest = pieces.finish()
			if !rest.isEmpty { deliver(rest) }
			atEnd()
			return
		}
		let text = pieces.decode(data)
		if !text.isEmpty { deliver(text) }
	}
}

/// Decodes UTF-8 that arrives in pieces cut anywhere: each piece is decoded up to its last whole character, and the
/// bytes of a character that the next piece completes wait for it. Bytes that are not UTF-8 at all read as U+FFFD, as
/// `String(decoding:as:)` reads them.
final class UTF8Pieces {
	private var pending = Data()

	func decode(_ data: Data) -> String {
		pending.append(data)
		let whole = UTF8Pieces.wholeLength(of: pending)
		let text = String(decoding: pending.prefix(whole), as: UTF8.self)
		pending = Data(pending.suffix(from: pending.startIndex + whole))
		return text
	}

	/// What is still held at the end of the stream: a character that was never completed, read as U+FFFD.
	func finish() -> String {
		defer { pending = Data() }
		return String(decoding: pending, as: UTF8.self)
	}

	/// How many of `bytes`' first bytes end on a whole character: all of them, unless the last lead byte (within the
	/// last three, the longest a cut character can leave) announces more continuation bytes than follow it.
	static func wholeLength(of bytes: Data) -> Int {
		let count = bytes.count
		var back = 1
		while back <= min(3, count) {
			let byte = bytes[bytes.startIndex + count - back]
			if byte & 0b1100_0000 != 0b1000_0000 {
				let needed = byte >= 0b1111_0000 ? 4 : byte >= 0b1110_0000 ? 3 : byte >= 0b1100_0000 ? 2 : 1
				return needed > back ? count - back : count
			}
			back += 1
		}
		return count
	}
}
