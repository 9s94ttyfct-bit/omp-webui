import AppKit

/// The built-in browser's engine in the app (docs/agents/browser.md): CEF (macos/cef/CEFHost.mm), the framework the app ships
/// in Contents/Frameworks (scripts/app.ts), with its profile in `<data>/browser/cef-profile/`. Started before the app's run
/// loop, once, unless the person turned the browser off (Settings › Browser); a Clear of its profile, and turning the browser
/// on in an app that did not start it, take the app's next start (the server asks for a restart; a Clear writes `clearPending`
/// into `<data>/browser/current.json`).
enum BrowserEngine {
	private struct Current: Decodable {
		let clearPending: Bool?
		/// Left by an app that loaded CEF from the data folder: an Uninstall it had not carried out yet.
		let uninstallPending: Bool?
	}

	/// The version CEF runs (the server is told it, macos/browserlink.swift); nil while it does not.
	private(set) static var version: String?
	/// Whether the browser was turned off when the app started, so CEF was not: the server is told (`OMP_WEBUI_CEF_STARTED=0`,
	/// main.swift), and asks the app to restart when the browser is turned on again.
	private(set) static var skipped = false

	/// The profile, after a clear the server asked for is done, and what an app that installed CEF into the data folder left
	/// there is gone: its builds in `<data>/browser/cef/` (about 330 MB each) and the keys it kept in `current.json`.
	static func profile(dataDir: URL) -> URL {
		let root = dataDir.appendingPathComponent("browser")
		let profile = root.appendingPathComponent("cef-profile")
		try? FileManager.default.removeItem(at: root.appendingPathComponent("cef"))
		let file = root.appendingPathComponent("current.json")
		guard let data = try? Data(contentsOf: file), let current = try? JSONDecoder().decode(Current.self, from: data)
		else { return profile }
		if current.clearPending == true || current.uninstallPending == true { removeProfile(profile) }
		takeOff(["clearPending", "uninstallPending", "cef", "cefIncompatible"], current: file)
		return profile
	}

	/// CEF's profile and its log go.
	private static func removeProfile(_ profile: URL) {
		try? FileManager.default.removeItem(at: profile)
		try? FileManager.default.removeItem(at: URL(fileURLWithPath: profile.path + ".log"))
	}

	/// The requests the app has done are taken off `current.json`, the rest of it kept as it is (not written when none is there).
	private static func takeOff(_ keys: [String], current file: URL) {
		guard let data = try? Data(contentsOf: file),
			var object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
			keys.contains(where: { object[$0] != nil })
		else { return }
		for key in keys { object.removeValue(forKey: key) }
		guard let out = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else { return }
		let temporary = file.appendingPathExtension("tmp")
		if (try? out.write(to: temporary)) != nil { _ = try? FileManager.default.replaceItemAt(file, withItemAt: temporary) }
	}

	/// Whether the person turned the browser off: `ompw.browser` is `off` in the server's preferences (`<data>/ui-prefs.json`,
	/// server/prefs.ts). A file that cannot be read counts as on, the preference's default.
	private static func turnedOff(dataDir: URL) -> Bool {
		guard let data = try? Data(contentsOf: dataDir.appendingPathComponent("ui-prefs.json")),
			let store = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
			let values = store["values"] as? [String: Any]
		else { return false }
		return values["ompw.browser"] as? String == "off"
	}

	/// Start CEF, unless the browser is turned off. A failure leaves the app without it (the Browser tab says the browser
	/// cannot be used).
	static func start(dataDir: URL) {
		let profile = profile(dataDir: dataDir)
		if turnedOff(dataDir: dataDir) {
			skipped = true
			return
		}
		try? FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
		do {
			try CEFHost.start(withProfile: profile.path)
			version = CEFHost.version()
		} catch {
			FileHandle.standardError.write(Data("omp-webui: the built-in browser did not start: \(error.localizedDescription)\n".utf8))
		}
	}

	/// The window the pages are shown in is closing: they go on running in the hidden one.
	static func park() {
		if CEFHost.running() { CEFHost.parkAll() }
	}

	/// The app quits: every page closes, and CEF stops.
	static func stop() {
		if CEFHost.running() { CEFHost.shutdown() }
	}
}
