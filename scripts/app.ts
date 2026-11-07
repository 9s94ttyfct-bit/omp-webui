/**
 * Builds the macOS app (`bun run app`) → dist/omp-webui.app (Apple Silicon, for local use), signed with the
 * "omp-webui local signing" identity when this Mac has one (scripts/signing-identity.ts), else ad hoc.
 *
 *   Contents/MacOS/omp-webui          Swift/AppKit shell with a WebKit window (macos/*.swift), with the built-in
 *                                     browser's CEF host linked in (macos/cef/, CEF's C++ wrapper from third_party/cef)
 *   Contents/Frameworks/Chromium Embedded Framework.framework  CEF itself, the build third_party/cef/cef-build.json pins
 *                                     (scripts/lib/cef-dist.ts downloads it once into .tmp/), where Chrome's sandbox lets
 *                                     the helpers read it
 *   Contents/Frameworks/omp-webui Helper*.app  CEF's helper processes (renderer, GPU, plugin, the rest), sandboxed
 *   Contents/Resources/omp-webui-server  the Bun server compiled with its runtime (no bun/node needed)
 *   Contents/Resources/web/           the built web UI
 *
 * omp is not bundled: the shell finds the installed one at launch. Everything is signed inside out with one identity
 * (`signBundle`): the framework's libraries and the framework, the helpers, then the app.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { readMaster, renderIcon } from "./icons.ts";
import { cefFramework, FRAMEWORK } from "./lib/cef-dist.ts";
import { encodePng } from "./lib/png.ts";
import { serverCompileArgv } from "./lib/server-compile.ts";
import { killTree, onShutdown } from "./lib/shutdown.ts";
import { signBundle } from "./signing-identity.ts";

const root = join(import.meta.dir, "..");
const out = join(root, "dist", "omp-webui.app");
const stage = mkdtempSync(join(tmpdir(), "ompw-app-"));
const app = join(stage, "omp-webui.app");
const contents = join(app, "Contents");
const resources = join(contents, "Resources");

/** The command running now: a signal stops it before the staging directory under it is removed. */
let running: Bun.Subprocess | null = null;

async function run(cmd: string[], cwd = root): Promise<void> {
	console.log(`$ ${cmd.join(" ")}`);
	const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
	running = proc;
	const code = await proc.exited;
	running = null;
	if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}`);
}

/**
 * CEF's headers and C++ wrapper (third_party/cef): the version and API version the app is built against (cef-build.json, not
 * `VERSION`: on a case-insensitive disk that name would be taken for the C++ header `<version>`).
 */
const cef = join(root, "third_party", "cef");
const { version: cefVersion, apiVersion: cefApi } = JSON.parse(readFileSync(join(cef, "cef-build.json"), "utf8")) as {
	version: string;
	apiVersion: number;
};
/** How CEF's own build compiles C++ on macOS (cmake/cef_variables.cmake), for the wrapper and for the code that uses it. */
const CXX = [
	"clang++",
	"-std=c++20",
	"-O2",
	"-arch",
	"arm64",
	"-mmacosx-version-min=13.0",
	"-fno-exceptions",
	"-fno-rtti",
	"-fno-threadsafe-statics",
	"-fvisibility=hidden",
	"-fvisibility-inlines-hidden",
	`-I${cef}`,
	`-DCEF_API_VERSION=${cefApi}`,
];
/** Compilers running at once (the wrapper's files are compiled side by side): a signal stops them too. */
const compiling = new Set<Bun.Subprocess>();

async function compile(cmd: string[]): Promise<void> {
	const proc = Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
	compiling.add(proc);
	const code = await proc.exited;
	compiling.delete(proc);
	if (code !== 0) throw new Error(`${cmd.join(" ")} exited with ${code}`);
}

/**
 * CEF's C++ wrapper (`libcef_dll`), a static library: built once per CEF version, and kept in .tmp/ for the next builds
 * (about 200 files).
 */
async function cefWrapper(): Promise<string> {
	const dir = join(root, ".tmp", "cef-wrapper", `${cefVersion}-${cefApi}`);
	const lib = join(dir, "libcef_dll_wrapper.a");
	if (existsSync(lib)) return lib;
	const objects = join(dir, "obj");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(objects, { recursive: true });
	const sources = [...new Bun.Glob("libcef_dll/**/*.{cc,mm}").scanSync({ cwd: cef })].sort();
	console.log(`Building CEF's C++ wrapper (${sources.length} files) into ${dir}`);
	const outputs = sources.map((_, i) => join(objects, `${i}.o`));
	let next = 0;
	const worker = async () => {
		while (next < sources.length) {
			const i = next++;
			const source = sources[i];
			const objc = source.endsWith(".mm") ? ["-ObjC++"] : [];
			// CEF's own templates leave `kWrapperType` to each type's file, which clang warns about in every file that uses one.
			const quiet = "-Wno-undefined-var-template";
			await compile([...CXX, ...objc, quiet, "-DWRAPPING_CEF_SHARED", "-c", join(cef, source), "-o", outputs[i]]);
		}
	};
	await Promise.all(Array.from({ length: availableParallelism() }, worker));
	await run(["ar", "rcs", `${lib}.part`, ...outputs]);
	renameSync(`${lib}.part`, lib);
	rmSync(objects, { recursive: true, force: true });
	return lib;
}

