import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";
import { MAX_LOG_BYTES, rotateLog } from "../../server/update/files.ts";
import { AppUpdater, type Conversations, relaunchCommand, type UpdaterOptions } from "../../server/update/service.ts";
import { attach, detach } from "../../server/update/steps.ts";
import { isRecord } from "../../shared/guards.ts";
import type { AppUpdateState, UpdateSnapshot } from "../../shared/update.ts";
import { type FakeReleases, startFakeReleases } from "../support/fake-releases.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { buildFixtures, disposeFixtures, type Fixtures, NEWER, type Variant } from "../support/update-fixtures.ts";

/**
 * The app's updater as the server runs it (#571), against a fake GitHub (tests/support/fake-releases.ts) and real disk
 * images, signatures and a real helper: what a check keeps and when it asks again, every reason an install does not start,
 * every refusal after the download, and the swap itself — the app that quits, the helper that renames and starts the new
 * one, and what it does when the new one does not start, was changed on the way, or cannot be put in place.
 * The "app" that is asked to quit is a `sleep` process, and the command that starts the app is a script that records
 * itself, so that nothing launches a real application.
 */

const mac = process.platform === "darwin" && Bun.which("hdiutil") !== null && Bun.which("codesign") !== null;
const root = mkdtempSync(join(tmpdir(), "ompw-updater-"));
let fixtures: Fixtures;
let fake: FakeReleases;
const VARIANTS: Variant[] = [
	"good",
	"quarantined",
	"tampered",
	"otherId",
	"wrongVersion",
	"otherSigner",
	"adHoc",
	"noApp",
	"garbage",
];

