/**
 * The real swap, end to end (`bun scripts/update-smoke.ts [success] [rollback] [refusals] [--api] [--keep]`, #571).
 *
 * It builds the app twice from copies of this checkout (the version it has, and a newer one), puts the first in a folder
 * of its own as a renamed copy (`dev.omp.webui.updatesmoke`, signed by a throwaway certificate: never the one the app is
 * built with, and never `/Applications/omp-webui.app`), serves the second as `omp-webui-v99.0.0.dmg` from a fake GitHub,
 * starts the copy through LaunchServices with a data dir, a home and a port of their own, presses *Download and install*
 * in its Updates card, and checks what it finds: the old app has quit, the new one runs from the same path with the old
 * one gone, the signature, the designated requirement and the absence of a quarantine mark, and what the helper wrote.
 *
 * - `success`    the swap and the relaunch.
 * - `rollback`   a new app that cannot start: the old one is put back and started, and the card says so.
 * - `refusals`   installers that are tampered with, signed by another certificate, ad hoc, or another app: each is refused
 *                with its reason, and the running app is left as it was.
 * - `--api`      press install through the HTTP route instead of the page (no browser needed).
 * - `--keep`     leave the work folder (and say where) instead of removing it.
 *
 * A window of the copy opens on this Mac's desktop for a few seconds each time. Nothing here touches `~/.omp`, the app's
 * own data folder or port: the copy gets `HOME`, `OMP_WEBUI_DATA_DIR`, `OMP_WEBUI_PORT` and `PI_CODING_AGENT_DIR` of its own.
 * Needs a Mac with Xcode's command-line tools, Bun, and (without `--api`) Chrome or `PLAYWRIGHT_CHANNEL`.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { isRecord } from "../shared/guards.ts";
import type { AppUpdateState, UpdateSnapshot } from "../shared/update.ts";
import { startFakeReleases } from "../tests/support/fake-releases.ts";
import { onShutdown } from "./lib/shutdown.ts";
import { designatedRequirementOf, ensureIdentity, signBundle } from "./signing-identity.ts";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const wanted = args.filter((a) => !a.startsWith("--"));
const scenarios = wanted.length > 0 ? wanted : ["success", "rollback", "refusals"];
const viaApi = args.includes("--api");
const keep = args.includes("--keep");
const NEW_VERSION = "99.0.0";
const BUNDLE_ID = "dev.omp.webui.updatesmoke";
const work = mkdtempSync(join(tmpdir(), "ompw-update-smoke-"));
const shots = join(work, "shots");
mkdirSync(shots);

const apps: number[] = [];
let stopFake: (() => Promise<void>) | null = null;
const keychains: string[] = [];
const cleanup = onShutdown(async () => {
	for (const pid of apps) killAppTree(pid);
	await stopFake?.();
	for (const kc of keychains) Bun.spawnSync(["security", "delete-keychain", kc], { stderr: "ignore" });
	if (!keep) rmSync(work, { recursive: true, force: true });
});

const log = (text: string) => console.log(`[smoke] ${text}`);
function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): string {
	const r = Bun.spawnSync(cmd, {
		cwd: opts.cwd,
		env: opts.env as Record<string, string>,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0)
		throw new Error(`${cmd.join(" ")} (exit ${r.exitCode}): ${r.stderr.toString()}${r.stdout.toString()}`);
	return r.stdout.toString();
}
async function until<T>(what: string, fn: () => T | Promise<T>, ms = 60_000): Promise<NonNullable<T>> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await Promise.resolve(fn()).catch(() => null);
		if (v) return v as NonNullable<T>;
		if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
		await Bun.sleep(250);
	}
}
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
/** The app and what runs from its bundle (its server and any relay), ended. */
function killAppTree(pid: number): void {
	const table = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,command="]).stdout.toString();
	const kids = table
		.split("\n")
		.map((l) => l.trim().split(/\s+/))
		.filter((c) => Number(c[1]) === pid)
		.map((c) => Number(c[0]));
	for (const p of [...kids, pid]) {
		try {
			process.kill(p, "SIGKILL");
		} catch {
			// gone
		}
	}
}

// ------------------------------------------------------------------ building

