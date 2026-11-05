// needs: posixShell
import { afterAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	APP_CEF_VERSION,
	BrowserInstaller,
	CFT_VERSIONS_URL,
	handleBrowserRoute,
} from "../../server/browser/install.ts";
import type { BrowserAutoCheck, BrowserState } from "../../shared/browser.ts";

/**
 * Installing, updating (by hand and automatically) and clearing Chrome for Testing against a stand-in for Google's servers
 * (a version list and a zip), and what is left to manage of the Mac app's CEF, which the app ships. Nothing reaches the
 * network.
 */

const work = mkdtempSync(join(tmpdir(), "ompw-browser-install-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function sh(cmd: string[], cwd: string): void {
	const r = Bun.spawnSync(cmd, { cwd });
	if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
}

const CFT_VERSION = "200.0.1.0";
const CFT_ZIP_URL = `https://storage.googleapis.com/chrome-for-testing-public/${CFT_VERSION}/mac-arm64/chrome-mac-arm64.zip`;
const CFT_EXE = "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

/** A CfT zip as Google serves it: one `chrome-<platform>` folder. */
function cftZip(): Uint8Array {
	const dir = join(work, "cft-src");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(dir, CFT_EXE, ".."), { recursive: true });
	writeFileSync(join(dir, CFT_EXE), "#!/bin/sh\n", { mode: 0o755 });
	const zip = join(work, "cft.zip");
	rmSync(zip, { force: true });
	sh(["zip", "-qr", zip, "chrome-mac-arm64"], dir);
	return new Uint8Array(readFileSync(zip));
}

const zipBytes = cftZip();
const md5 = createHash("md5").update(zipBytes).digest("base64");

interface Served {
	md5?: string;
	/** Hold the CfT zip after its first bytes until the request is aborted. */
	stall?: boolean;
}
let served: Served = {};
/** Every address the installers asked for, in order. */
let asked: string[] = [];
beforeEach(() => {
	served = {};
	asked = [];
});

function body(bytes: Uint8Array, signal: AbortSignal | null | undefined, stall: boolean): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes.slice(0, 1024));
			if (!stall) {
				controller.enqueue(bytes.slice(1024));
				controller.close();
				return;
			}
			signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
		},
	});
}

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = decodeURIComponent(String(input instanceof Request ? input.url : input));
	asked.push(url);
	const signal = init?.signal;
	if (url === CFT_VERSIONS_URL)
		return Response.json({
			channels: {
				Stable: {
					version: CFT_VERSION,
					downloads: { chrome: [{ platform: "mac-arm64", url: CFT_ZIP_URL }] },
				},
			},
		});
	if (url === CFT_ZIP_URL)
		return new Response(body(zipBytes, signal, served.stall === true), {
			headers: { "content-length": String(zipBytes.length), "x-goog-hash": `crc32c=AAAA==, md5=${served.md5 ?? md5}` },
		});
	return new Response("not found", { status: 404 });
}) as typeof fetch;

let n = 0;
function installer(engine: "cft" | "cef", hooks: ConstructorParameters<typeof BrowserInstaller>[0]["hooks"] = {}) {
	const root = join(work, `root-${++n}`);
	const states: BrowserState[] = [];
	const inst = new BrowserInstaller({ root, engine, fetch: fakeFetch, cftPlatform: "mac-arm64", hooks });
	inst.onChange(() => states.push(inst.state(true)));
	return { root, inst, states };
}

/** What is left in an engine's folder: version folders and nothing half-made. */
const entries = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

test("installing CfT puts the version's folder and current.json, and shows progress", async () => {
	const { root, inst, states } = installer("cft");
	await inst.check();
	expect(inst.state(true).latest).toBe(CFT_VERSION);
	await inst.install();
	expect(entries(join(root, "cft"))).toEqual([CFT_VERSION]);
	expect(JSON.parse(readFileSync(join(root, "current.json"), "utf8")).cft.version).toBe(CFT_VERSION);
	expect(inst.executable()).toBe(join(root, "cft", CFT_VERSION, CFT_EXE));
	expect(existsSync(inst.executable() ?? "")).toBe(true);
	const s = inst.state(true);
	expect(s.installed).toEqual({ version: CFT_VERSION });
	expect(s.job).toBeNull();
	expect(s.error).toBeNull();
	expect(states.some((x) => x.job?.kind === "install" && x.job.total === zipBytes.length)).toBe(true);
	// A new installer over the same folder knows what is installed.
	const again = new BrowserInstaller({ root, engine: "cft", fetch: fakeFetch, cftPlatform: "mac-arm64" });
	expect(again.state(false).installed).toEqual({ version: CFT_VERSION });
	expect(again.state(false).canManage).toBe(false);
});

