// needs: posixShell
import { afterAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserInstaller, CEF_API_VERSION, CEF_INDEX_URL, CFT_VERSIONS_URL } from "../../server/browser/install.ts";
import type { BrowserState } from "../../shared/browser.ts";

/**
 * Installing, updating and clearing each engine against a stand-in for the download servers: a CfT version list and zip,
 * a CEF build index and its `.tar.bz2` builds. Nothing reaches the network.
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

/** A CEF minimal build: one `cef_binary_…` folder whose API header lists `apiVersions`. */
function cefTarball(name: string, apiVersions: number[]): Uint8Array {
	const dir = join(work, `cef-src-${name}`);
	rmSync(dir, { recursive: true, force: true });
	const top = join(dir, name);
	mkdirSync(join(top, "include"), { recursive: true });
	mkdirSync(join(top, "Release", "Chromium Embedded Framework.framework"), { recursive: true });
	writeFileSync(
		join(top, "include", "cef_api_versions.h"),
		apiVersions.map((v) => `#define CEF_API_VERSION_${v} ${v}\n`).join(""),
	);
	const tarball = join(work, `${name}.tar.bz2`);
	sh(["tar", "cjf", tarball, name], dir);
	return new Uint8Array(readFileSync(tarball));
}

const zipBytes = cftZip();
const md5 = createHash("md5").update(zipBytes).digest("base64");
const NEW_CEF = "cef_binary_201.0.1+gaaaaaaa+chromium-201.0.1.0_macosarm64_minimal";
const OLD_CEF = "cef_binary_200.0.3+gbbbbbbb+chromium-200.0.1.0_macosarm64_minimal";
const newCef = cefTarball(NEW_CEF, [CEF_API_VERSION + 100]);
const oldCef = cefTarball(OLD_CEF, [CEF_API_VERSION - 100, CEF_API_VERSION]);
const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");

interface Served {
	md5?: string;
	oldSha1?: string;
	/** Hold the CfT zip after its first bytes until the request is aborted. */
	stall?: boolean;
}
let served: Served = {};
beforeEach(() => {
	served = {};
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
	if (url === CEF_INDEX_URL)
		return Response.json({
			macosarm64: {
				versions: [
					{ cef_version: "202.0.0+gccc+chromium-202", channel: "beta", files: [] },
					{
						cef_version: "201.0.1+gaaaaaaa+chromium-201.0.1.0",
						channel: "stable",
						files: [{ type: "minimal", name: `${NEW_CEF}.tar.bz2`, sha1: sha1(newCef), size: newCef.length }],
					},
					{
						cef_version: "200.0.3+gbbbbbbb+chromium-200.0.1.0",
						channel: "stable",
						files: [
							{ type: "standard", name: "x.tar.bz2", sha1: "0", size: 1 },
							{
								type: "minimal",
								name: `${OLD_CEF}.tar.bz2`,
								sha1: served.oldSha1 ?? sha1(oldCef),
								size: oldCef.length,
							},
						],
					},
				],
			},
		});
	if (url.endsWith(`${NEW_CEF}.tar.bz2`)) return new Response(body(newCef, signal, false));
	if (url.endsWith(`${OLD_CEF}.tar.bz2`)) return new Response(body(oldCef, signal, false));
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

test("a CEF build whose sha1 is not the index's leaves nothing", async () => {
	served.oldSha1 = "0".repeat(40);
	const { root, inst } = installer("cef");
	await inst.install();
	expect(inst.state(true).error).toMatch(/damaged/);
	expect(entries(join(root, "cef"))).toEqual([]);
	expect(JSON.parse(readFileSync(join(root, "current.json"), "utf8")).cef).toBeUndefined();
	expect(inst.state(true).installed).toBeNull();
});

test("a CEF build without the app's API version is passed over for the next older stable one", async () => {
	const restarts: string[] = [];
	const { root, inst } = installer("cef", { requestAppRestart: () => restarts.push("restart") });
	await inst.install();
	expect(inst.state(true).error).toBeNull();
	expect(inst.state(true).installed).toEqual({ version: "200.0.3+gbbbbbbb+chromium-200.0.1.0" });
	expect(entries(join(root, "cef"))).toEqual(["200.0.3+gbbbbbbb+chromium-200.0.1.0"]);
	expect(existsSync(join(root, "cef", "200.0.3+gbbbbbbb+chromium-200.0.1.0", "Release"))).toBe(true);
	expect(inst.state(true).restartNeeded).toBe(true);
	expect(restarts).toEqual(["restart"]);
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

test("uninstalling CEF leaves its removal to the app's next start; installing it again before that keeps it", async () => {
	const restarts: string[] = [];
	const { root, inst } = installer("cef", { requestAppRestart: () => restarts.push("restart") });
	await inst.install();
	const version = "200.0.3+gbbbbbbb+chromium-200.0.1.0";
	await inst.uninstall();
	const current = () => JSON.parse(readFileSync(join(root, "current.json"), "utf8"));
	expect(current().uninstallPending).toBe(true);
	expect(current().cef).toBeUndefined();
	expect(inst.state(true).installed).toBeNull();
	expect(inst.state(true).restartNeeded).toBe(true);
	expect(restarts).toEqual(["restart", "restart"]);
	// The app has it loaded: its files stay until the app removes them.
	expect(entries(join(root, "cef"))).toEqual([version]);

	// Installed again before the app restarted: the files there are taken, nothing is downloaded, and the profile still goes.
	served.oldSha1 = "0".repeat(40);
	await inst.install();
	expect(inst.state(true).error).toBeNull();
	expect(inst.state(true).installed).toEqual({ version });
	expect(current().uninstallPending).toBeUndefined();
	expect(current().clearPending).toBe(true);
});

test("uninstalling CEF that is not installed changes nothing", async () => {
	const restarts: string[] = [];
	const { root, inst } = installer("cef", { requestAppRestart: () => restarts.push("restart") });
	await inst.uninstall();
	expect(existsSync(join(root, "current.json"))).toBe(false);
	expect(restarts).toEqual([]);
	expect(inst.state(true).restartNeeded).toBe(false);
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