beforeAll(async () => {
	fake = await startFakeReleases();
	if (mac) fixtures = await buildFixtures(join(root, "fx"), VARIANTS);
}, 180_000);
afterAll(async () => {
	await fake.stop();
	if (mac) disposeFixtures(fixtures);
	rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the world an updater runs in

interface World {
	data: string;
	installDir: string;
	bundle: string;
	/** The `sleep` that stands for the running app. */
	app: Bun.Subprocess;
	states: AppUpdateState[];
	/** What each call of `signalParent` saw: whether the handover record was there already. */
	signals: { recorded: boolean }[];
	/** The helper's pid, known once the updater has started it and asked the app to quit (never, if the install ends before). */
	helper: Promise<number>;
	/** Each start of the app by the helper: the version that was installed at the time. */
	launches(): string[];
	setLaunch(mode: "ack" | "silent" | "fail" | "loseBackup"): void;
	/** Move this world's clock a minute on: a second look is not a second request within ten seconds. */
	skip(): void;
	updater: AppUpdater;
}

let counter = 0;
const worlds: World[] = [];

interface WorldOptions {
	/** Another running app than the signed one (an ad-hoc one, none). */
	running?: string | null;
	conversations?: Conversations;
	/** What the stand-in for the new app does: say it is up (ack), nothing (silent), fail, or never start and take the backup with it. */
	launch?: "ack" | "silent" | "fail" | "loseBackup";
	quitSecs?: number;
	startSecs?: number;
	/** What happens when the updater asks the app to quit: by default the app quits. */
	onSignal?: (w: World) => void;
	api?: string;
	options?: Partial<UpdaterOptions>;
}

const none: Conversations = { working: 0, asking: 0, paused: 0, waiting: 0 };

function world(o: WorldOptions = {}): World {
	const dir = mkdtempSync(join(root, `world-${++counter}-`));
	const data = join(dir, "data");
	const installDir = join(dir, "Applications");
	mkdirSync(installDir, { recursive: true });
	const running = o.running === undefined ? fixtures?.running : o.running;
	const bundle = join(installDir, "omp-webui.app");
	if (running) Bun.spawnSync(["ditto", running, bundle]);
	const app = Bun.spawn(["sleep", "3600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	const states: AppUpdateState[] = [];
	const signals: World["signals"] = [];
	const handedOver = Promise.withResolvers<number>();
	const update = join(data, "update");
	const launchLog = join(dir, "launches.log");
	const mode = join(dir, "launch-mode");
	writeFileSync(mode, o.launch ?? "ack");
	const stub = join(dir, "launch.sh");
	writeFileSync(
		stub,
		`#!/bin/sh
/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "${bundle}/Contents/Info.plist" >> "${launchLog}" 2>/dev/null
echo >> "${launchLog}"
case "$(cat "${mode}")" in
ack)
	id=$(sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p' "${update}/handover.json" 2>/dev/null)
	[ -n "$id" ] && printf '{"id":"%s"}' "$id" > "${update}/ack.json"
	;;
fail) exit 1 ;;
loseBackup) rm -rf "${bundle}.previous" ;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
	let offset = 0;
	const w: World = {
		data,
		installDir,
		bundle,
		app,
		states,
		signals,
		helper: handedOver.promise,
		launches: () => (existsSync(launchLog) ? readFileSync(launchLog, "utf8").split("\n").filter(Boolean) : []),
		setLaunch: (m) => writeFileSync(mode, m),
		skip: () => {
			offset += 60_000;
		},
		updater: undefined as unknown as AppUpdater,
	};
	w.updater = new AppUpdater({
		dataDir: data,
		installed: pkg.version,
		bundle: o.running === null ? null : bundle,
		parentPid: app.pid,
		api: o.api ?? fake.url,
		automatic: false,
		autoChecks: () => true,
		conversations: () => o.conversations ?? none,
		broadcast: (s) => states.push(s),
		now: () => Date.now() + offset,
		quitSecs: o.quitSecs ?? 30,
		startSecs: o.startSecs ?? 20,
		relaunch: [stub],
		signalParent: (pid) => {
			signals.push({ recorded: existsSync(join(update, "handover.json")) });
			handedOver.resolve(helperPidOf(update));
			if (o.onSignal) o.onSignal(w);
			else process.kill(pid, "SIGKILL");
		},
		...o.options,
	});
	worlds.push(w);
	return w;
}

afterEach(() => {
	for (const w of worlds.splice(0)) {
		w.app.kill("SIGKILL");
		w.updater.stop();
		try {
			const record: unknown = JSON.parse(readFileSync(join(w.data, "update", "handover.json"), "utf8"));
			if (isRecord(record) && typeof record.helperPid === "number") process.kill(record.helperPid, "SIGKILL");
		} catch {
			// no helper, or it ended
		}
		chmodSync(w.installDir, 0o755);
	}
	fake.publish({ tag: "v0.0.0" });
	fake.requests.length = 0;
});

/** The helper's pid from the handover record, which is written before the app is asked to quit. */
function helperPidOf(update: string): number {
	const record: unknown = JSON.parse(readFileSync(join(update, "handover.json"), "utf8"));
	if (!isRecord(record) || typeof record.helperPid !== "number") throw new Error("the handover record has no helper");
	return record.helperPid;
}

/**
 * Wait until the helper has ended: it swaps or refuses, starts an app and writes its verdict, all of it before it exits, and
 * how long that takes depends on the machine (it looks at the staged copy with `codesign` several times). What is awaited is
 * the process itself, not a number of seconds; the helper bounds itself (`quitSecs`, `startSecs`) and the test's timeout
 * bounds a helper that hangs.
 */
async function helperEnded(w: World): Promise<void> {
	const pid = await w.helper;
	await pollUntil(() => !processExists(pid), "the helper to end", Number.POSITIVE_INFINITY);
}

const state = (w: World) => w.updater.state();
const latest = (w: World) => w.states.at(-1) ?? state(w);

async function until(
	w: World,
	what: string,
	test: (s: AppUpdateState) => boolean,
	ms = 60_000,
): Promise<AppUpdateState> {
	await pollUntil(() => test(state(w)), what, ms);
	return state(w);
}

/** Publish `variant`'s installer as the latest release, look for it, and start installing it. */
async function install(w: World, variant: Variant, anyway = true) {
	const installer = fixtures.installers[variant];
	if (!installer) throw new Error(`no ${variant} installer`);
	fake.publish({ tag: installer.tag, dmg: installer.dmg });
	w.skip();
	await w.updater.check();
	return w.updater.install(installer.tag, anyway);
}

// ------------------------------------------------------------------ looking

test("a check keeps the release it found, says it is newer, and a restart knows it before it asks again", async () => {
	const w = world({ running: null });
	fake.publish({ tag: "v9.0.0" });
	expect(state(w).latest).toBeNull();
	await w.updater.check();
	expect(state(w)).toMatchObject({
		newer: true,
		failure: null,
		checking: false,
		latest: { tag: "v9.0.0", version: "9.0.0" },
	});
	expect(state(w).checkedAt).toBeNumber();
	expect(state(w).latest?.notes.en).toContain("updates itself");
	expect(state(w).latest?.notes.zh).toContain("自行更新");
	expect(fake.count("/repos/9s94ttyfct-bit/omp-webui/releases/latest")).toBe(1);

	// A new server on the same data dir: the release is known before anything is asked, and what is asked is conditional.
	const again = new AppUpdater({ ...optionsOf(w), broadcast: () => {} });
	expect(again.state().latest?.tag).toBe("v9.0.0");
	expect(again.state().newer).toBe(true);
	await again.check();
	const asked = fake.requests.filter((r) => r.path.endsWith("/releases/latest"));
	expect(asked).toHaveLength(2);
	expect(asked[0]?.headers["if-none-match"]).toBeUndefined();
	expect(asked[1]?.headers["if-none-match"]).toMatch(/^W\/"fake-/);
	// The 304 changed nothing it knew.
	expect(again.state()).toMatchObject({ newer: true, failure: null, latest: { tag: "v9.0.0" } });
});

/** The options a world's updater was made with, for a second updater on the same data dir. */
function optionsOf(w: World): UpdaterOptions {
	return {
		dataDir: w.data,
		installed: pkg.version,
		bundle: null,
		parentPid: null,
		api: fake.url,
		automatic: false,
		autoChecks: () => true,
		conversations: () => none,
		broadcast: () => {},
	};
}

test("a release that is not newer is shown as the latest but is not an update: never a downgrade", async () => {
	const w = world({ running: null });
	for (const tag of ["v0.11.9", "v0.11.8", "v0.1.0"]) {
		fake.publish({ tag });
		rmSync(join(w.data, "update", "check.json"), { force: true });
		await sleepPastGap(w);
		expect(state(w).newer, tag).toBe(false);
	}
	expect(state(w).latest?.tag).toBe("v0.1.0");
});

/** A second look is not a second request within ten seconds; the tests that look twice move their clock instead. */
async function sleepPastGap(w: World) {
	const clock = { at: Date.now() + 60_000 };
	const next = new AppUpdater({ ...optionsOf(w), now: () => (clock.at += 60_000), broadcast: (s) => w.states.push(s) });
	await next.check();
	Object.assign(w, { updater: next });
}

test("nothing reachable (404) is a quiet state: the release it knew is dropped, and it is asked again only on the next turn", async () => {
	const w = world({ running: null });
	fake.publish({ tag: "v9.0.0" });
	await w.updater.check();
	expect(state(w).latest).not.toBeNull();
	const gone = new AppUpdater({ ...optionsOf(w), now: () => Date.now() + 60_000, broadcast: () => {} });
	fake.answer(404);
	await gone.check();
	expect(gone.state()).toMatchObject({ latest: null, newer: false, failure: { code: "noRelease" }, checking: false });
	// A 404 is an answer: the look is dated (the card says when, next to "No release is reachable").
	expect(gone.state().checkedAt).toBeNumber();
	expect(existsSync(join(w.data, "update", "check.json"))).toBe(false);
	// No retry on its own: the one request is all there was.
	expect(fake.requests.filter((r) => r.path.endsWith("/releases/latest"))).toHaveLength(2);
});

test("a spent rate limit stops every request until it resets, however often it is asked", async () => {
	const w = world({ running: null });
	let now = 1_000_000_000_000;
	const resetsAt = now + 30 * 60_000;
	const limited = new AppUpdater({ ...optionsOf(w), now: () => now, broadcast: () => {} });
	fake.answer(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetsAt / 1000) });
	await limited.check();
	expect(limited.state().failure).toEqual({ code: "rateLimited", retryAt: resetsAt });
	for (let i = 0; i < 3; i++) {
		now += 60_000;
		await limited.check();
	}
	expect(fake.requests.filter((r) => r.path.endsWith("/releases/latest"))).toHaveLength(1);
	expect(limited.state().failure).toEqual({ code: "rateLimited", retryAt: resetsAt });
	// After the reset it asks again, and what it finds clears the failure.
	fake.publish({ tag: "v9.0.0" });
	now = resetsAt + 1000;
	await limited.check();
	expect(fake.requests.filter((r) => r.path.endsWith("/releases/latest"))).toHaveLength(2);
	expect(limited.state()).toMatchObject({ failure: null, newer: true });
});

test("a look that cannot reach GitHub says so and keeps what it knew; a double click is one request", async () => {
	const w = world({ running: null });
	fake.publish({ tag: "v9.0.0" });
	let now = Date.now();
	const u = new AppUpdater({ ...optionsOf(w), now: () => now, broadcast: () => {} });
	await Promise.all([u.check(), u.check(), u.check()]);
	expect(fake.requests.filter((r) => r.path.endsWith("/releases/latest"))).toHaveLength(1);
	await u.check();
	expect(fake.requests.filter((r) => r.path.endsWith("/releases/latest"))).toHaveLength(1);
	now += 60_000;
	const offline = new AppUpdater({ ...optionsOf(w), api: "http://127.0.0.1:1", now: () => now, broadcast: () => {} });
	await offline.check();
	expect(offline.state()).toMatchObject({ failure: { code: "offline" }, latest: { tag: "v9.0.0" }, newer: true });
});

test("it looks soon after it starts and then on its timer, while the user wants it, and not when they do not", async () => {
	const w = world({ running: null });
	fake.publish({ tag: "v9.0.0" });
	let wanted = false;
	const timed = new AppUpdater({
		...optionsOf(w),
		automatic: true,
		autoChecks: () => wanted,
		firstCheckMs: 20,
		intervalMs: 80,
		now: (() => {
			let t = Date.now();
			return () => (t += 20_000);
		})(),
	});
	timed.start();
	const asked = () => fake.requests.filter((r) => r.path.endsWith("/releases/latest")).length;
	await Bun.sleep(300);
	expect(asked()).toBe(0);
	wanted = true;
	await pollUntil(() => asked() >= 2, "the first look and one on the timer");
	timed.stop();
	const after = asked();
	await Bun.sleep(250);
	expect(asked()).toBe(after);
	// Not automatic at all (`OMP_WEBUI_UPDATE_CHECK=off`): no timer is ever set.
	const off = new AppUpdater({
		...optionsOf(w),
		automatic: false,
		firstCheckMs: 0,
		intervalMs: 20,
		autoChecks: () => true,
	});
	off.start();
	await Bun.sleep(150);
	expect(asked()).toBe(after);
});

// ------------------------------------------------------------------ whether and why not

test.skipIf(!mac)("this copy can replace itself only as a signed app bundle in a folder it can write", async () => {
	expect(state(world({ running: null })).install).toEqual({ allowed: false, reason: "notApp" });
	const signed = world();
	await signed.updater.install("v0.0.0", true);
	expect(state(signed).install).toEqual({ allowed: true });
	expect(
		state(world({ options: { bundle: "/private/var/folders/xx/AppTranslocation/ABC/d/omp-webui.app" } })).install,
	).toEqual({
		allowed: false,
		reason: "translocated",
	});
	const locked = world();
	chmodSync(locked.installDir, 0o555);
	expect(state(locked).install).toEqual({ allowed: false, reason: "notWritable" });
	const adHoc = world({ running: fixtures.runningAdHoc });
	await adHoc.updater.install("v0.0.0", true);
	expect(state(adHoc).install).toEqual({ allowed: false, reason: "adHoc" });
	// Without a shell to ask to quit there is nobody to hand the swap to.
	const orphan = world({ options: { parentPid: null } });
	expect(state(orphan).install).toEqual({ allowed: false, reason: "notApp" });
});

test.skipIf(!mac)(
	"an install is refused, and nothing starts, while it is blocked, busy, pointless or would stop conversations",
	async () => {
		const none_ = world({ running: null });
		fake.publish({ tag: "v9.0.0", dmg: fixtures.installers.good?.dmg });
		await none_.updater.check();
		expect(await none_.updater.install("v9.0.0", true)).toMatchObject({
			code: "blocked",
			params: { reason: "notApp" },
		});

		const w = world();
		// No release known yet, then one that is not the one shown, then one that is older.
		expect(await w.updater.install("v9.0.0", true)).toMatchObject({ code: "nothingToInstall" });
		fake.publish({ tag: "v9.0.0", dmg: fixtures.installers.good?.dmg });
		await w.updater.check();
		expect(await w.updater.install("v9.0.1", true)).toMatchObject({ code: "nothingToInstall" });
		// A release with no installer attached yet has nothing to install either.
		const noInstaller = world();
		fake.publish({ tag: "v9.0.0" });
		await noInstaller.updater.check();
		expect(state(noInstaller).latest?.asset).toBeNull();
		expect(await noInstaller.updater.install("v9.0.0", true)).toMatchObject({ code: "nothingToInstall" });

		const busy = world({ conversations: { working: 2, asking: 1, paused: 1, waiting: 1 } });
		fake.publish({ tag: "v9.0.0", dmg: fixtures.installers.good?.dmg });
		await busy.updater.check();
		const asked = await busy.updater.install("v9.0.0", false);
		expect(asked).toMatchObject({ code: "replying", params: { working: 2, asking: 1, paused: 1, waiting: 1 } });
		expect(state(busy).job).toBeNull();
		expect(busy.signals).toHaveLength(0);
		// Only paused and waiting conversations (they stay in the background) are no reason to ask.
		const staying = world({ conversations: { working: 0, asking: 0, paused: 3, waiting: 1 } });
		await staying.updater.check();
		expect("state" in (await staying.updater.install("v9.0.0", false))).toBe(true);
	},
	120_000,
);

test.skipIf(!mac)("a second install while one is under way is refused as busy", async () => {
	const w = world({ onSignal: () => {} });
	fake.throttle(40_000, 60);
	try {
		const first = await install(w, "good");
		expect("state" in first).toBe(true);
		expect(await w.updater.install("v9.0.0", true)).toMatchObject({ code: "busy" });
	} finally {
		fake.throttle(1 << 30, 0);
		w.updater.cancelInstall();
	}
});

// ------------------------------------------------------------------ the install and its refusals

const REFUSALS: [Variant, string][] = [
	["tampered", "signature"],
	["otherId", "bundleId"],
	["wrongVersion", "version"],
	["otherSigner", "requirement"],
	["adHoc", "requirement"],
	["noApp", "noApp"],
	["garbage", "mount"],
];

for (const [variant, code] of REFUSALS) {
	test.skipIf(!mac)(
		`an installer that is ${variant} is refused as ${code}: nothing is staged, handed over or left behind`,
		async () => {
			const w = world();
			const answer = await install(w, variant);
			expect("state" in answer).toBe(true);
			const failed = await until(w, "the refusal", (s) => s.failed !== null);
			expect(failed.failed).toMatchObject({ code, tag: fixtures.installers[variant]?.tag });
			expect(failed.job).toBeNull();
			expect(w.signals).toHaveLength(0);
			expect(existsSync(join(w.data, "update", "handover.json"))).toBe(false);
			// The old app is as it was, and nothing sits next to it: no staged copy, no backup.
			expect(readdirSync(w.installDir)).toEqual(["omp-webui.app"]);
			// Nor in the update folder: the download is removed, and nothing is left mounted.
			expect(
				readdirSync(join(w.data, "update")).filter(
					(f) => f.endsWith(".dmg") || f.endsWith(".part") || f.startsWith("mount-"),
				),
			).toEqual([]);
			expect(Bun.spawnSync(["mount"]).stdout.toString()).not.toContain(w.data);
			expect(w.launches()).toEqual([]);
		},
		90_000,
	);
}

test.skipIf(!mac)(
	"an installer that is not the size or hash the release lists is refused before it is opened",
	async () => {
		const w = world();
		const good = fixtures.installers.good;
		fake.publish({ tag: NEWER.replace(/^/, "v"), dmg: good?.dmg, digest: `sha256:${"0".repeat(64)}` });
		await w.updater.check();
		await w.updater.install(`v${NEWER}`, true);
		expect((await until(w, "the digest refusal", (s) => s.failed !== null)).failed).toMatchObject({ code: "digest" });
		const size = world();
		fake.publish({ tag: `v${NEWER}`, dmg: good?.dmg, size: 1234 });
		await size.updater.check();
		await size.updater.install(`v${NEWER}`, true);
		expect((await until(size, "the size refusal", (s) => s.failed !== null)).failed).toMatchObject({ code: "size" });
		for (const x of [w, size]) {
			expect(w.launches()).toEqual([]);
			expect(readdirSync(x.installDir)).toEqual(["omp-webui.app"]);
			expect(x.signals).toHaveLength(0);
		}
	},
	90_000,
);

test.skipIf(!mac)(
	"a failed install can be tried again, and says nothing of the failure once it works",
	async () => {
		const w = world();
		await install(w, "tampered");
		await until(w, "the refusal", (s) => s.failed !== null);
		const good = fixtures.installers.good;
		fake.publish({ tag: `v${NEWER}`, dmg: good?.dmg });
		w.skip();
		await w.updater.check();
		await w.updater.install(`v${NEWER}`, true);
		expect(state(w).failed).toBeNull();
		await until(w, "the handover", (s) => s.job?.phase === "handover");
	},
	90_000,
);

test.skipIf(!mac)(
	"a cancelled download stops, leaves nothing and is not a failure",
	async () => {
		const w = world({ onSignal: () => {} });
		fake.throttle(4_000, 50);
		try {
			await install(w, "good");
			await until(w, "bytes arriving", (s) => (s.job?.received ?? 0) > 0);
			w.updater.cancelInstall();
			await until(w, "the end of the install", (s) => s.job === null);
			expect(state(w).failed).toBeNull();
			expect(readdirSync(w.installDir)).toEqual(["omp-webui.app"]);
			expect(readdirSync(join(w.data, "update")).filter((f) => f.endsWith(".part") || f.endsWith(".dmg"))).toEqual([]);
			expect(w.signals).toHaveLength(0);
		} finally {
			fake.throttle(1 << 30, 0);
		}
	},
	60_000,
);

// ------------------------------------------------------------------ the swap

/** The version the app at `bundle` says it is. */
const versionOf = (bundle: string) =>
	Bun.spawnSync([
		"plutil",
		"-extract",
		"CFBundleShortVersionString",
		"raw",
		"-o",
		"-",
		join(bundle, "Contents", "Info.plist"),
	])
		.stdout.toString()
		.trim();
const quarantined = (path: string) => Bun.spawnSync(["xattr", "-p", "com.apple.quarantine", path]).exitCode === 0;
const result = (w: World) => JSON.parse(readFileSync(join(w.data, "update", "result.json"), "utf8"));

test.skipIf(!mac)(
	"an update is installed: staged and checked, the app asked to quit after the handover is recorded, swapped in by rename, started, and the backup removed",
	async () => {
		const w = world();
		const phases: string[] = [];
		const answer = await install(w, "quarantined");
		expect("state" in answer && answer.state.job?.phase).toBe("downloading");
		// The app that is replaced runs until the helper is told it has quit: nothing is swapped under a running app.
		const handover = await until(w, "the handover", (s) => s.job?.phase === "handover");
		for (const s of w.states) if (s.job && phases.at(-1) !== s.job.phase) phases.push(s.job.phase);
		expect(phases).toEqual(["downloading", "verifying", "staging", "handover"]);
		expect(handover.job?.received).toBe(handover.job?.total);
		expect(w.signals).toEqual([{ recorded: true }]);
		// It quit (the stand-in was killed by the signal), and the helper swaps and starts the new app.
		await helperEnded(w);
		expect(w.launches()).toEqual([NEWER]);
		expect(existsSync(join(w.data, "update", "handover.json"))).toBe(false);
		expect(readdirSync(w.installDir)).toEqual(["omp-webui.app"]);
		expect(versionOf(w.bundle)).toBe(NEWER);
		expect(Bun.spawnSync(["codesign", "--verify", "--deep", "--strict", w.bundle]).exitCode).toBe(0);
		// The quarantine mark the image's app carried is gone: the first start asks nobody.
		expect(quarantined(w.bundle)).toBe(false);
		expect(quarantined(join(w.bundle, "Contents", "MacOS", "omp-webui"))).toBe(false);
		// Nothing of it is left: no installer, no mount, and no outcome written by the helper (the new server says it is up).
		expect(readdirSync(join(w.data, "update")).filter((f) => f.endsWith(".dmg") || f.startsWith("mount-"))).toEqual([]);
		expect(existsSync(join(w.data, "update", "result.json"))).toBe(false);
		expect(readFileSync(join(w.data, "update", "helper.log"), "utf8")).toContain("the new app is up");
	},
	120_000,
);

test.skipIf(!mac)(
	"a new app that does not start is taken out and the old one put back and started: the update says so",
	async () => {
		const w = world({ launch: "silent", startSecs: 2 });
		await install(w, "good");
		await until(w, "the handover", (s) => s.job?.phase === "handover");
		// The new app is started once and never says it is up; then the old one is started in its place.
		await helperEnded(w);
		expect(result(w)).toMatchObject({ ok: false, from: pkg.version, to: NEWER, problem: "didNotStart" });
		expect(w.launches()).toHaveLength(2);
		expect(w.launches()).toEqual([NEWER, pkg.version]);
		expect(versionOf(w.bundle)).toBe(pkg.version);
		expect(readdirSync(w.installDir)).toEqual(["omp-webui.app"]);
		expect(existsSync(join(w.data, "update", "handover.json"))).toBe(false);
		// The next server finds it and shows it.
		const next = new AppUpdater({ ...optionsOf(w), bundle: w.bundle, broadcast: () => {} });
		await pollUntil(() => next.state().outcome !== null, "the outcome being read");
		expect(next.state().outcome).toMatchObject({ ok: false, to: NEWER, problem: "didNotStart" });
		next.dismiss();
		expect(next.state().outcome).toBeNull();
		expect(existsSync(join(w.data, "update", "result.json"))).toBe(false);
	},
	120_000,
);

test.skipIf(!mac)(
	"an app that cannot be started at all rolls back the same way",
	async () => {
		const w = world({ launch: "fail" });
		await install(w, "good");
		await until(w, "the handover", (s) => s.job?.phase === "handover");
		await helperEnded(w);
		expect(result(w)).toMatchObject({ ok: false, problem: "swap" });
		expect(existsSync(join(w.data, "update", "handover.json"))).toBe(false);
		expect(versionOf(w.bundle)).toBe(pkg.version);
		expect(readdirSync(w.installDir)).toEqual(["omp-webui.app"]);
	},
	120_000,
);

test.skipIf(!mac)(
	"an app that does not quit is not swapped: the helper gives up, removes the staged copy and says so",
	async () => {
		const w = world({ quitSecs: 1, onSignal: () => {} });
		await install(w, "good");
		await until(w, "the handover", (s) => s.job?.phase === "handover");
		await helperEnded(w);
		expect(result(w)).toMatchObject({ ok: false, problem: "quitTimeout" });
		expect(existsSync(join(w.data, "update", "handover.json"))).toBe(false);
		expect(versionOf(w.bundle)).toBe(pkg.version);
		expect(readdirSync(w.installDir)).toEqual(["omp-webui.app"]);
		expect(w.launches()).toEqual([]);
		expect(processExists(w.app.pid)).toBe(true);
	},
	120_000,
);

test.skipIf(!mac)(
	"a staged copy that was changed after it was checked is caught by the helper's own look, and the old app starts again",
	async () => {
		const w = world({
			onSignal: (x) => {
				writeFileSync(join(`${x.bundle}.updating`, "Contents", "Resources.txt"), "changed after the server checked it");
				process.kill(x.app.pid, "SIGKILL");
			},
		});
		await install(w, "good");
		await helperEnded(w);
		expect(result(w)).toMatchObject({ ok: false, problem: "verify" });
		expect(w.launches()).toHaveLength(1);
		expect(w.launches()).toEqual([pkg.version]);
		expect(versionOf(w.bundle)).toBe(pkg.version);
		expect(readdirSync(w.installDir)).toEqual(["omp-webui.app"]);
	},
	120_000,
);

test.skipIf(!mac)(
	"a staged copy signed by another certificate is refused by the helper too, whatever the server believed",
	async () => {
		const w = world({
			onSignal: (x) => {
				const staged = `${x.bundle}.updating`;
				rmSync(staged, { recursive: true, force: true });
				Bun.spawnSync(["ditto", fixtures.installers.otherSigner?.app as string, staged]);
				process.kill(x.app.pid, "SIGKILL");
			},
		});
		await install(w, "good");
		await helperEnded(w);
		expect(result(w)).toMatchObject({ ok: false, problem: "verify" });
		expect(existsSync(join(w.data, "update", "handover.json"))).toBe(false);
		expect(versionOf(w.bundle)).toBe(pkg.version);
		expect(readdirSync(w.installDir)).toEqual(["omp-webui.app"]);
	},
	120_000,
);

test.skipIf(!mac)(
	"a folder that stopped being writable between the stage and the swap leaves the old app in place and running again",
	async () => {
		const w = world({
			onSignal: (x) => {
				chmodSync(x.installDir, 0o555);
				process.kill(x.app.pid, "SIGKILL");
			},
		});
		await install(w, "good");
		await helperEnded(w);
		expect(result(w)).toMatchObject({ ok: false, problem: "swap" });
		expect(w.launches()).toHaveLength(1);
		chmodSync(w.installDir, 0o755);
		expect(versionOf(w.bundle)).toBe(pkg.version);
	},
	120_000,
);

// ------------------------------------------------------------------ what the new server does

test.skipIf(!mac)(
	"the server that starts as the installed version says it is up, and keeps the success to show",
	async () => {
		const w = world({ running: null });
		const update = join(w.data, "update");
		writeFileSync(
			join(update, "handover.json"),
			JSON.stringify({
				id: "abc",
				from: "0.11.9",
				to: pkg.version,
				installed: w.bundle,
				staged: `${w.bundle}.updating`,
				backup: `${w.bundle}.previous`,
				helperPid: w.app.pid,
			}),
		);
		mkdirSync(w.bundle, { recursive: true });
		const up = new AppUpdater({ ...optionsOf(w), bundle: w.bundle, installed: pkg.version });
		await pollUntil(() => up.state().outcome !== null, "the success being noted");
		expect(JSON.parse(readFileSync(join(update, "ack.json"), "utf8"))).toMatchObject({
			id: "abc",
			version: pkg.version,
		});
		expect(up.state().outcome).toMatchObject({ ok: true, from: "0.11.9", to: pkg.version });
		expect(JSON.parse(readFileSync(join(update, "result.json"), "utf8"))).toMatchObject({ ok: true });
		// A server that is not what the helper installed (the old app, after a rollback) does not say so.
		rmSync(join(update, "ack.json"));
		rmSync(join(update, "result.json"));
		const old = new AppUpdater({ ...optionsOf(w), bundle: w.bundle, installed: "0.0.1" });
		await old.check().catch(() => {});
		expect(existsSync(join(update, "ack.json"))).toBe(false);
	},
);

test("what the relaunched app is started with: where its data and omp are, never its token or its parent", () => {
	const command = relaunchCommand("/Applications/omp-webui.app", {
		OMP_WEBUI_DATA_DIR: "/tmp/data",
		OMP_WEBUI_PORT: "7999",
		OMP_WEBUI_APP_UPDATE_API: "http://127.0.0.1:1",
		HOME: "/tmp/home",
		PI_CODING_AGENT_DIR: "/tmp/agent",
		OMP_BIN: "/tmp/omp",
		OMP_WEBUI_TOKEN: "secret",
		OMP_WEBUI_PARENT_PID: "123",
		OMP_WEBUI_DIST: "/x",
		OMP_WEBUI_AUTO_PORT: "1",
		OMP_WEBUI_LOGIN_SHELL: "/bin/zsh",
		OMP_WEBUI_APP_BUNDLE: "/Applications/omp-webui.app",
		PATH: "/usr/bin",
		SHELL: "/bin/zsh",
		SOMETHING: "else",
	});
	expect(command[0]).toBe("/usr/bin/open");
	expect(command.at(-1)).toBe("/Applications/omp-webui.app");
	const given = command.slice(1, -1);
	expect(given.filter((_, i) => i % 2 === 0).every((word) => word === "--env")).toBe(true);
	expect(given.filter((_, i) => i % 2 === 1).sort()).toEqual(
		[
			"HOME=/tmp/home",
			"OMP_BIN=/tmp/omp",
			"OMP_WEBUI_APP_UPDATE_API=http://127.0.0.1:1",
			"OMP_WEBUI_DATA_DIR=/tmp/data",
			"OMP_WEBUI_PORT=7999",
			"PI_CODING_AGENT_DIR=/tmp/agent",
		].sort(),
	);
});

// ------------------------------------------------------------------ the routes

test("the routes answer with the state, refuse the wrong method and a request without a release to install", async () => {
	const w = world({ running: null });
	const ask = (path: string, method = "GET", body?: unknown) =>
		w.updater.handle(
			new Request(`http://127.0.0.1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
			new URL(`http://127.0.0.1${path}`),
		);
	const got = await ask("/api/update");
	expect(got.status).toBe(200);
	// The route's answer is the shape it documents: the cast names it.
	const snapshot = (await got.json()) as UpdateSnapshot;
	expect(snapshot.state.installed).toBe(pkg.version);
	expect((await ask("/api/update", "POST")).status).toBe(405);
	for (const path of ["/api/update/check", "/api/update/install", "/api/update/cancel", "/api/update/dismiss"]) {
		expect((await ask(path)).status, path).toBe(405);
	}
	expect((await ask("/api/update/install", "POST", {})).status).toBe(400);
	const refused = await ask("/api/update/install", "POST", { tag: "v9.0.0" });
	expect(refused.status).toBe(409);
	expect(await refused.json()).toMatchObject({ code: "blocked", params: { reason: "notApp" } });
	fake.publish({ tag: "v9.0.0" });
	const checked = (await (await ask("/api/update/check", "POST")).json()) as UpdateSnapshot;
	expect(checked.state.latest?.tag).toBe("v9.0.0");
	expect((await ask("/api/update/nope", "POST")).status).toBe(404);
	expect(latest(w).rev).toBeGreaterThan(0);
});

test("every state it says is newer than the one before: pages keep the newest", async () => {
	const w = world({ running: null });
	fake.publish({ tag: "v9.0.0" });
	await w.updater.check();
	w.updater.dismiss();
	const revs = w.states.map((s) => s.rev);
	expect(revs.length).toBeGreaterThan(2);
	expect(revs).toEqual([...revs].sort((a, b) => a - b));
	expect(new Set(revs).size).toBe(revs.length);
	expect(new Set(w.states.map((s) => s.boot)).size).toBe(1);
});

// ------------------------------------------------------------------ what an interrupted install leaves

const isMounted = (path: string) =>
	Bun.spawnSync(["mount"])
		.stdout.toString()
		.includes(` on ${Bun.spawnSync(["realpath", path]).stdout.toString().trim()} (`);

test.skipIf(!mac)(
	"an install cut short leaves an image mounted, a download and a half-copied app: the next server detaches and removes them",
	async () => {
		const w = world();
		const update = join(w.data, "update");
		mkdirSync(update, { recursive: true });
		// What `hdiutil attach` and `ditto` leave when the app quits in the middle of an install: they run on, detached.
		const mount = join(update, "mount-ABC123");
		mkdirSync(mount);
		await attach(fixtures.installers.good?.dmg as string, mount);
		expect(isMounted(mount)).toBe(true);
		writeFileSync(join(update, "v9.0.0.dmg"), "downloaded");
		writeFileSync(join(update, "v9.0.1.dmg.part"), "half of it");
		writeFileSync(join(update, "check.json"), "{}");
		mkdirSync(`${w.bundle}.updating`);
		writeFileSync(join(`${w.bundle}.updating`, "half"), "x");
		try {
			// The next server on this data dir; any request waits for its start-up to end.
			const next = new AppUpdater({ ...optionsOf(w), bundle: w.bundle, parentPid: 1 });
			await next.handle(new Request("http://127.0.0.1/api/update"), new URL("http://127.0.0.1/api/update"));
			expect(isMounted(mount)).toBe(false);
			expect(existsSync(mount)).toBe(false);
			expect(
				readdirSync(update).filter((f) => f.endsWith(".dmg") || f.endsWith(".part") || f.startsWith("mount-")),
			).toEqual([]);
			expect(existsSync(`${w.bundle}.updating`)).toBe(false);
			// What is not a leftover stays: the app that is installed, and the cached answer.
			expect(existsSync(join(w.bundle, "Contents", "Info.plist"))).toBe(true);
			expect(existsSync(join(update, "check.json"))).toBe(true);
		} finally {
			await detach(mount);
		}
	},
	60_000,
);

test.skipIf(!mac)("the staged copy of an update whose helper is alive is the helper's: it is not swept", async () => {
	const w = world();
	const update = join(w.data, "update");
	mkdirSync(update, { recursive: true });
	const staged = `${w.bundle}.updating`;
	mkdirSync(staged);
	writeFileSync(join(staged, "ready"), "x");
	// The helper is `w.app`, a process that runs: this update is handed over and waiting for its app to quit.
	const server = () => new AppUpdater({ ...optionsOf(w), bundle: w.bundle, parentPid: 1 });
	writeFileSync(
		join(update, "handover.json"),
		JSON.stringify({
			id: "live",
			from: pkg.version,
			to: NEWER,
			installed: w.bundle,
			staged,
			backup: `${w.bundle}.previous`,
			helperPid: w.app.pid,
		}),
	);
	await server().handle(new Request("http://127.0.0.1/api/update"), new URL("http://127.0.0.1/api/update"));
	expect(existsSync(join(staged, "ready"))).toBe(true);
	expect(existsSync(join(update, "handover.json"))).toBe(true);
	// The same record with a helper that is gone is a leftover, and goes with its staged copy.
	w.app.kill("SIGKILL");
	await w.app.exited;
	await server().handle(new Request("http://127.0.0.1/api/update"), new URL("http://127.0.0.1/api/update"));
	expect(existsSync(staged)).toBe(false);
	expect(existsSync(join(update, "handover.json"))).toBe(false);
});

test("a 404 on the very first look is dated: the card says when it looked, not 'Not checked yet' beside 'No release is reachable'", async () => {
	const w = world({ running: null });
	fake.answer(404);
	expect(state(w).checkedAt).toBeNull();
	await w.updater.check();
	expect(state(w)).toMatchObject({ latest: null, failure: { code: "noRelease" } });
	expect(state(w).checkedAt).toBeNumber();
});

// ------------------------------------------------------------------ the rollback never leaves the install path empty

test.skipIf(!mac)(
	"a rollback that cannot put the old app back leaves an app at the install path, and nothing aside",
	async () => {
		// The new app does not start, and the backup is gone by the time the helper wants it back: `mv` of the backup fails.
		const w = world({ launch: "loseBackup", startSecs: 2 });
		await install(w, "good");
		await until(w, "the handover", (s) => s.job?.phase === "handover");
		await helperEnded(w);
		expect(result(w)).toMatchObject({ ok: false, from: pkg.version, to: NEWER, problem: "rollbackFailed" });
		expect(existsSync(join(w.data, "update", "handover.json"))).toBe(false);
		// An app is still there (the one that was swapped in: before, the helper removed it first and had nothing to put back),
		// whole and signed, and the folder holds nothing else: no `.failed` copy, no staged copy.
		expect(existsSync(join(w.bundle, "Contents", "Info.plist"))).toBe(true);
		expect(versionOf(w.bundle)).toBe(NEWER);
		expect(Bun.spawnSync(["codesign", "--verify", "--deep", "--strict", w.bundle]).exitCode).toBe(0);
		expect(readdirSync(w.installDir)).toEqual(["omp-webui.app"]);
		expect(readFileSync(join(w.data, "update", "helper.log"), "utf8")).toContain("failed: rollbackFailed");
	},
	120_000,
);

test.skipIf(!mac)(
	"a helper that died in the middle of a rollback leaves a `.failed` copy: the next server removes it",
	async () => {
		const w = world();
		mkdirSync(join(w.data, "update"), { recursive: true });
		mkdirSync(`${w.bundle}.failed`);
		writeFileSync(join(`${w.bundle}.failed`, "x"), "x");
		const next = new AppUpdater({ ...optionsOf(w), bundle: w.bundle, parentPid: 1 });
		await next.handle(new Request("http://127.0.0.1/api/update"), new URL("http://127.0.0.1/api/update"));
		expect(existsSync(`${w.bundle}.failed`)).toBe(false);
		expect(existsSync(join(w.bundle, "Contents", "Info.plist"))).toBe(true);
	},
);

// ------------------------------------------------------------------ room for the download

const downloads = () => fake.requests.filter((r) => r.path.startsWith("/download/"));

test.skipIf(!mac)(
	"an install needs three installers' worth free on the data folder's volume and on the app's: short on either, it is refused before a byte is downloaded",
	async () => {
		const good = fixtures.installers.good;
		const size = readFileSync(good?.dmg as string).length;
		const probes: Record<string, (dir: string) => number | null> = {
			"the data folder's volume": (dir) => (dir.endsWith(join("data", "update")) ? 2 * size : 1e12),
			"the app's volume": (dir) => (dir.endsWith("Applications") ? 2 * size + 5 : 1e12),
		};
		for (const [volume, freeBytes] of Object.entries(probes)) {
			const w = world({ options: { freeBytes } });
			fake.requests.length = 0;
			await install(w, "good");
			const failed = (await until(w, `the refusal (${volume})`, (s) => s.failed !== null)).failed;
			expect(failed, volume).toMatchObject({ code: "space", tag: good?.tag });
			expect(failed?.params.needed, volume).toBe(3 * size);
			expect(failed?.params.free as number, volume).toBeLessThan(3 * size);
			// Nothing was fetched, nothing was made, nobody was asked to quit.
			expect(downloads(), volume).toEqual([]);
			expect(readdirSync(w.installDir), volume).toEqual(["omp-webui.app"]);
			expect(
				readdirSync(join(w.data, "update")).filter((f) => f.endsWith(".part") || f.endsWith(".dmg")),
				volume,
			).toEqual([]);
			expect(w.signals, volume).toHaveLength(0);
			expect(state(w).job, volume).toBeNull();
		}
		// Exactly three installers' worth on both is enough: the install goes on to the download.
		const w = world({ onSignal: () => {}, options: { freeBytes: () => 3 * size } });
		await install(w, "good");
		await until(w, "the handover", (s) => s.job?.phase === "handover");
		expect(state(w).failed).toBeNull();
		expect(downloads().length).toBeGreaterThan(0);
		// A file system that cannot say how much is free is no reason to refuse.
		const unknown = world({ onSignal: () => {}, options: { freeBytes: () => null } });
		await install(unknown, "good");
		await until(unknown, "the handover", (s) => s.job?.phase === "handover");
		expect(state(unknown).failed).toBeNull();
	},
	180_000,
);

// ------------------------------------------------------------------ the helper's log

test("a helper log over a megabyte becomes `.1` before the next update writes: it never grows without bound", () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-log-"));
	const log = join(dir, "helper.log");
	try {
		writeFileSync(log, "x".repeat(MAX_LOG_BYTES));
		rotateLog(log);
		expect(readFileSync(log, "utf8")).toHaveLength(MAX_LOG_BYTES);
		expect(existsSync(`${log}.1`)).toBe(false);
		writeFileSync(log, "y".repeat(MAX_LOG_BYTES + 1));
		rotateLog(log);
		expect(existsSync(log)).toBe(false);
		expect(readFileSync(`${log}.1`, "utf8")).toHaveLength(MAX_LOG_BYTES + 1);
		// A second rotation replaces the first one: two files at most, ever.
		writeFileSync(log, "z".repeat(MAX_LOG_BYTES + 2));
		rotateLog(log);
		expect(readFileSync(`${log}.1`, "utf8")).toHaveLength(MAX_LOG_BYTES + 2);
		expect(readdirSync(dir).sort()).toEqual(["helper.log.1"]);
		// No log at all is fine.
		rotateLog(join(dir, "none.log"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