test("a CfT zip whose MD5 is not the one Google lists leaves nothing", async () => {
	served.md5 = Buffer.from("x".repeat(16)).toString("base64");
	const { root, inst } = installer("cft");
	await inst.install();
	expect(inst.state(true).error).toMatch(/damaged/);
	expect(inst.state(true).installed).toBeNull();
	expect(entries(join(root, "cft"))).toEqual([]);
	expect(existsSync(join(root, "current.json"))).toBe(false);
	expect(inst.executable()).toBeNull();
});

test("cancel in the middle of a download leaves no partial folder", async () => {
	served.stall = true;
	const { root, inst, states } = installer("cft");
	const running = inst.install();
	while (!states.some((s) => s.job && s.job.received > 0)) await Bun.sleep(5);
	inst.cancel();
	await running;
	const s = inst.state(true);
	expect(s.job).toBeNull();
	expect(s.error).toBeNull();
	expect(s.installed).toBeNull();
	expect(entries(join(root, "cft"))).toEqual([]);
});

test("clear with CfT running stops it, removes cft-profile/, and starts it again", async () => {
	const steps: string[] = [];
	let profile = "";
	const { inst } = installer("cft", {
		stopEngine: async () => {
			steps.push(`stop:${existsSync(profile)}`);
		},
		startEngine: async () => {
			steps.push(`start:${existsSync(profile)}`);
		},
	});
	profile = inst.profileDir();
	mkdirSync(join(profile, "Default"), { recursive: true });
	writeFileSync(join(profile, "Default", "Cookies"), "secret");
	await inst.clear();
	expect(steps).toEqual(["stop:true", "start:false"]);
	expect(inst.state(true).job).toBeNull();
});

test("clear of CEF marks the profile for deletion at the app's next start and asks the app to restart", async () => {
	const restarts: string[] = [];
	const { root, inst } = installer("cef", { requestAppRestart: () => restarts.push("restart") });
	mkdirSync(inst.profileDir(), { recursive: true });
	await inst.clear();
	expect(JSON.parse(readFileSync(join(root, "current.json"), "utf8")).clearPending).toBe(true);
	expect(inst.state(true).restartNeeded).toBe(true);
	expect(restarts).toEqual(["restart"]);
	expect(inst.profileDir()).toBe(join(root, "cef-profile"));
});

test("uninstalling CfT stops it, removes it and its profile, and does not start it again", async () => {
	const steps: string[] = [];
	const { root, inst } = installer("cft", {
		stopEngine: async () => {
			steps.push("stop");
		},
		startEngine: async () => {
			steps.push("start");
		},
	});
	await inst.install();
	mkdirSync(join(inst.profileDir(), "Default"), { recursive: true });
	await inst.uninstall();
	expect(steps).toEqual(["stop"]);
	expect(inst.state(true).installed).toBeNull();
	expect(inst.executable()).toBeNull();
	expect(existsSync(join(root, "cft"))).toBe(false);
	expect(existsSync(inst.profileDir())).toBe(false);
	expect(JSON.parse(readFileSync(join(root, "current.json"), "utf8")).cft).toBeUndefined();
	// It can be installed again.
	await inst.install();
	expect(inst.state(true).installed).toEqual({ version: CFT_VERSION });
});

test("OMPW_BROWSER_EXECUTABLE stands for an installed CfT", () => {
	const inst = new BrowserInstaller({
		root: join(work, "root-env"),
		engine: "cft",
		fetch: fakeFetch,
		executableOverride: "/opt/chrome/chrome",
	});
	expect(inst.executable()).toBe("/opt/chrome/chrome");
});

