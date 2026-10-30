/**
 * Builds the macOS installer (`bun run dmg`, after `bun run app`) → dist/omp-webui-vX.Y.Z.dmg.
 *
 * The disk image holds omp-webui.app and a link to /Applications, laid out in a 660 × 400 window over a
 * background picture (scripts/dmg-background.swift), with the app icon as the volume's icon. The layout is
 * written by Finder (AppleScript), so this needs a logged-in macOS session; `--plain` skips the layout and the
 * background (an image that mounts, but with Finder's default window).
 *
 * After building, the image is mounted read-only and checked: the app and its version, the Applications link,
 * the volume icon and (unless --plain) the window layout. Nothing else is installed or touched.
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import pkg from "../package.json";
import { isShuttingDown, killTree, onShutdown } from "./lib/shutdown.ts";
import { designatedRequirementOf } from "./signing-identity.ts";

const root = join(import.meta.dir, "..");
const plain = process.argv.includes("--plain");
const appName = "omp-webui.app";
const app = join(root, "dist", appName);
const out = join(root, "dist", `omp-webui-v${pkg.version}.dmg`);
const volName = "omp-webui";
/** Window content size and icon centres; scripts/dmg-background.swift draws its arrow between the icons. */
const window = { width: 660, height: 400 };
const appPos = { x: 165, y: 190 };
const appsPos = { x: 495, y: 190 };

/** The commands running now: a signal stops them before the image is detached (a mounted image cannot be). */
const running = new Set<Bun.Subprocess>();

async function stopRunning(): Promise<void> {
	await Promise.all([...running].map((proc) => killTree(proc.pid, 3000)));
}

async function exec(cmd: string[], timeout?: number): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(cmd, { cwd: root, stdout: "pipe", stderr: "pipe", timeout });
	running.add(proc);
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout as ReadableStream).text(),
		new Response(proc.stderr as ReadableStream).text(),
		proc.exited,
	]).finally(() => running.delete(proc));
	return { code, out, err };
}

/** Runs a command and returns its output; `retries` more tries, a few seconds apart, for hdiutil's "resource busy". */
async function run(cmd: string[], retries = 0): Promise<string> {
	console.log(`$ ${cmd.join(" ")}`);
	for (let attempt = 0; ; attempt++) {
		const { code, out, err } = await exec(cmd);
		if (code === 0) return out;
		if (attempt >= retries || isShuttingDown()) throw new Error(`${cmd[0]} exited with ${code}\n${out}${err}`);
		await Bun.sleep(2000 * (attempt + 1));
	}
}

/** Detach the image mounted at `mount`; `force` (a signal ended the build) does not wait for a busy volume. */
async function detach(mount: string, force = false): Promise<void> {
	for (let attempt = 0; attempt < 6; attempt++) {
		const last = force || attempt === 5;
		const r = Bun.spawnSync(["hdiutil", "detach", mount, last ? "-force" : "-quiet"]);
		if (r.exitCode === 0) return;
		await Bun.sleep(1000 * (attempt + 1));
	}
	throw new Error(`could not detach ${mount}`);
}

/**
 * Finder's layout script: window, icon view, background picture and the two icon positions. It addresses the build's
 * own disk, the one mounted at `mount`. Finder names a disk mounted outside /Volumes after its mount point's folder, not
 * after its volume name (checked on this macOS: with a volume `omp-webui` at /Volumes and ours at .../omp-webui-layout-x,
 * its disks are `omp-webui` and `omp-webui-layout-x`), so the random folder name is a name no other disk has, whatever
 * volume name a downloaded installer carries. The disk found by that name is checked to be the one at `mount` before
 * anything is set on it. (Reading the name back from the path does not work: that gives the volume name, and so
 * the installer's disk.)
 */
function layoutScript(mount: string): string {
	const { width, height } = window;
	// The window's bounds include its title bar (22 pt), the picture only the content.
	return `tell application "Finder"
	set theDisk to disk "${basename(mount)}"
	if POSIX path of (theDisk as alias) is not "${realpathSync(mount)}/" then error "Finder's disk ${basename(mount)} is not the one mounted at ${mount}"
	tell theDisk
		open
		set current view of container window to icon view
		set toolbar visible of container window to false
		set statusbar visible of container window to false
		set the bounds of container window to {200, 120, ${200 + width}, ${120 + height + 22}}
		set viewOptions to the icon view options of container window
		set arrangement of viewOptions to not arranged
		set icon size of viewOptions to 128
		set text size of viewOptions to 13
		set background picture of viewOptions to file ".background:background.tiff"
		set position of item "${appName}" of container window to {${appPos.x}, ${appPos.y}}
		set position of item "Applications" of container window to {${appsPos.x}, ${appsPos.y}}
		close
		open
		update without registering applications
		delay 2
		close
	end tell
end tell
`;
}