/** A copy of this checkout, built as the app with `version`, ad hoc signed (re-signed below). */
function buildApp(label: string, version: string): string {
	const src = join(work, `src-${label}`);
	log(`building the ${label} app (${version}) from a copy of the checkout`);
	sh([
		"rsync",
		"-a",
		"--exclude",
		"node_modules",
		"--exclude",
		"dist",
		"--exclude",
		".git",
		"--exclude",
		"test-results",
		"--exclude",
		"playwright-report",
		`${root}/`,
		`${src}/`,
	]);
	sh(["ln", "-s", join(root, "node_modules"), join(src, "node_modules")]);
	const manifest = join(src, "package.json");
	writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version }, null, "\t"));
	// A home of its own, so that the app's build finds no signing identity of the user's (it signs ad hoc; the smoke signs again).
	const home = join(work, `home-build-${label}`);
	mkdirSync(home);
	sh(["bun", "scripts/app.ts"], {
		cwd: src,
		env: { ...process.env, HOME: home, BUN_INSTALL: process.env.BUN_INSTALL ?? join(process.env.HOME ?? "", ".bun") },
	});
	return join(src, "dist", "omp-webui.app");
}

interface Identity {
	keychain: string;
	sha1: string;
}
function identity(name: string): Identity {
	const keychain = join(work, `${name}.keychain-db`);
	keychains.push(keychain);
	return { keychain, sha1: ensureIdentity(keychain) };
}

/** The app renamed (own bundle identifier) and signed with `who`, requirement naming that identifier and that certificate. */
function signed(app: string, dest: string, who: Identity | "adhoc"): string {
	sh(["ditto", app, dest]);
	sh(["plutil", "-replace", "CFBundleIdentifier", "-string", BUNDLE_ID, join(dest, "Contents", "Info.plist")]);
	if (who === "adhoc")
		signBundle(dest, { keychain: join(work, "none.keychain-db"), warn: () => {}, identifier: BUNDLE_ID });
	else signBundle(dest, { keychain: who.keychain, identifier: BUNDLE_ID });
	return dest;
}

function dmgOf(app: string, name: string): string {
	const content = join(work, `content-${name}`);
	mkdirSync(content);
	sh(["ditto", app, join(content, "omp-webui.app")]);
	const dmg = join(work, `${name}.dmg`);
	sh([
		"hdiutil",
		"create",
		"-srcfolder",
		content,
		"-volname",
		"omp-webui",
		"-fs",
		"HFS+",
		"-format",
		"UDZO",
		"-ov",
		"-quiet",
		dmg,
	]);
	rmSync(content, { recursive: true, force: true });
	return dmg;
}

// ------------------------------------------------------------------ running

interface World {
	name: string;
	dir: string;
	installDir: string;
	bundle: string;
	data: string;
	home: string;
	port: number;
	env: Record<string, string>;
}

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const port = probe.port as number;
	await probe.stop(true);
	return port;
}

async function world(name: string, app: string, api: string): Promise<World> {
	const dir = join(work, `world-${name}`);
	const home = join(dir, "home");
	const data = join(dir, "data");
	const installDir = join(dir, "Applications");
	mkdirSync(join(home, ".omp", "agent"), { recursive: true });
	mkdirSync(installDir, { recursive: true });
	const bundle = join(installDir, "omp-webui.app");
	sh(["ditto", app, bundle]);
	const port = await freePort();
	const env = {
		HOME: home,
		PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
		OMP_WEBUI_DATA_DIR: data,
		OMP_WEBUI_PORT: String(port),
		OMP_WEBUI_AUTH: "off",
		OMP_WEBUI_UPDATE_CHECK: "off",
		OMP_WEBUI_APP_UPDATE_API: api,
		OMP_WEBUI_APP_UPDATE_FIRST_MS: "500",
	};
	return { name, dir, installDir, bundle, data, home, port, env };
}

interface ServerRecord {
	pid: number;
	port: number;
	parent?: { pid: number };
}

function serverRecord(w: World): ServerRecord | null {
	try {
		const r: unknown = JSON.parse(readFileSync(join(w.data, "server.pid"), "utf8"));
		if (!isRecord(r) || typeof r.pid !== "number" || typeof r.port !== "number") return null;
		const parent = isRecord(r.parent) && typeof r.parent.pid === "number" ? { pid: r.parent.pid } : undefined;
		return { pid: r.pid, port: r.port, parent };
	} catch {
		return null;
	}
}