test("a test download base stands for both download servers, and downloads from elsewhere are still refused", async () => {
	const base = "http://127.0.0.1:9";
	const asked: string[] = [];
	const zipUrl = `${base}/cft/chrome-mac-arm64.zip`;
	const local = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		asked.push(url);
		if (url === `${base}/cft/versions.json`)
			return Response.json({
				channels: { Stable: { version: CFT_VERSION, downloads: { chrome: [{ platform: "mac-arm64", url: zipUrl }] } } },
			});
		if (url === zipUrl) return fakeFetch(CFT_ZIP_URL, init);
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	const root = join(work, "root-base");
	const inst = new BrowserInstaller({
		root,
		engine: "cft",
		fetch: local,
		cftPlatform: "mac-arm64",
		downloadBase: base,
	});
	await inst.install();
	expect(inst.state(true).installed).toEqual({ version: CFT_VERSION });
	expect(asked).toEqual([`${base}/cft/versions.json`, zipUrl]);

	// Its version list naming a zip on another plain-http host: not a download address.
	const elsewhere = (async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === `${base}/cft/versions.json`)
			return Response.json({
				channels: {
					Stable: {
						version: "201.0.0.0",
						downloads: { chrome: [{ platform: "mac-arm64", url: "http://example.test/c.zip" }] },
					},
				},
			});
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	const refused = new BrowserInstaller({
		root: join(work, "root-base-2"),
		engine: "cft",
		fetch: elsewhere,
		cftPlatform: "mac-arm64",
		downloadBase: base,
	});
	await refused.install();
	expect(refused.state(true).error).toMatch(/Not a download address/);
});

// ------------------------------------------------------------------ automatic updates

const OLD_CFT = "199.0.0.0";
const NOW = 1_700_000_000_000;

/** An installer over a folder where `version` of CfT is installed already. */
function installedAt(version: string, hooks: ConstructorParameters<typeof BrowserInstaller>[0]["hooks"] = {}) {
	const root = join(work, `root-${++n}`);
	mkdirSync(join(root, "cft", version, CFT_EXE, ".."), { recursive: true });
	writeFileSync(join(root, "cft", version, CFT_EXE), "#!/bin/sh\n", { mode: 0o755 });
	writeFileSync(join(root, "current.json"), JSON.stringify({ cft: { version, platform: "mac-arm64" } }));
	const make = () =>
		new BrowserInstaller({ root, engine: "cft", fetch: fakeFetch, cftPlatform: "mac-arm64", hooks, now: () => NOW });
	return { root, inst: make(), make };
}

const current = (root: string) => JSON.parse(readFileSync(join(root, "current.json"), "utf8"));
const zipsFetched = () => asked.filter((url) => url === CFT_ZIP_URL).length;

test("an automatic update puts a newer CfT beside the one in use, and switches to it only when told, removing the old one", async () => {
	const steps: string[] = [];
	const { root, inst, make } = installedAt(OLD_CFT, {
		stopEngine: async () => {
			steps.push("stop");
		},
		startEngine: async () => {
			steps.push("start");
		},
	});
	const check = await inst.autoUpdate();
	expect(check).toEqual({ at: NOW, result: "waiting", version: CFT_VERSION, error: null });
	expect(inst.state(true).autoCheck).toEqual(check);
	// Downloaded and checked as Update does, and nothing that runs was touched: the engine still runs the old one.
	expect(steps).toEqual([]);
	expect(inst.waiting).toBe(CFT_VERSION);
	expect(inst.state(true).installed).toEqual({ version: OLD_CFT });
	expect(inst.executable()).toBe(join(root, "cft", OLD_CFT, CFT_EXE));
	expect(entries(join(root, "cft"))).toEqual([OLD_CFT, CFT_VERSION]);
	expect(existsSync(join(root, "cft", CFT_VERSION, CFT_EXE))).toBe(true);
	expect(current(root).cftNext).toEqual({ version: CFT_VERSION, platform: "mac-arm64" });
	expect(inst.state(true).error).toBeNull();

	// The next check finds the same version waiting: nothing is downloaded again.
	expect((await inst.autoUpdate())?.result).toBe("waiting");
	expect(zipsFetched()).toBe(1);
	// The server restarted meanwhile: the version that waits is kept, not pruned.
	const again = make();
	expect(again.waiting).toBe(CFT_VERSION);
	expect(entries(join(root, "cft"))).toEqual([OLD_CFT, CFT_VERSION]);

	expect(await inst.switchToNext()).toEqual({ at: NOW, result: "updated", version: CFT_VERSION, error: null });
	expect(steps).toEqual(["stop", "start"]);
	expect(inst.state(true).installed).toEqual({ version: CFT_VERSION });
	expect(inst.executable()).toBe(join(root, "cft", CFT_VERSION, CFT_EXE));
	expect(inst.waiting).toBeNull();
	expect(entries(join(root, "cft"))).toEqual([CFT_VERSION]);
	expect(current(root).cftNext).toBeUndefined();
	// Nothing waits any more.
	expect(await inst.switchToNext()).toBeNull();
	expect(steps).toEqual(["stop", "start"]);
});

