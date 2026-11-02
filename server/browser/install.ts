import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_NOT_HERE, type BrowserJobKind, type BrowserState, type EngineKind } from "../../shared/browser.ts";
import { platform } from "../platform/index.ts";
import type { RemoteIdentity } from "../remote-auth.ts";
import { canManageBrowser } from "./gate.ts";

/**
 * Installing, updating and clearing the built-in browser's engine, in `<dataDir>/browser/`:
 *
 * - `cft/<version>/`: Chrome for Testing, the engine of a server that runs alone. Its newest Stable comes from Google's
 *   version list; the zip's size and MD5 are the ones Google's storage answers with.
 * - `cef/<version>/`: the CEF minimal build the Mac app loads. The newest stable build of CEF's index whose
 *   `include/cef_api_versions.h` lists the API version the app was built against (`CEF_API_VERSION`); size and SHA-1 are
 *   the index's. A build without it is remembered and passed over for the next older one.
 * - `cft-profile/`, `cef-profile/`: each engine's own profile (logins, cookies, storage).
 * - `current.json`: what is installed, and a clear of CEF's profile the app does at its next start.
 *
 * A download goes to `<version>.download`, is checked, unpacked into `<version>.part` and renamed into place: nothing
 * half-made is ever taken for an install, and what a failed or cancelled job left is removed.
 */

export const CFT_VERSIONS_URL =
	"https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
export const CEF_INDEX_URL = "https://cef-builds.spotifycdn.com/index.json";
const CEF_FILES = "https://cef-builds.spotifycdn.com/";
/** Where engine downloads may come from: Google's storage for CfT, CEF's build server. */
const DOWNLOAD_HOSTS = new Set(["storage.googleapis.com", "cef-builds.spotifycdn.com"]);