/** CEF's helper bundles in Contents/Frameworks: the one CEF starts (`browser_subprocess_path`), and its named kinds. */
const HELPERS = ["", " (GPU)", " (Renderer)", " (Plugin)"].map((kind) => ({
	name: `omp-webui Helper${kind}`,
	id: `dev.omp.webui.helper${kind ? `.${kind.replace(/[ ()]/g, "").toLowerCase()}` : ""}`,
}));

/** The icon scratch directory, once made. */
let iconTmp = "";
// A signal ends the script without running the `finally` below.
const cleanup = onShutdown(async () => {
	if (running) await killTree(running.pid, 3000);
	await Promise.all([...compiling].map((proc) => killTree(proc.pid, 3000)));
	rmSync(stage, { recursive: true, force: true });
	if (iconTmp) rmSync(iconTmp, { recursive: true, force: true });
});
try {
	mkdirSync(join(contents, "MacOS"), { recursive: true });
	mkdirSync(resources, { recursive: true });

	await run(["bunx", "vite", "build"]);
	cpSync(join(root, "dist", "web"), join(resources, "web"), { recursive: true });

	// Run from the staging dir: `bun build --compile` leaves a `.*.bun-build` temp file in its cwd.
	await run(
		serverCompileArgv(root, {
			entry: "main.ts",
			target: "bun-darwin-arm64",
			outfile: join(resources, "omp-webui-server"),
		}),
		stage,
	);

	// The built-in browser's host (macos/cef/): Objective-C++ against CEF's wrapper, linked into the shell, whose Swift sees it
	// through CEFHost.h; and CEF's helper processes, one binary in each helper bundle.
	const wrapper = await cefWrapper();
	const hostObjects = join(stage, "cef-host");
	mkdirSync(hostObjects, { recursive: true });
	const objects = ["CEFHost", "OmpApplication"].map((name) => join(hostObjects, `${name}.o`));
	await Promise.all(
		["CEFHost", "OmpApplication"].map((name, i) =>
			compile([...CXX, "-ObjC++", "-fobjc-arc", "-c", join(root, "macos", "cef", `${name}.mm`), "-o", objects[i]]),
		),
	);
	await run([
		"swiftc",
		"-O",
		"-swift-version",
		"5",
		"-target",
		"arm64-apple-macos13.0",
		"-import-objc-header",
		"macos/cef/CEFHost.h",
		"macos/main.swift",
		"macos/appmenu.swift",
		"macos/background.swift",
		"macos/browser.swift",
		"macos/browserlink.swift",
		"macos/downloads.swift",
		"macos/droppaths.swift",
		"macos/loginitem.swift",
		"macos/mainwindow.swift",
		"macos/navigation.swift",
		"macos/notifications.swift",
		"macos/popout.swift",
		"macos/quit.swift",
		"macos/remotemacs.swift",
		"macos/remotemenu.swift",
		"macos/remotenotify.swift",
		"macos/remotepolicy.swift",
		"macos/remotewindow.swift",
		"macos/server.swift",
		"macos/serveroutput.swift",
		"macos/shellevents.swift",
		"macos/update.swift",
		"macos/webview.swift",
		"macos/windowframe.swift",
		...objects,
		"-Xlinker",
		wrapper,
		"-lc++",
		"-o",
		join(contents, "MacOS", "omp-webui"),
	]);

	const helperBinary = join(hostObjects, "omp-webui Helper");
	await compile([
		...CXX,
		"-ObjC++",
		join(root, "macos", "cef", "helper.mm"),
		wrapper,
		"-framework",
		"Cocoa",
		"-o",
		helperBinary,
	]);
	for (const helper of HELPERS) {
		const bundle = join(contents, "Frameworks", `${helper.name}.app`, "Contents");
		mkdirSync(join(bundle, "MacOS"), { recursive: true });
		cpSync(helperBinary, join(bundle, "MacOS", helper.name));
		writeFileSync(
			join(bundle, "Info.plist"),
			`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>${helper.name}</string>
	<key>CFBundleExecutable</key><string>${helper.name}</string>
	<key>CFBundleIdentifier</key><string>${helper.id}</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>${pkg.version}</string>
	<key>CFBundleVersion</key><string>${pkg.version}</string>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<key>LSUIElement</key><true/>
	<key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`,
		);
	}
	// CEF's framework of the pinned build, in CEF's standard place: the helpers' sandbox lets them read only the app's bundle.
	const cefDist = await cefFramework(root, cefVersion, cefApi);
	cpSync(join(cefDist, FRAMEWORK), join(contents, "Frameworks", FRAMEWORK), {
		recursive: true,
		verbatimSymlinks: true,
	});

	// Icon: macos/icon.png (1024 px, the shape on Apple's 824 px grid, transparent around it) → iconset → .icns, each
	// size rendered the way scripts/icons.ts renders the web's. `readMaster` refuses an opaque corner: it would show as
	// a frame around the icon in the Dock.
	const master = readMaster();
	iconTmp = mkdtempSync(join(tmpdir(), "ompw-icon-"));
	const iconset = join(iconTmp, "AppIcon.iconset");
	mkdirSync(iconset);
	for (const size of [16, 32, 128, 256, 512]) {
		for (const scale of [1, 2]) {
			const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
			writeFileSync(join(iconset, name), encodePng(renderIcon(master, size * scale, "plate")));
		}
	}
	await run(["iconutil", "-c", "icns", iconset, "-o", join(resources, "AppIcon.icns")]);
	rmSync(iconTmp, { recursive: true, force: true });

	writeFileSync(
		join(contents, "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>omp-webui</string>
	<key>CFBundleDisplayName</key><string>omp-webui</string>
	<key>CFBundleIdentifier</key><string>dev.omp.webui</string>
	<key>CFBundleExecutable</key><string>omp-webui</string>
	<key>CFBundleIconFile</key><string>AppIcon</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>${pkg.version}</string>
	<key>CFBundleVersion</key><string>${pkg.version}</string>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
	<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
	<!-- Without it macOS kills the app (SIGABRT, TCC) the moment a page asks for a passkey: CEF's WebAuthn dialog looks for Bluetooth devices for the phone (hybrid) sign-in. -->
	<key>NSBluetoothAlwaysUsageDescription</key><string>omp-webui uses Bluetooth when a page in its built-in browser asks for a passkey, so that you can sign in with your phone or a security key nearby.</string>
</dict>
</plist>
`,
	);

	// The identity's signature (scripts/signing-identity.ts): every build has the same designated requirement, so
	// macOS keeps the app's permissions across updates. Ad hoc, with a warning, when this Mac has none.
	const { identity } = signBundle(app);
	console.log(identity ? `Signed with the identity ${identity}` : "Signed ad hoc");

	rmSync(out, { recursive: true, force: true });
	mkdirSync(join(root, "dist"), { recursive: true });
	renameSync(app, out);
	console.log(`\nBuilt ${out}`);
} finally {
	await cleanup();
}