/** Start the copy through LaunchServices (as a click does), with the world's environment given by `open --env`. */
function launch(w: World): void {
	const envArgs = Object.entries(w.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
	sh(["open", "-n", ...envArgs, w.bundle]);
}

const call = async (w: World, path: string, post = false): Promise<UpdateSnapshot> => {
	const res = await fetch(`http://127.0.0.1:${w.port}${path}`, {
		method: post ? "POST" : "GET",
		headers: post ? { "x-omp-webui": "1", "content-type": "application/json" } : {},
		body: post ? "{}" : undefined,
	});
	return (await res.json()) as UpdateSnapshot;
};
const state = async (w: World): Promise<AppUpdateState> => (await call(w, "/api/update")).state;

/** Wait for the app the world launched: its server answers and is a child of the app it recorded; returns the app's pid. */
async function started(w: World, not: number[] = []): Promise<number> {
	const pid = await until(
		`the app of ${w.name} to be up`,
		async () => {
			const rec = serverRecord(w);
			if (!rec?.parent || not.includes(rec.parent.pid) || !alive(rec.parent.pid)) return null;
			await state(w);
			return rec.parent.pid;
		},
		90_000,
	);
	apps.push(pid);
	return pid;
}

const versionOf = (bundle: string) =>
	sh([
		"plutil",
		"-extract",
		"CFBundleShortVersionString",
		"raw",
		"-o",
		"-",
		join(bundle, "Contents", "Info.plist"),
	]).trim();
const quarantined = (path: string) => Bun.spawnSync(["xattr", "-p", "com.apple.quarantine", path]).exitCode === 0;

let checks = 0;
function check(ok: boolean, what: string, detail?: unknown): void {
	checks++;
	console.log(
		`[smoke]   ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : ` (${JSON.stringify(detail)})`}`,
	);
	if (!ok) throw new Error(`check failed: ${what}`);
}

/** Press install in the page (or through the route), and return the phases the card went through. */
async function pressInstall(w: World, tag: string, shotPrefix: string): Promise<void> {
	if (viaApi) {
		const res = await fetch(`http://127.0.0.1:${w.port}/api/update/install`, {
			method: "POST",
			headers: { "x-omp-webui": "1", "content-type": "application/json" },
			body: JSON.stringify({ tag, anyway: true }),
		});
		check(res.status === 200, "POST /api/update/install answers 200", await res.text());
		return;
	}
	const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
		await page.goto(`http://127.0.0.1:${w.port}/`);
		await page.getByTestId("update-indicator").click({ timeout: 30_000 });
		await page.getByTestId("update-settings").waitFor();
		await page.getByTestId("update-settings").scrollIntoViewIfNeeded();
		await page.screenshot({ path: join(shots, `${shotPrefix}-available.png`) });
		await page.getByTestId("update-install").click();
		await page.getByTestId("update-progress").waitFor({ timeout: 30_000 });
		await page.screenshot({ path: join(shots, `${shotPrefix}-progress.png`) });
	} finally {
		await browser.close();
	}
}

// ------------------------------------------------------------------ scenarios

