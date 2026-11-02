import AppKit

/// The built-in browser's engine in the app (docs/agents/browser.md): CEF (macos/cef/CEFHost.mm), when the server installed a
/// version of it into the data folder (`<data>/browser/current.json` names it; the build is in `<data>/browser/cef/<version>/`,
/// its profile in `<data>/browser/cef-profile/`). Started before the app's run loop, once; a new version or a cleared profile
/// takes the app's next start (the server asks for a restart). Without one, nothing of CEF is loaded.
enum BrowserEngine {
	private struct Current: Decodable {
		struct Cef: Decodable { let version: String }
		let cef: Cef?
		let clearPending: Bool?
	}

	/// The version CEF runs (the server is told it, macos/browserlink.swift); nil while it does not.
	private(set) static var version: String?

	/// The installed version, its framework folder and the profile, when there is one; a clear the server asked for is done first.
	static func installed(dataDir: URL) -> (version: String, framework: URL, profile: URL)? {
		let root = dataDir.appendingPathComponent("browser")
		let file = root.appendingPathComponent("current.json")
		guard let data = try? Data(contentsOf: file), let current = try? JSONDecoder().decode(Current.self, from: data),
			let version = current.cef?.version, !version.contains("/"), version != ".."
		else { return nil }
		let profile = root.appendingPathComponent("cef-profile")
		if current.clearPending == true { clearProfile(profile, current: file) }
		let framework = root.appendingPathComponent("cef").appendingPathComponent(version).appendingPathComponent("Release")
		let bundle = framework.appendingPathComponent("Chromium Embedded Framework.framework")
		return FileManager.default.fileExists(atPath: bundle.path) ? (version, framework, profile) : nil
	}

	/// CEF's profile goes (Settings › Browser › Clear); the request is taken off `current.json`, the rest of it kept as it is.
	private static func clearProfile(_ profile: URL, current file: URL) {
		try? FileManager.default.removeItem(at: profile)
		try? FileManager.default.removeItem(at: URL(fileURLWithPath: profile.path + ".log"))
		guard let data = try? Data(contentsOf: file),
			var object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
		else { return }
		object.removeValue(forKey: "clearPending")
		guard let out = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else { return }
		let temporary = file.appendingPathExtension("tmp")
		if (try? out.write(to: temporary)) != nil { _ = try? FileManager.default.replaceItemAt(file, withItemAt: temporary) }
	}

	/// Start CEF if a version is installed. A failure leaves the app without it (the Browser tab says the browser is not there).
	static func start(dataDir: URL) {
		guard let found = installed(dataDir: dataDir) else { return }
		try? FileManager.default.createDirectory(at: found.profile, withIntermediateDirectories: true)
		do {
			try CEFHost.start(withFramework: found.framework.path, profile: found.profile.path)
			version = found.version
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
