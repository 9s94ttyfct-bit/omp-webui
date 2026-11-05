import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	BROWSER_NOT_HERE,
	type BrowserAutoCheck,
	type BrowserJobKind,
	type BrowserState,
	type EngineKind,
} from "../../shared/browser.ts";
import cefBuild from "../../third_party/cef/cef-build.json";
import { platform } from "../platform/index.ts";
import type { RemoteIdentity } from "../remote-auth.ts";
import { isNewer } from "./autoupdate.ts";
import { canManageBrowser } from "./gate.ts";

/**
 * Installing, updating, clearing and uninstalling the built-in browser's engine, in `<dataDir>/browser/`:
 *
 * - `cft/<version>/`: Chrome for Testing, the engine of a server that runs alone. Its newest Stable comes from Google's
 *   version list; the zip's size and MD5 are the ones Google's storage answers with.
 * - `cft-profile/`, `cef-profile/`: each engine's own profile (logins, cookies, storage).
 * - `current.json`: what is installed, a CfT version an automatic update downloaded and switches to once nobody uses the
 *   browser (`cftNext`), and a clear of CEF's profile the app does at its next start (`clearPending`).
 *
 * The Mac app's CEF is not installed here: the app ships it (scripts/app.ts) and its version is the one the app is built
 * against (`APP_CEF_VERSION`). Of CEF this manages only its profile (Clear); `handleBrowserRoute` offers nothing else.
 *
 * A download goes to `<version>.download`, is checked, unpacked into `<version>.part` and renamed into place: nothing
 * half-made is ever taken for an install, and what a failed or cancelled job left is removed. The automatic update
 * (`autoupdate.ts`) downloads the same way, with `autoUpdate` and `switchToNext`.
 */

export const CFT_VERSIONS_URL =
	"https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
/** Where engine downloads may come from: Google's storage. */
const DOWNLOAD_HOST = "storage.googleapis.com";

/** The CEF the Mac app ships: the release third_party/cef holds, which the app is built against. */
export const APP_CEF_VERSION: string = cefBuild.version;

/** The longest a download may go without a byte. */
const IDLE_MS = 30_000;
/** Progress is told at most this often. */
const PROGRESS_MS = 250;

export type CftPlatform = "mac-arm64" | "mac-x64" | "linux64" | "win64";

function cftPlatformHere(): CftPlatform | null {
	if (platform.id === "darwin") return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
	if (platform.id === "linux" && process.arch === "x64") return "linux64";
	if (platform.id === "win32" && process.arch === "x64") return "win64";
	return null;
}