/**
 * Finder learns of a disk mounted outside /Volumes a moment after `hdiutil attach` returns, and until it has, every
 * reference to the disk fails with `Can't get disk "…" (-1728)` (the first layout attempt of the 0.11.12 build did, and the
 * retry three seconds later worked). So the layout waits until Finder lists the disk: asking `exists disk` changes nothing
 * on the disk and opens no window. Returns the seconds it took; gives up quietly after `limitSeconds` and lets the layout's
 * own attempts report what is wrong.
 */
async function waitForFinderDisk(mountPoint: string, limitSeconds = 60): Promise<number | null> {
	const script = `tell application "Finder" to exists disk "${basename(mountPoint)}"`;
	const started = Date.now();
	while (Date.now() - started < limitSeconds * 1000) {
		const r = await exec(["osascript", "-e", script], 30_000);
		if (isShuttingDown()) throw new Error("interrupted");
		if (r.code === 0 && r.out.trim() === "true") return (Date.now() - started) / 1000;
		await Bun.sleep(500);
	}
	return null;
}

async function layout(mountPoint: string): Promise<void> {
	const waited = await waitForFinderDisk(mountPoint);
	console.log(
		waited === null
			? `Finder does not list ${basename(mountPoint)} yet; trying the layout anyway`
			: `Finder lists ${basename(mountPoint)} (after ${waited.toFixed(1)} s)`,
	);
	let lastError = "";
	for (let attempt = 1; attempt <= 3; attempt++) {
		console.log(`$ osascript (Finder layout, attempt ${attempt})`);
		const r = await exec(["osascript", "-e", layoutScript(mountPoint)], 90_000);
		if (isShuttingDown()) throw new Error("interrupted");
		if (r.code === 0) {
			const ds = join(mountPoint, ".DS_Store");
			for (let i = 0; i < 20 && !existsSync(ds); i++) await Bun.sleep(500);
			if (existsSync(ds)) return;
			lastError = "Finder did not write .DS_Store";
		} else lastError = r.err || `osascript exited with ${r.code}`;
		console.warn(lastError);
		await Bun.sleep(3000);
	}
	throw new Error(`Finder layout failed: ${lastError}\n(--plain builds without it)`);
}

/**
 * What the .DS_Store Finder wrote says about the layout, or what is not as built: the window's size, the picture (by
 * its path on the volume, which is the same wherever the image was mounted when it was laid out) and where each icon
 * is. A layout made on the wrong disk (see `layoutScript`) would leave this one without them.
 */
function layoutProblems(ds: Buffer): string[] {
	const problems: string[] = [];
	const { width, height } = window;
	if (!ds.includes(`{${width}, ${height + 22}}`))
		problems.push(`window layout: the window is not ${width} × ${height}`);
	if (!ds.includes("/.background/background.tiff")) problems.push("window layout: no background picture is set");
	// An icon's entry: its name (UTF-16), then `Iloc`, `blob`, 16 bytes of which the first two numbers are x and y.
	for (const [name, pos] of [
		[appName, appPos],
		["Applications", appsPos],
	] as const) {
		const key = Buffer.from(name, "utf16le").swap16();
		const at = ds.indexOf(key);
		const entry = at < 0 ? -1 : at + key.length;
		const placed = entry >= 0 && ds.toString("latin1", entry, entry + 8) === "Ilocblob";
		if (!placed || ds.readUInt32BE(entry + 12) !== pos.x || ds.readUInt32BE(entry + 16) !== pos.y) {
			problems.push(`window layout: ${name} is not at ${pos.x}, ${pos.y}`);
		}
	}
	return problems;
}

/** Whether something is mounted at `path` (what is mounted is the truth, not what this script thinks it did). */
function isMounted(path: string): boolean {
	const table = Bun.spawnSync(["mount"]).stdout.toString();
	return table.includes(` on ${realpathSync(path)} (`);
}