test("an automatic update takes only a newer version: the same or an older Stable downloads nothing", async () => {
	for (const version of [CFT_VERSION, "201.0.0.0"]) {
		const { root, inst } = installedAt(version);
		expect((await inst.autoUpdate())?.result).toBe("upToDate");
		expect(inst.state(true).latest).toBe(CFT_VERSION);
		expect(inst.state(true).installed).toEqual({ version });
		expect(inst.waiting).toBeNull();
		expect(entries(join(root, "cft"))).toEqual([version]);
	}
	expect(zipsFetched()).toBe(0);
});

test("a failed automatic download is no error of the card's, leaves nothing, and the next check tries again", async () => {
	served.md5 = Buffer.from("x".repeat(16)).toString("base64");
	const { root, inst } = installedAt(OLD_CFT);
	const check = await inst.autoUpdate();
	expect(check?.result).toBe("failed");
	expect(check?.error).toMatch(/damaged/);
	expect(inst.state(true).error).toBeNull();
	expect(inst.state(true).job).toBeNull();
	expect(inst.waiting).toBeNull();
	expect(entries(join(root, "cft"))).toEqual([OLD_CFT]);
	expect(current(root).cftNext).toBeUndefined();

	served.md5 = undefined;
	expect((await inst.autoUpdate())?.result).toBe("waiting");
	expect(inst.state(true).autoCheck?.error).toBeNull();
});

test("a failed look-up is told in autoCheck alone, never as the card's error", async () => {
	const { root } = installedAt(OLD_CFT);
	const offline = new BrowserInstaller({
		root,
		engine: "cft",
		fetch: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
		cftPlatform: "mac-arm64",
		now: () => NOW,
	});
	const check: BrowserAutoCheck = {
		at: NOW,
		result: "failed",
		version: null,
		error: "Chrome for Testing's version list answered 503",
	};
	expect(await offline.autoUpdate()).toEqual(check);
	expect(offline.state(true).autoCheck).toEqual(check);
	expect(offline.state(true).error).toBeNull();
});

test("Update while an automatic update's version waits takes that version without downloading it again", async () => {
	const steps: string[] = [];
	const { root, inst } = installedAt(OLD_CFT, {
		stopEngine: async () => {
			steps.push("stop");
		},
		startEngine: async () => {
			steps.push("start");
		},
	});
	await inst.autoUpdate();
	await inst.install();
	expect(inst.state(true).error).toBeNull();
	expect(inst.state(true).installed).toEqual({ version: CFT_VERSION });
	expect(zipsFetched()).toBe(1);
	expect(steps).toEqual(["stop", "start"]);
	expect(entries(join(root, "cft"))).toEqual([CFT_VERSION]);
	expect(inst.waiting).toBeNull();
});

test("the Mac app's CEF is the version the app ships: there from the start, never looked up, downloaded or updated", async () => {
	const { inst } = installer("cef");
	expect(inst.state(true).installed).toEqual({ version: APP_CEF_VERSION });
	expect(inst.state(true).latest).toBeNull();
	expect(await inst.autoUpdate()).toBeNull();
	expect(asked).toEqual([]);
});

test("with CEF a page may ask only for Clear: Check, Install, Cancel and Uninstall are not there", async () => {
	const restarts: string[] = [];
	const { root, inst } = installer("cef", { requestAppRestart: () => restarts.push("restart") });
	const here = { remote: null, local: true };
	const post = (action: string) =>
		handleBrowserRoute(
			new Request(`http://127.0.0.1/api/browser/${action}`, { method: "POST" }),
			new URL(`http://127.0.0.1/api/browser/${action}`),
			inst,
			here,
		);
	for (const action of ["check", "install", "cancel", "uninstall"]) expect((await post(action)).status).toBe(404);
	expect(asked).toEqual([]);
	expect(existsSync(join(root, "current.json"))).toBe(false);
	const done = Promise.withResolvers<void>();
	const stop = inst.onChange(() => {
		if (inst.state(true).job) return;
		stop();
		done.resolve();
	});
	expect((await post("clear")).status).toBe(202);
	await done.promise;
	expect(current(root).clearPending).toBe(true);
	expect(restarts).toEqual(["restart"]);
});

test("nothing is looked up for an automatic update while nothing is installed", async () => {
	const { inst } = installer("cft");
	expect(await inst.autoUpdate()).toBeNull();
	expect(asked).toEqual([]);
	expect(inst.state(true).autoCheck).toBeNull();
});