/** The executable inside an unpacked CfT zip. */
function cftExecutable(platform: CftPlatform): string {
	if (platform === "linux64") return join("chrome-linux64", "chrome");
	if (platform === "win64") return join("chrome-win64", "chrome.exe");
	return join(`chrome-${platform}`, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
}

interface Current {
	cft?: { version: string; platform: CftPlatform };
	/** CfT: a newer version an automatic update put in `cft/<version>/`, the one used once nobody uses the browser. */
	cftNext?: { version: string; platform: CftPlatform };
	/** CEF's profile is deleted by the app before CEF starts again. */
	clearPending?: boolean;
}

export interface BrowserHooks {
	/** CfT: stop the running engine (nothing when none runs); `why` is told to the connections it ends. */
	stopEngine?(why: string): Promise<void>;
	/** CfT: start the engine again if it is wanted. */
	startEngine?(): Promise<void>;
	/** CEF: the app is to restart (the shell events stream's `browserRestart`). */
	requestAppRestart?(): void;
}

export interface BrowserInstallerOptions {
	/** `<dataDir>/browser`. */
	root: string;
	engine: EngineKind;
	fetch?: typeof fetch;
	/** CfT's platform (tests); this machine's otherwise. */
	cftPlatform?: CftPlatform | null;
	/** `OMPW_BROWSER_EXECUTABLE`: a Chrome to run instead of an installed CfT (tests, CI). */
	executableOverride?: string | null;
	/**
	 * `OMPW_BROWSER_DOWNLOAD_BASE` (tests only): an origin such as `http://127.0.0.1:<port>` that stands for Google's
	 * servers. The CfT version list is `<base>/cft/versions.json`; downloads may come from that origin (over plain http too).
	 */
	downloadBase?: string | null;
	hooks?: BrowserHooks;
	/**
	 * CEF: whether the app is to restart for the browser to work, apart from a Clear (the browser was turned on in an app that
	 * did not start CEF at its launch). Shown as `restartNeeded`.
	 */
	appRestartPending?: () => boolean;
	idleMs?: number;
	/** The clock `autoCheck` is told by (tests). */
	now?: () => number;
}

class Cancelled extends Error {
	constructor() {
		super("cancelled");
	}
}

/** A job that stops here, with the words the page shows. */
class JobError extends Error {}

export class BrowserInstaller {
	private readonly fetcher: typeof fetch;
	private readonly platform: CftPlatform | null;
	private readonly override: string | null;
	private readonly hooks: BrowserHooks;
	/** Where the version list is, and the origin downloads may come from in a test. */
	private readonly sources: { cft: string; test: string | null };
	private current: Current;
	private rev = 0;
	private latest: string | null = null;
	private job: BrowserState["job"] = null;
	private error: string | null = null;
	private restartNeeded = false;
	private autoCheck: BrowserAutoCheck | null = null;
	private abort: AbortController | null = null;
	private lastProgressAt = 0;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly opts: BrowserInstallerOptions) {
		this.fetcher = opts.fetch ?? fetch;
		this.platform = opts.cftPlatform === undefined ? cftPlatformHere() : opts.cftPlatform;
		this.override = opts.executableOverride ?? process.env.OMPW_BROWSER_EXECUTABLE ?? null;
		this.hooks = opts.hooks ?? {};
		const base = (opts.downloadBase ?? process.env.OMPW_BROWSER_DOWNLOAD_BASE ?? "").replace(/\/+$/, "");
		const test = base ? new URL(base).origin : null;
		this.sources = test ? { cft: `${test}/cft/versions.json`, test } : { cft: CFT_VERSIONS_URL, test: null };
		this.current = this.read();
		this.prune();
	}

	get engine(): EngineKind {
		return this.opts.engine;
	}

	state(canManage: boolean): BrowserState {
		const installed = this.opts.engine === "cef" ? { version: APP_CEF_VERSION } : this.current.cft;
		return {
			rev: this.rev,
			engine: this.opts.engine,
			installed: installed ? { version: installed.version } : null,
			latest: this.latest,
			job: this.job ? { ...this.job } : null,
			error: this.error,
			restartNeeded: this.restartNeeded || (this.opts.appRestartPending?.() ?? false),
			autoCheck: this.autoCheck ? { ...this.autoCheck } : null,
			canManage,
		};
	}

	/** Called after every change of the state; returns the function that stops it. */
	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	/** The Chrome to run: the override, or the installed CfT; null when there is none (and always for CEF). */
	executable(): string | null {
		if (this.opts.engine !== "cft") return null;
		if (this.override) return this.override;
		const cft = this.current.cft;
		return cft ? join(this.opts.root, "cft", cft.version, cftExecutable(cft.platform)) : null;
	}

	profileDir(): string {
		return join(this.opts.root, `${this.opts.engine}-profile`);
	}

	/** CfT: looks up the newest version that would be installed. */
	async check(): Promise<void> {
		try {
			this.latest = (await this.cftRelease(AbortSignal.timeout(this.opts.idleMs ?? IDLE_MS))).version;
			if (!this.job) this.error = null;
		} catch (e) {
			if (!this.job) this.error = words(e);
		}
		this.emit();
	}

	/** CfT: installs the newest version, or updates to it. Settles when the job ends (it never throws). */
	async install(): Promise<void> {
		if (this.job) return;
		const kind: BrowserJobKind = this.current.cft ? "update" : "install";
		await this.run(kind, async (signal) => {
			await this.installCft(signal);
		});
	}

	/** CfT: the newer version an automatic update downloaded, switched to once nobody uses the browser; null when none. */
	get waiting(): string | null {
		return this.opts.engine === "cft" ? (this.current.cftNext?.version ?? null) : null;
	}

	/**
	 * The automatic update of CfT (`autoupdate.ts` decides when): looks up the newest version where Update does and, when it
	 * is newer than the installed one, downloads and checks it as Update does, as an `update` job the card shows (and can
	 * cancel), and keeps it waiting beside the installed one (`cftNext`) for `switchToNext`. What came of it is `autoCheck`
	 * (and the answer), never `error`. Null when it did not look: this server drives CEF, nothing is installed, or a job runs.
	 */
	async autoUpdate(): Promise<BrowserAutoCheck | null> {
		const installed = this.current.cft?.version;
		if (this.opts.engine !== "cft" || !installed || this.job) return null;
		let newest: string;
		try {
			newest = (await this.cftRelease(AbortSignal.timeout(this.opts.idleMs ?? IDLE_MS))).version;
		} catch (e) {
			return this.noteAuto("failed", null, words(e));
		}
		this.latest = newest;
		if (!isNewer(newest, installed)) return this.noteAuto("upToDate", null, null);
		if (newest === this.waiting) return this.noteAuto("waiting", newest, null);
		// The person started a job meanwhile: it is theirs, and the next check looks again.
		if (this.job) return null;
		let done = null as string | null;
		const end = await this.run(
			"update",
			async (signal) => {
				done = await this.installCft(signal, true);
			},
			true,
		);
		if (end.cancelled) return null;
		if (end.error !== null) return this.noteAuto("failed", null, end.error);
		if (done === null) return this.noteAuto("upToDate", null, null);
		return this.noteAuto(done === this.waiting ? "waiting" : "updated", done, null);
	}

	/**
	 * CfT: switches to the version the automatic update downloaded (`autoupdate.ts` calls it when nobody uses the browser):
	 * the engine stops, the new version is the installed one, the old one's folder goes, and the engine starts again if it
	 * ran. Null when there is nothing to switch to, or a job runs.
	 */
	async switchToNext(): Promise<BrowserAutoCheck | null> {
		const next = this.current.cftNext;
		if (this.opts.engine !== "cft" || !next || this.job) return null;
		if (!existsSync(join(this.opts.root, "cft", next.version, cftExecutable(next.platform)))) {
			// Its folder went (removed by hand): the next check downloads it again.
			const { cftNext: _, ...rest } = this.current;
			this.write(rest);
			this.emit();
			return null;
		}
		const end = await this.run("update", () => this.switchCft(next), true);
		if (end.cancelled) return null;
		if (end.error !== null) return this.noteAuto("failed", null, end.error);
		return this.noteAuto("updated", next.version, null);
	}

	cancel(): void {
		if (this.job?.kind === "install" || this.job?.kind === "update") this.abort?.abort();
	}

	/**
	 * Clears the engine's profile. CfT: stops it, deletes the profile, starts it again. CEF: the profile is open in the app,
	 * so the app deletes it at its next start, and is asked to restart now.
	 */
	async clear(): Promise<void> {
		if (this.job) return;
		await this.run("clear", async () => {
			if (this.opts.engine === "cft") {
				await this.hooks.stopEngine?.("The browser restarted to clear its data");
				try {
					rmSync(this.profileDir(), { recursive: true, force: true });
				} finally {
					await this.hooks.startEngine?.();
				}
				return;
			}
			this.write({ ...this.current, clearPending: true });
			this.restartNeeded = true;
			this.hooks.requestAppRestart?.();
		});
	}

	/**
	 * Whether the app is to restart for the browser to work may have changed (`appRestartPending`): the pages are told; with
	 * `ask`, the app is asked to restart now.
	 */
	appRestartChanged(ask: boolean): void {
		if (ask) this.hooks.requestAppRestart?.();
		this.emit();
	}

	/**
	 * CfT: removes the engine and what it kept (logins, cookies, storage, cache); installing again starts over. It is
	 * stopped and `cft/` and `cft-profile/` are deleted, so no conversation is given the browser's endpoint any more.
	 */
	async uninstall(): Promise<void> {
		if (this.job) return;
		await this.run("uninstall", async () => {
			await this.hooks.stopEngine?.("The browser was uninstalled");
			const { cft: _, cftNext: __, ...rest } = this.current;
			this.write(rest);
			for (const name of ["cft", "cft-profile"]) rmSync(join(this.opts.root, name), { recursive: true, force: true });
		});
	}

	// ------------------------------------------------------------------ jobs

	/**
	 * Runs a job, and says how it ended: `error`, its words (also the state's `error`, unless `quiet`: an automatic update's
	 * failure is told in `autoCheck` instead), or `cancelled`.
	 */
	private async run(
		kind: BrowserJobKind,
		body: (signal: AbortSignal) => Promise<void>,
		quiet = false,
	): Promise<{ error: string | null; cancelled: boolean }> {
		const abort = new AbortController();
		this.abort = abort;
		this.job = { kind, received: 0, total: 0 };
		if (!quiet) this.error = null;
		this.emit();
		let error: string | null = null;
		try {
			await body(abort.signal);
		} catch (e) {
			if (!(e instanceof Cancelled) && !abort.signal.aborted) error = words(e);
		} finally {
			this.removeLeftovers();
			this.abort = null;
			this.job = null;
			if (!quiet && error !== null) this.error = error;
			this.emit();
		}
		return { error, cancelled: abort.signal.aborted };
	}

	/**
	 * Installs CfT's newest Stable, or updates to it: at once, or, for the automatic update (`auto`), only when it is newer
	 * than the installed version, and kept waiting beside it as `cftNext`. The version put in place; null when none was.
	 */
	private async installCft(signal: AbortSignal, auto = false): Promise<string | null> {
		if (!this.platform) throw new JobError("Chrome for Testing is not built for this computer's system");
		const release = await this.cftRelease(signal);
		this.latest = release.version;
		const before = this.current.cft;
		if (before?.version === release.version && before.platform === this.platform) return null;
		if (auto && before && !isNewer(release.version, before.version)) return null;
		const next = { version: release.version, platform: this.platform };
		const dir = join(this.opts.root, "cft");
		const waiting = this.current.cftNext;
		// An automatic update downloaded it already: Update takes it as it is.
		const ready =
			waiting?.version === next.version &&
			waiting.platform === next.platform &&
			existsSync(join(dir, next.version, cftExecutable(next.platform)));
		if (!ready) {
			mkdirSync(dir, { recursive: true });
			const file = join(dir, `${release.version}.download`);
			const got = await this.download(release.url, file, signal);
			const listed = /(?:^|,)\s*md5=([A-Za-z0-9+/=]+)/.exec(got.goog ?? "")?.[1];
			if (!listed) throw new JobError("Google's storage listed no checksum for Chrome for Testing");
			if (listed !== got.md5) throw new JobError("The Chrome for Testing download is damaged (checksum differs)");
			const part = join(dir, `${release.version}.part`);
			await unpack(file, part, signal);
			if (!existsSync(join(part, cftExecutable(this.platform))))
				throw new JobError("The Chrome for Testing download holds no Chrome");
			rmSync(join(dir, release.version), { recursive: true, force: true });
			renameSync(part, join(dir, release.version));
			rmSync(file, { force: true });
		}
		if (auto && before) {
			// The version it replaces goes with the switch; one that waited before this one goes now (nothing runs it).
			if (waiting && waiting.version !== next.version)
				rmSync(join(dir, waiting.version), { recursive: true, force: true });
			this.write({ ...this.current, cftNext: next });
			return next.version;
		}
		await this.switchCft(next);
		return next.version;
	}

	/**
	 * `next`, unpacked in `cft/`, is the installed CfT from now on: a running engine is stopped first and started again after
	 * (when it ran), and the versions it replaced go.
	 */
	private async switchCft(next: { version: string; platform: CftPlatform }): Promise<void> {
		const before = this.current.cft;
		if (before) await this.hooks.stopEngine?.("The browser restarted for an update");
		const { cftNext: _, ...rest } = this.current;
		this.write({ ...rest, cft: next });
		if (before) {
			this.prune();
			await this.hooks.startEngine?.();
		}
	}

	/** What the automatic update came to, told to the pages. */
	private noteAuto(result: BrowserAutoCheck["result"], version: string | null, error: string | null): BrowserAutoCheck {
		this.autoCheck = { at: (this.opts.now ?? Date.now)(), result, version, error };
		this.emit();
		return { ...this.autoCheck };
	}

	private async cftRelease(signal: AbortSignal): Promise<{ version: string; url: string }> {
		const res = await this.fetcher(this.sources.cft, { signal });
		if (!res.ok) throw new JobError(`Chrome for Testing's version list answered ${res.status}`);
		const data = (await res.json()) as {
			channels?: { Stable?: { version?: string; downloads?: { chrome?: { platform: string; url: string }[] } } };
		};
		const stable = data.channels?.Stable;
		const url = stable?.downloads?.chrome?.find((d) => d.platform === this.platform)?.url;
		if (!stable?.version || !url)
			throw new JobError("Chrome for Testing's version list has no build for this computer");
		return { version: stable.version, url };
	}

	/** Downloads `url` to `file`, telling progress; the size, MD5 and Google's hash header of what came. */
	private async download(
		url: string,
		file: string,
		signal: AbortSignal,
	): Promise<{ received: number; md5: string; goog: string | null }> {
		const at = new URL(url);
		const allowed =
			(at.protocol === "https:" && at.host === DOWNLOAD_HOST) ||
			(this.sources.test !== null && at.origin === this.sources.test);
		if (!allowed) throw new JobError(`Not a download address: ${at.host}`);
		const idle = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const rearm = () => {
			clearTimeout(timer);
			timer = setTimeout(() => idle.abort(), this.opts.idleMs ?? IDLE_MS);
		};
		const both = AbortSignal.any([signal, idle.signal]);
		const out = Bun.file(file).writer();
		const md5 = createHash("md5");
		let received = 0;
		try {
			rearm();
			const res = await this.fetcher(url, { signal: both, redirect: "error" });
			if (!res.ok || !res.body) throw new JobError(`The download answered ${res.status}`);
			const length = Number(res.headers.get("content-length"));
			const total = Number.isFinite(length) && length > 0 ? length : 0;
			if (this.job) this.job = { ...this.job, total };
			for await (const chunk of res.body) {
				rearm();
				received += chunk.byteLength;
				if (total && received > total) throw new JobError("The download is longer than it was said to be");
				md5.update(chunk);
				out.write(chunk);
				this.progress(received);
			}
			await out.end();
			if (total && received !== total) throw new JobError("The download ended early");
			return { received, md5: md5.digest("base64"), goog: res.headers.get("x-goog-hash") };
		} catch (e) {
			await Promise.resolve(out.end()).catch(() => {});
			if (signal.aborted) throw new Cancelled();
			if (e instanceof JobError) throw e;
			throw new JobError(idle.signal.aborted ? "The download stalled" : "The download failed (network)");
		} finally {
			clearTimeout(timer);
		}
	}

	private progress(received: number): void {
		if (!this.job) return;
		this.job = { ...this.job, received };
		const now = Date.now();
		if (now - this.lastProgressAt < PROGRESS_MS && received !== this.job.total) return;
		this.lastProgressAt = now;
		this.emit();
	}

	// ------------------------------------------------------------------ files

	private read(): Current {
		try {
			return JSON.parse(readFileSync(join(this.opts.root, "current.json"), "utf8")) as Current;
		} catch {
			return {};
		}
	}

	private write(next: Current): void {
		this.current = next;
		mkdirSync(this.opts.root, { recursive: true });
		const file = join(this.opts.root, "current.json");
		writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
		renameSync(`${file}.tmp`, file);
	}

	/** What a job that did not finish left: downloads and unpacked parts. */
	private removeLeftovers(): void {
		const dir = join(this.opts.root, "cft");
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir))
			if (name.endsWith(".download") || name.endsWith(".part"))
				rmSync(join(dir, name), { recursive: true, force: true });
	}

	/**
	 * Leftovers, and CfT versions other than the current one and the one an automatic update downloaded (nothing runs them:
	 * the server starts CfT).
	 */
	private prune(): void {
		this.removeLeftovers();
		const dir = join(this.opts.root, "cft");
		if (!existsSync(dir)) return;
		const keep = new Set([this.current.cft?.version, this.current.cftNext?.version]);
		for (const name of readdirSync(dir)) if (!keep.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
	}

	private emit(): void {
		this.rev++;
		for (const fn of [...this.listeners]) fn();
	}
}

