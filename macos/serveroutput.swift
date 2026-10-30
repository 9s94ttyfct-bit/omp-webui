import Foundation

/// Reads what a child process prints (the server's standard output and error go to one pipe) as it prints it:
/// `deliver` gets each piece of text, on a background queue, and `atEnd` is called once after the last of them.
///
/// At end of file, when the child has exited and nothing else holds the pipe, the handler removes itself. A
/// `readabilityHandler` that is left in place on a pipe at its end is called again at once, for ever, with nothing to
/// read: after the server stopped, the "server stopped" alert kept a whole CPU core busy for as long as it was open
/// (#311). The end is also how a crash report is known to be complete: a child's last words (the error and stack it
/// died with) are in the pipe when it exits, and only the end of the pipe says that they have all been read (#374).
func followOutput(of handle: FileHandle, _ deliver: @escaping (String) -> Void, atEnd: @escaping () -> Void = {}) {
	handle.readabilityHandler = { h in
		let data = h.availableData
		if data.isEmpty {
			h.readabilityHandler = nil
			atEnd()
			return
		}
		deliver(String(decoding: data, as: UTF8.self))
	}
}
