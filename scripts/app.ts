/**
 * Builds the macOS app (`bun run app`) → dist/omp-webui.app (Apple Silicon, for local use), signed with the
 * "omp-webui local signing" identity when this Mac has one (scripts/signing-identity.ts), else ad hoc.
 *
 *   Contents/MacOS/omp-webui          Swift/AppKit shell with a WebKit window (macos/*.swift)
 *   Contents/Resources/omp-webui-server  the Bun server compiled with its runtime (no bun/node needed)
 *   Contents/Resources/web/           the built web UI
 *
 * omp is not bundled: the shell finds the installed one at launch.
 */
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { readMaster, renderIcon } from "./icons.ts";
import { encodePng } from "./lib/png.ts";
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

/** The icon scratch directory, once made. */
let iconTmp = "";
// A signal ends the script without running the `finally` below.
const cleanup = onShutdown(async () => {
	if (running) await killTree(running.pid, 3000);
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
		[
			"bun",
			"build",
			"--compile",
			"--minify",
			"--target=bun-darwin-arm64",
			join(root, "server", "main.ts"),
			// The family worker, which main.ts starts by a relative URL: it has to be an entry point of its own.
			join(root, "server", "family-worker.ts"),
			// The search index worker, started by a relative URL from the store in the same way.
			join(root, "server", "search-index-worker.ts"),
			// The thread that looks at the GPU, started by a relative URL from the host load's reader (a driver that hangs
			// holds that thread, not the server).
			join(root, "server", "host-gpu-worker.ts"),
			"--outfile",
			join(resources, "omp-webui-server"),
		],
		stage,
	);

	await run([
		"swiftc",
		"-O",
		"-swift-version",
		"5",
		"-target",
		"arm64-apple-macos13.0",
		"macos/main.swift",
		"macos/appmenu.swift",
		"macos/background.swift",
		"macos/downloads.swift",
		"macos/droppaths.swift",
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
		"-o",
		join(contents, "MacOS", "omp-webui"),
	]);

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