async function unpack(file: string, into: string, signal: AbortSignal): Promise<void> {
	rmSync(into, { recursive: true, force: true });
	mkdirSync(into, { recursive: true });
	const cmd = platform.id === "win32" ? ["tar", "-xf", file, "-C", into] : ["unzip", "-q", file, "-d", into];
	const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe", signal });
	const code = await proc.exited;
	if (signal.aborted) throw new Cancelled();
	if (code !== 0)
		throw new JobError(`Unpacking the download failed: ${(await new Response(proc.stderr).text()).trim()}`);
}

function words(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** The jobs a page may ask for: Chrome for Testing's all; CEF, which the Mac app ships and updates with itself, only Clear. */
const ACTIONS: Record<EngineKind, readonly string[]> = {
	cft: ["check", "install", "cancel", "clear", "uninstall"],
	cef: ["clear"],
};

/**
 * `GET /api/browser` (the state, to any page the server lets in) and `POST /api/browser/{check,install,cancel,clear,uninstall}`
 * (`ACTIONS`; only to a page `canManageBrowser` allows, decided from the request's own authentication).
 */
export async function handleBrowserRoute(
	req: Request,
	url: URL,
	inst: BrowserInstaller,
	who: { remote: RemoteIdentity | null; local: boolean },
): Promise<Response> {
	const canManage = canManageBrowser(who.remote, who.local);
	if (url.pathname === "/api/browser") {
		return req.method === "GET" ? json(inst.state(canManage)) : json({ error: "GET required" }, 405);
	}
	const action = url.pathname.slice("/api/browser/".length);
	if (!ACTIONS[inst.engine].includes(action)) return json({ error: "Not found" }, 404);
	if (req.method !== "POST") return json({ error: "POST required" }, 405);
	if (!canManage)
		return json(
			{
				error:
					"The browser is installed, updated, cleared and uninstalled from this computer, or from a page signed in with your account",
				problem: BROWSER_NOT_HERE,
			},
			403,
		);
	switch (action) {
		case "check":
			await inst.check();
			return json(inst.state(true));
		case "install":
			void inst.install();
			return json(inst.state(true), 202);
		case "cancel":
			inst.cancel();
			return json(inst.state(true));
		case "uninstall":
			void inst.uninstall();
			return json(inst.state(true), 202);
		default:
			void inst.clear();
			return json(inst.state(true), 202);
	}
}