async function success(
	oldApp: string,
	newApp: string,
	ident: Identity,
	fake: Awaited<ReturnType<typeof startFakeReleases>>,
): Promise<void> {
	log("scenario: success — the swap and the relaunch");
	const installed = signed(oldApp, join(work, "old-signed.app"), ident);
	const next = signed(newApp, join(work, "new-signed.app"), ident);
	fake.publish({ tag: `v${NEW_VERSION}`, dmg: dmgOf(next, "success") });
	const w = await world("success", installed, fake.url);
	const oldVersion = versionOf(w.bundle);
	const requirementBefore = await designatedRequirementOf(w.bundle);
	launch(w);
	const oldApp_ = await started(w);
	const before = await until("the release to be found", async () => (await state(w)).newer, 60_000);
	const s = await state(w);
	check(
		before === true && s.installed === oldVersion && s.latest?.tag === `v${NEW_VERSION}`,
		`the running copy (${oldVersion}) found v${NEW_VERSION}`,
	);
	check(s.install.allowed === true, "install is allowed: a signed bundle in a folder the user can write", s.install);
	check(Object.keys(await call(w, "/api/update")).includes("state"), "the route answers with the state");

	await pressInstall(w, `v${NEW_VERSION}`, "success");
	log("install pressed; waiting for the old app to quit");
	await until("the old app to quit", () => !alive(oldApp_), 180_000);
	check(true, `the old app (pid ${oldApp_}) quit`);
	const newApp_ = await started(w, [oldApp_]);
	check(newApp_ !== oldApp_, `a new app (pid ${newApp_}) is running`);
	const after = await state(w);
	check(after.installed === NEW_VERSION, `the new server says it is ${NEW_VERSION}`, after.installed);
	check(
		after.outcome?.ok === true && after.outcome.to === NEW_VERSION,
		"the card reports how it ended: ok",
		after.outcome,
	);
	check(versionOf(w.bundle) === NEW_VERSION, `the app at the installed path is ${NEW_VERSION}`);
	const command = sh(["ps", "-o", "command=", "-p", String(newApp_)]).trim();
	check(
		command.startsWith(join(realpathSync(w.bundle), "Contents", "MacOS")),
		"the process runs from the installed path",
		command,
	);
	await until("the backup to be removed", () => !existsSync(`${w.bundle}.previous`), 30_000);
	check(
		readdirSync(w.installDir).join() === "omp-webui.app",
		"nothing is left next to the app: no staged copy, no backup",
		readdirSync(w.installDir),
	);
	sh(["codesign", "--verify", "--deep", "--strict", w.bundle]);
	check(true, "codesign --verify --deep --strict passes on the new app");
	const requirementAfter = await designatedRequirementOf(w.bundle);
	check(
		requirementAfter === requirementBefore && !requirementAfter.includes("cdhash"),
		"the designated requirement is the old app's (the macOS permissions are kept)",
		{ requirementBefore, requirementAfter },
	);
	check(!quarantined(w.bundle) && !quarantined(join(w.bundle, "Contents", "MacOS", "omp-webui")), "no quarantine mark");
	const files = readdirSync(join(w.data, "update"));
	check(
		!files.includes("handover.json") && !files.includes("ack.json") && files.includes("result.json"),
		"handover and ack are removed, the success is kept for the page",
		files,
	);
	log(`helper log:\n${readFileSync(join(w.data, "update", "helper.log"), "utf8").replace(/^/gm, "    ")}`);
	killAppTree(newApp_);
}