/** The CEF API version the Mac app is built against (`CEF_API_VERSION`, macos/cef): a build must list it. */
export const CEF_API_VERSION = 15600;

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
	cef?: { version: string };
	/** CEF's profile is deleted by the app before CEF starts again. */
	clearPending?: boolean;
	/** CEF builds found not to list `CEF_API_VERSION`: not offered again. */
	cefIncompatible?: string[];
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
	hooks?: BrowserHooks;
	idleMs?: number;
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
	private current: Current;
	private rev = 0;
	private latest: string | null = null;
	private job: BrowserState["job"] = null;
	private error: string | null = null;
	private restartNeeded = false;
	private abort: AbortController | null = null;
	private lastProgressAt = 0;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly opts: BrowserInstallerOptions) {
		this.fetcher = opts.fetch ?? fetch;
		this.platform = opts.cftPlatform === undefined ? cftPlatformHere() : opts.cftPlatform;
		this.override = opts.executableOverride ?? process.env.OMPW_BROWSER_EXECUTABLE ?? null;
		this.hooks = opts.hooks ?? {};
		this.current = this.read();
		this.prune();
	}

	get engine(): EngineKind {
		return this.opts.engine;
	}

	state(canManage: boolean): BrowserState {
		const installed = this.current[this.opts.engine];
		return {
			rev: this.rev,
			engine: this.opts.engine,
			installed: installed ? { version: installed.version } : null,
			latest: this.latest,
			job: this.job ? { ...this.job } : null,
			error: this.error,
			restartNeeded: this.restartNeeded,
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

	/** Looks up the newest version that would be installed. */
	async check(): Promise<void> {
		try {
			const signal = AbortSignal.timeout(this.opts.idleMs ?? IDLE_MS);
			this.latest =
				this.opts.engine === "cft"
					? (await this.cftRelease(signal)).version
					: ((await this.cefCandidates(signal))[0]?.version ?? null);
			if (!this.job) this.error = null;
		} catch (e) {
			if (!this.job) this.error = words(e);
		}
		this.emit();
	}

	/** Installs the newest version, or updates to it. Settles when the job ends (it never throws). */
	install(): Promise<void> {
		if (this.job) return Promise.resolve();
		const kind: BrowserJobKind = this.current[this.opts.engine] ? "update" : "install";
		return this.run(kind, async (signal) => {
			if (this.opts.engine === "cft") await this.installCft(signal);
			else await this.installCef(signal);
		});
	}

	cancel(): void {
		if (this.job?.kind !== "clear") this.abort?.abort();
	}

	/**
	 * Clears the engine's profile. CfT: stops it, deletes the profile, starts it again. CEF: the profile is open in the app,
	 * so the app deletes it at its next start, and is asked to restart now.
	 */
	clear(): Promise<void> {
		if (this.job) return Promise.resolve();
		return this.run("clear", async () => {
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

	// ------------------------------------------------------------------ jobs

	private async run(kind: BrowserJobKind, body: (signal: AbortSignal) => Promise<void>): Promise<void> {
		const abort = new AbortController();
		this.abort = abort;
		this.job = { kind, received: 0, total: 0 };
		this.error = null;
		this.emit();
		try {
			await body(abort.signal);
		} catch (e) {
			if (!(e instanceof Cancelled) && !abort.signal.aborted) this.error = words(e);
		} finally {
			this.removeLeftovers();
			this.abort = null;
			this.job = null;
			this.emit();
		}
	}

	private async installCft(signal: AbortSignal): Promise<void> {
		if (!this.platform) throw new JobError("Chrome for Testing is not built for this computer's system");
		const release = await this.cftRelease(signal);
		this.latest = release.version;
		const before = this.current.cft;
		if (before?.version === release.version && before.platform === this.platform) return;
		const dir = join(this.opts.root, "cft");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `${release.version}.download`);
		const got = await this.download(release.url, file, signal);
		const listed = /(?:^|,)\s*md5=([A-Za-z0-9+/=]+)/.exec(got.goog ?? "")?.[1];
		if (!listed) throw new JobError("Google's storage listed no checksum for Chrome for Testing");
		if (listed !== got.md5) throw new JobError("The Chrome for Testing download is damaged (checksum differs)");
		const part = join(dir, `${release.version}.part`);
		await unpack(file, part, "zip", signal);
		if (!existsSync(join(part, cftExecutable(this.platform))))
			throw new JobError("The Chrome for Testing download holds no Chrome");
		renameSync(part, join(dir, release.version));
		rmSync(file, { force: true });
		if (before) await this.hooks.stopEngine?.("The browser restarted for an update");
		this.write({ ...this.current, cft: { version: release.version, platform: this.platform } });
		if (before) {
			this.prune();
			await this.hooks.startEngine?.();
		}
	}

	private async installCef(signal: AbortSignal): Promise<void> {
		const candidates = await this.cefCandidates(signal);
		if (candidates.length === 0) throw new JobError(`No CEF build for this app (API version ${CEF_API_VERSION})`);
		this.latest = candidates[0].version;
		const dir = join(this.opts.root, "cef");
		mkdirSync(dir, { recursive: true });
		for (const build of candidates) {
			if (build.version === this.current.cef?.version) return;
			const file = join(dir, `${build.version}.download`);
			const got = await this.download(`${CEF_FILES}${encodeURIComponent(build.name)}`, file, signal, build.size);
			if (got.received !== build.size || got.sha1 !== build.sha1)
				throw new JobError("The CEF download is damaged (checksum differs)");
			const part = join(dir, `${build.version}.part`);
			await unpack(file, part, "tar.bz2", signal);
			rmSync(file, { force: true });
			const top = readdirSync(part).find((name) => name.startsWith("cef_binary_"));
			const header = top ? join(part, top, "include", "cef_api_versions.h") : null;
			const lists =
				header &&
				existsSync(header) &&
				new RegExp(`\\bCEF_API_VERSION_${CEF_API_VERSION}\\b`).test(readFileSync(header, "utf8"));
			if (!top || !lists) {
				rmSync(part, { recursive: true, force: true });
				this.write({ ...this.current, cefIncompatible: [...(this.current.cefIncompatible ?? []), build.version] });
				continue;
			}
			renameSync(join(part, top), join(dir, build.version));
			rmSync(part, { recursive: true, force: true });
			this.write({ ...this.current, cef: { version: build.version } });
			this.latest = build.version;
			this.restartNeeded = true;
			this.hooks.requestAppRestart?.();
			return;
		}
		throw new JobError(`No CEF build for this app (API version ${CEF_API_VERSION})`);
	}

	private async cftRelease(signal: AbortSignal): Promise<{ version: string; url: string }> {
		const res = await this.fetcher(CFT_VERSIONS_URL, { signal });
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

	/** The stable minimal macOS arm64 builds not known to lack the app's API version, newest first. */
	private async cefCandidates(
		signal: AbortSignal,
	): Promise<{ version: string; name: string; sha1: string; size: number }[]> {
		const res = await this.fetcher(CEF_INDEX_URL, { signal });
		if (!res.ok) throw new JobError(`CEF's build index answered ${res.status}`);
		const data = (await res.json()) as {
			macosarm64?: {
				versions?: {
					cef_version: string;
					channel: string;
					files: { type: string; name: string; sha1: string; size: number }[];
				}[];
			};
		};
		const skip = new Set(this.current.cefIncompatible ?? []);
		const out: { version: string; name: string; sha1: string; size: number }[] = [];
		for (const v of data.macosarm64?.versions ?? []) {
			if (v.channel !== "stable" || skip.has(v.cef_version)) continue;
			const minimal = v.files.find((f) => f.type === "minimal");
			if (minimal) out.push({ version: v.cef_version, name: minimal.name, sha1: minimal.sha1, size: minimal.size });
		}
		return out;
	}

	/** Downloads `url` to `file`, telling progress; the size, MD5, SHA-1 and Google's hash header of what came. */
	private async download(
		url: string,
		file: string,
		signal: AbortSignal,
		size?: number,
	): Promise<{ received: number; md5: string; sha1: string; goog: string | null }> {
		const at = new URL(url);
		if (at.protocol !== "https:" || !DOWNLOAD_HOSTS.has(at.host))
			throw new JobError(`Not a download address: ${at.host}`);
		const idle = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const rearm = () => {
			clearTimeout(timer);
			timer = setTimeout(() => idle.abort(), this.opts.idleMs ?? IDLE_MS);
		};
		const both = AbortSignal.any([signal, idle.signal]);
		const out = Bun.file(file).writer();
		const md5 = createHash("md5");
		const sha1 = createHash("sha1");
		let received = 0;
		try {
			rearm();
			const res = await this.fetcher(url, { signal: both, redirect: "error" });
			if (!res.ok || !res.body) throw new JobError(`The download answered ${res.status}`);
			const length = Number(res.headers.get("content-length"));
			const total = size ?? (Number.isFinite(length) && length > 0 ? length : 0);
			if (this.job) this.job = { ...this.job, total };
			for await (const chunk of res.body) {
				rearm();
				received += chunk.byteLength;
				if (total && received > total) throw new JobError("The download is longer than it was said to be");
				md5.update(chunk);
				sha1.update(chunk);
				out.write(chunk);
				this.progress(received);
			}
			await out.end();
			if (total && received !== total) throw new JobError("The download ended early");
			return { received, md5: md5.digest("base64"), sha1: sha1.digest("hex"), goog: res.headers.get("x-goog-hash") };
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
		for (const kind of ["cft", "cef"] as const) {
			const dir = join(this.opts.root, kind);
			if (!existsSync(dir)) continue;
			for (const name of readdirSync(dir))
				if (name.endsWith(".download") || name.endsWith(".part"))
					rmSync(join(dir, name), { recursive: true, force: true });
		}
	}

	/**
	 * Leftovers, and CfT versions other than the current one (nothing runs them: the server starts CfT). CEF's older
	 * versions are the app's to remove, before it loads CEF: one may be loaded in it now.
	 */
	private prune(): void {
		this.removeLeftovers();
		const dir = join(this.opts.root, "cft");
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir))
			if (name !== this.current.cft?.version) rmSync(join(dir, name), { recursive: true, force: true });
	}

	private emit(): void {
		this.rev++;
		for (const fn of [...this.listeners]) fn();
	}
}

async function unpack(file: string, into: string, kind: "zip" | "tar.bz2", signal: AbortSignal): Promise<void> {
	rmSync(into, { recursive: true, force: true });
	mkdirSync(into, { recursive: true });
	const cmd =
		kind === "tar.bz2"
			? ["tar", "xjf", file, "-C", into]
			: platform.id === "win32"
				? ["tar", "-xf", file, "-C", into]
				: ["unzip", "-q", file, "-d", into];
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

/**
 * `GET /api/browser` (the state, to any page the server lets in) and `POST /api/browser/{check,install,cancel,clear}`
 * (only to a page `canManageBrowser` allows, decided from the request's own authentication).
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
	if (!["check", "install", "cancel", "clear"].includes(action)) return json({ error: "Not found" }, 404);
	if (req.method !== "POST") return json({ error: "POST required" }, 405);
	if (!canManage)
		return json(
			{
				error:
					"The browser is installed, updated and cleared from this computer, or from a page signed in with your account",
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
		default:
			void inst.clear();
			return json(inst.state(true), 202);
	}
}