/** Mount the finished image read-only and check what a user would find. */
async function verify(dmg: string): Promise<void> {
	const mount = mkdtempSync(join(tmpdir(), "ompw-dmg-check-"));
	const cleanup = onShutdown(async () => {
		await stopRunning();
		if (isMounted(mount)) await detach(mount, true);
		rmSync(mount, { recursive: true, force: true });
	});
	try {
		await run(["hdiutil", "attach", dmg, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, "-quiet"], 2);
		const failures: string[] = [];
		const check = (ok: boolean, what: string) => {
			if (!ok) failures.push(what);
		};
		const info = join(mount, appName, "Contents", "Info.plist");
		check(existsSync(info), `${appName} is missing`);
		if (existsSync(info)) {
			const key = async (name: string) => (await run(["plutil", "-extract", name, "raw", "-o", "-", info])).trim();
			check((await key("CFBundleShortVersionString")) === pkg.version, `app version is not ${pkg.version}`);
			check((await key("CFBundleIconFile")) === "AppIcon", "CFBundleIconFile is not AppIcon");
			check(existsSync(join(mount, appName, "Contents", "Resources", "AppIcon.icns")), "app icon is missing");
			await run(["codesign", "--verify", "--deep", "--strict", join(mount, appName)]);
			// What macOS keeps the app's permissions by: the image must carry the requirement of the app that was built, and
			// a cdhash (an ad-hoc signature, see scripts/signing-identity.ts) changes with every build.
			const required = designatedRequirementOf(join(mount, appName));
			check(
				required === designatedRequirementOf(app),
				"the app in the image has another designated requirement than the built one",
			);
			if (required.includes("cdhash")) {
				console.warn(
					`WARNING: the app is signed ad-hoc (${required}): macOS will forget its permissions at the next update. Run \`bun scripts/signing-identity.ts\` once and rebuild with \`bun run app\`.`,
				);
			}
		}
		let link = "";
		try {
			link = readlinkSync(join(mount, "Applications"));
		} catch {}
		check(link === "/Applications", "Applications is not a link to /Applications");
		check(existsSync(join(mount, ".VolumeIcon.icns")), "volume icon is missing");
		if (!plain) {
			check(existsSync(join(mount, ".background", "background.tiff")), "background picture is missing");
			const ds = join(mount, ".DS_Store");
			check(existsSync(ds), "window layout (.DS_Store) is missing");
			if (existsSync(ds)) for (const problem of layoutProblems(readFileSync(ds))) check(false, problem);
		}
		if (failures.length > 0) throw new Error(`${dmg} is not as expected:\n- ${failures.join("\n- ")}`);
	} finally {
		await cleanup();
	}
}

async function main(): Promise<void> {
	if (!existsSync(join(app, "Contents", "Info.plist"))) throw new Error(`${app} not found: run \`bun run app\` first.`);
	const stage = mkdtempSync(join(tmpdir(), "ompw-dmg-"));
	// The build's own mount point, not /Volumes/omp-webui: that is where a downloaded installer of the same name (or an
	// earlier build left mounted) lives, and it would block this one or be the disk Finder lays out. The random folder
	// name is also what Finder calls the disk (see `layoutScript`).
	const mountPoint = mkdtempSync(join(stage, "omp-webui-layout-"));
	let converting = false;
	// Also what a signal runs: stop the commands, detach the writable image (it may be mounted even if `hdiutil attach`
	// was cut off), remove the staging tree, and the half-written image.
	const cleanup = onShutdown(async () => {
		await stopRunning();
		if (isMounted(mountPoint)) await detach(mountPoint, true);
		rmSync(stage, { recursive: true, force: true });
		if (converting) rmSync(out, { force: true });
	});
	try {
		const content = join(stage, "content");
		mkdirSync(content);
		// ditto keeps the bundle's signature, links and attributes as they are.
		await run(["ditto", app, join(content, appName)]);
		await run(["ln", "-s", "/Applications", join(content, "Applications")]);
		if (!plain) {
			mkdirSync(join(content, ".background"));
			const bin = join(stage, "dmg-background");
			await run(["swiftc", "-O", join(root, "scripts", "dmg-background.swift"), "-o", bin]);
			await run([bin, join(content, ".background", "background.tiff")]);
		}

		const kb = Number((await run(["du", "-sk", content])).split(/\s/)[0]);
		const megabytes = Math.ceil((kb / 1024) * 1.2) + 20;
		const rw = join(stage, "rw.dmg");
		await run(
			[
				"hdiutil",
				"create",
				"-srcfolder",
				content,
				"-volname",
				volName,
				"-fs",
				"HFS+",
				"-format",
				"UDRW",
				"-size",
				`${megabytes}m`,
				"-quiet",
				rw,
			],
			2,
		);

		await run(
			["hdiutil", "attach", rw, "-readwrite", "-noverify", "-noautoopen", "-mountpoint", mountPoint, "-quiet"],
			2,
		);
		if (!plain) await layout(mountPoint);
		// Added only now: Finder deletes a volume icon that is already there while it lays the window out. Its
		// "has a custom icon" flag on the volume's root makes it show .VolumeIcon.icns (writing the
		// com.apple.FinderInfo attribute directly does not stick on a mounted volume; SetFile does).
		cpSync(join(app, "Contents", "Resources", "AppIcon.icns"), join(mountPoint, ".VolumeIcon.icns"));
		await run(["SetFile", "-a", "C", mountPoint]);
		await run(["sync"]);
		await detach(mountPoint);

		mkdirSync(join(root, "dist"), { recursive: true });
		rmSync(out, { force: true });
		converting = true;
		await run(["hdiutil", "convert", rw, "-format", "UDZO", "-imagekey", "zlib-level=9", "-quiet", "-o", out], 2);
		converting = false;
	} finally {
		await cleanup();
	}
	await verify(out);
	console.log(`\nBuilt ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
}

await main();