async function rollback(
	oldApp: string,
	newApp: string,
	ident: Identity,
	fake: Awaited<ReturnType<typeof startFakeReleases>>,
): Promise<void> {
	log("scenario: rollback — a new app that does not start");
	const installed = signed(oldApp, join(work, "old-signed-rb.app"), ident);
	// The new app is what the release says it is, signed as it must be, but its executable ends at once: nothing says it is up.
	const broken = signed(newApp, join(work, "new-broken.app"), ident);
	writeFileSync(join(broken, "Contents", "MacOS", "omp-webui"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	signBundle(broken, { keychain: ident.keychain, identifier: BUNDLE_ID });
	fake.publish({ tag: `v${NEW_VERSION}`, dmg: dmgOf(broken, "rollback") });
	const w = await world("rollback", installed, fake.url);
	const oldVersion = versionOf(w.bundle);
	launch(w);
	const oldApp_ = await started(w);
	await until("the release to be found", async () => (await state(w)).newer);
	await pressInstall(w, `v${NEW_VERSION}`, "rollback");
	await until("the old app to quit", () => !alive(oldApp_), 180_000);
	check(true, `the old app (pid ${oldApp_}) quit for the update`);
	log("waiting for the helper to give up on the new app (up to 60 s) and put the old one back");
	const again = await started(w, [oldApp_]);
	const s = await state(w);
	check(
		again !== oldApp_ && s.installed === oldVersion,
		`the old app (${oldVersion}) runs again, pid ${again}`,
		s.installed,
	);
	check(versionOf(w.bundle) === oldVersion, "the installed app is the old one");
	check(
		s.outcome?.ok === false && s.outcome.problem === "didNotStart",
		"the card says the new app did not start",
		s.outcome,
	);
	check(
		readdirSync(w.installDir).join() === "omp-webui.app",
		"nothing is left next to the app",
		readdirSync(w.installDir),
	);
	sh(["codesign", "--verify", "--deep", "--strict", w.bundle]);
	check(true, "the restored app's signature is intact");
	log(`helper log:\n${readFileSync(join(w.data, "update", "helper.log"), "utf8").replace(/^/gm, "    ")}`);
	killAppTree(again);
}

async function refusals(
	oldApp: string,
	newApp: string,
	ident: Identity,
	other: Identity,
	fake: Awaited<ReturnType<typeof startFakeReleases>>,
): Promise<void> {
	log("scenario: refusals — each installer is refused with its reason and the running app is left alone");
	const installed = signed(oldApp, join(work, "old-signed-rf.app"), ident);
	const w = await world("refusals", installed, fake.url);
	const oldVersion = versionOf(w.bundle);
	launch(w);
	const app = await started(w);
	const variants: [string, string, () => string][] = [
		[
			"tampered",
			"signature",
			() => {
				const a = signed(newApp, join(work, "new-tampered.app"), ident);
				writeFileSync(join(a, "Contents", "Resources", "AppIcon.icns"), "changed after it was signed");
				return a;
			},
		],
		["another certificate", "requirement", () => signed(newApp, join(work, "new-other.app"), other)],
		["ad hoc", "requirement", () => signed(newApp, join(work, "new-adhoc.app"), "adhoc")],
		[
			"another app",
			"bundleId",
			() => {
				const a = signed(newApp, join(work, "new-id.app"), ident);
				sh([
					"plutil",
					"-replace",
					"CFBundleIdentifier",
					"-string",
					"com.example.other",
					join(a, "Contents", "Info.plist"),
				]);
				signBundle(a, { keychain: ident.keychain, identifier: "com.example.other" });
				return a;
			},
		],
	];
	let n = 0;
	for (const [name, code, make] of variants) {
		fake.publish({ tag: `v${NEW_VERSION}`, dmg: dmgOf(make(), `refuse-${++n}`) });
		await call(w, "/api/update/dismiss", true);
		// A new release is looked for after the minimum gap between two requests.
		await Bun.sleep(10_500);
		await call(w, "/api/update/check", true);
		const res = await fetch(`http://127.0.0.1:${w.port}/api/update/install`, {
			method: "POST",
			headers: { "x-omp-webui": "1", "content-type": "application/json" },
			body: JSON.stringify({ tag: `v${NEW_VERSION}`, anyway: true }),
		});
		check(res.status === 200, `${name}: the install starts`);
		const failed = await until(`the ${name} refusal`, async () => (await state(w)).failed, 180_000);
		check(failed.code === code, `${name}: refused as ${code}`, failed);
		check(alive(app) && versionOf(w.bundle) === oldVersion, `${name}: the running app is still running, unchanged`);
		check(
			readdirSync(w.installDir).join() === "omp-webui.app" && !existsSync(join(w.data, "update", "handover.json")),
			`${name}: nothing staged, nothing handed over`,
		);
	}
	killAppTree(app);
}

// ------------------------------------------------------------------ main

try {
	const fake = await startFakeReleases();
	stopFake = fake.stop;
	const oldVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
	const oldApp = buildApp("old", oldVersion);
	const newApp = buildApp("new", NEW_VERSION);
	const ident = identity("a");
	const other = identity("b");
	if (scenarios.includes("success")) await success(oldApp, newApp, ident, fake);
	if (scenarios.includes("rollback")) await rollback(oldApp, newApp, ident, fake);
	if (scenarios.includes("refusals")) await refusals(oldApp, newApp, ident, other, fake);
	log(`${checks} checks passed${keep ? `; the work folder is ${work} (screenshots in ${shots})` : ""}`);
} catch (e) {
	console.error(`[smoke] FAILED: ${e instanceof Error ? e.message : e}`);
	if (keep) console.error(`[smoke] the work folder is ${work}`);
	process.exitCode = 1;
} finally {
	await cleanup();
}
