import { accessSync, constants, existsSync, rmSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UpdateFailure, UpdateFailureCode } from "../../shared/update.ts";
import { run } from "../omp/run.ts";
import { redirectAllowed } from "./release.ts";

/**
 * The steps of an install that touch the outside: downloading the installer, mounting it, copying the app out of it.
 * Each one that can fail says why as an `UpdateError`, which the install turns into the sentence the page shows.
 */

/** An install that stops here, and why (`UpdateFailure` without the release: the install knows it). */
export class UpdateError extends Error {
	constructor(
		readonly code: UpdateFailureCode,
		readonly params: UpdateFailure["params"] = {},
	) {
		super(`${code} ${JSON.stringify(params)}`);
	}
}

/** The user cancelled: not a failure to show. */
export class UpdateCancelled extends Error {
	constructor() {
		super("cancelled");
	}
}

const COMMAND_MS = 120_000;

export interface DownloadOptions {
	url: string;
	/** Where the bytes go. */
	dest: string;
	/** What the release lists: the installer's size, and its SHA-256 when GitHub lists one. */
	size: number;
	sha256: string | null;
	signal: AbortSignal;
	onProgress(received: number): void;
	/** The longest the download may go without a byte before it is given up on. */
	idleMs?: number;
	fetch?: typeof fetch;
}

/** Redirects followed for one download: GitHub's asset address answers with one, and one more is allowed for the storage's. */
const MAX_REDIRECTS = 3;

/**
 * `url`, with redirects followed here and not by `fetch`: each place a redirect names must be one of GitHub's (`redirectAllowed`),
 * or the download is refused. The first address was checked when the release was read; what an answer sends the download on to
 * is not, and bytes from anywhere else would be parsed by `hdiutil` before the signature is looked at.
 */
async function fetchPinned(url: string, signal: AbortSignal, fetcher: typeof fetch): Promise<Response> {
	let at = url;
	for (let hops = 0; ; hops++) {
		const res = await fetcher(at, { signal, redirect: "manual" });
		if (res.status < 300 || res.status >= 400) return res;
		const location = res.headers.get("location");
		await res.body?.cancel().catch(() => {});
		let next: URL | null = null;
		try {
			next = location === null ? null : new URL(location, at);
		} catch {
			// not an address
		}
		if (next === null || hops >= MAX_REDIRECTS || !redirectAllowed(next)) {
			throw new UpdateError("download", { reason: "redirect", host: next?.host || "?" });
		}
		at = next.href;
	}
}

/**
 * Download the installer to `dest`, counting and hashing as it comes. It is the size the release lists and, when one is
 * listed, the SHA-256 GitHub computed: a short, long or damaged file is refused here, before anything opens it.
 */
export async function download(opts: DownloadOptions): Promise<void> {
	const idle = new AbortController();
	let idleTimer: NodeJS.Timeout | undefined;
	const rearm = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => idle.abort(), opts.idleMs ?? 30_000);
	};
	const signal = AbortSignal.any([opts.signal, idle.signal]);
	const out = Bun.file(opts.dest).writer();
	const hash = new Bun.CryptoHasher("sha256");
	let received = 0;
	try {
		rearm();
		let res: Response;
		try {
			res = await fetchPinned(opts.url, signal, opts.fetch ?? fetch);
		} catch (e) {
			if (e instanceof UpdateError) throw e;
			if (opts.signal.aborted) throw new UpdateCancelled();
			throw new UpdateError("download", { reason: idle.signal.aborted ? "stalled" : "network" });
		}
		if (!res.ok || !res.body) throw new UpdateError("download", { reason: "http", status: res.status });
		const length = Number(res.headers.get("content-length"));
		if (res.headers.has("content-length") && Number.isFinite(length) && length !== opts.size) {
			throw new UpdateError("size", { expected: opts.size, actual: length });
		}
		try {
			for await (const chunk of res.body) {
				rearm();
				received += chunk.byteLength;
				if (received > opts.size) throw new UpdateError("size", { expected: opts.size, actual: received });
				hash.update(chunk);
				out.write(chunk);
				opts.onProgress(received);
			}
		} catch (e) {
			if (e instanceof UpdateError) throw e;
			if (opts.signal.aborted) throw new UpdateCancelled();
			throw new UpdateError("download", { reason: idle.signal.aborted ? "stalled" : "network" });
		}
		await out.end();
		if (received !== opts.size) throw new UpdateError("size", { expected: opts.size, actual: received });
		const actual = hash.digest("hex");
		if (opts.sha256 !== null && actual !== opts.sha256) {
			throw new UpdateError("digest", { expected: opts.sha256, actual });
		}
	} catch (e) {
		try {
			await out.end();
		} catch {
			// the file is removed next
		}
		rmSync(opts.dest, { force: true });
		throw e;
	} finally {
		clearTimeout(idleTimer);
	}
}

/** The first line of a failed command's output. */
export function detailOf(r: { stderr: string; stdout: string; code: number }): string {
	const line = `${r.stderr}\n${r.stdout}`
		.split("\n")
		.map((l) => l.trim())
		.find(Boolean);
	return (line ?? `exit ${r.code}`).slice(0, 300);
}

/** Mount the disk image read-only at `mountpoint` (an empty folder): nothing on it can be changed, and Finder never shows it. */
export async function attach(dmg: string, mountpoint: string): Promise<void> {
	const argv = [
		"/usr/bin/hdiutil",
		"attach",
		dmg,
		"-readonly",
		"-nobrowse",
		"-noautoopen",
		"-mountpoint",
		mountpoint,
		"-quiet",
	];
	const r = await run(argv, { timeoutMs: COMMAND_MS }).catch((e: Error) => ({
		code: 1,
		stdout: "",
		stderr: e.message,
	}));
	if (r.code !== 0) throw new UpdateError("mount", { detail: detailOf(r) });
}

/** Unmount it; one that is busy is forced after a second try. Never throws: it runs in the cleanup of every install. */
export async function detach(mountpoint: string): Promise<void> {
	if (!existsSync(mountpoint)) return;
	for (const force of [false, true]) {
		const argv = ["/usr/bin/hdiutil", "detach", mountpoint, "-quiet", ...(force ? ["-force"] : [])];
		const r = await run(argv, { timeoutMs: COMMAND_MS }).catch(() => ({ code: 1 }));
		if (r.code === 0) return;
	}
}

/** The bytes the app in the image takes, as `du` counts them. */
async function sizeOf(path: string): Promise<number> {
	const r = await run(["/usr/bin/du", "-sk", path], { timeoutMs: COMMAND_MS });
	return Number(r.stdout.split(/\s/)[0]) * 1024 || 0;
}

/** Whether this user can add and rename things in `dir` (what a swap of the app in it needs). */
export function writable(dir: string): boolean {
	try {
		accessSync(dir, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** The bytes free for this user on the volume of `dir`; null where the file system cannot say (that is no reason to refuse). */
export function freeSpace(dir: string): number | null {
	try {
		const info = statfsSync(dir);
		return info.bavail * info.bsize;
	} catch {
		return null;
	}
}

/**
 * Copy `<mounted>/<name>` to `dest` (next to the installed app, so that the swap is a rename on one volume): `ditto` keeps
 * the signature, links and attributes as they are, and the quarantine mark macOS puts on what comes from the internet is
 * taken off — the one place an app of ours is opened without Gatekeeper's question, because the signature was checked
 * against the running app's first (see `refusalOf`).
 */
export async function stage(
	mounted: string,
	name: string,
	dest: string,
	freeBytes: (dir: string) => number | null = freeSpace,
): Promise<void> {
	const source = join(mounted, name);
	if (!existsSync(join(source, "Contents", "Info.plist"))) throw new UpdateError("noApp", { name });
	const dir = dirname(dest);
	if (!writable(dir)) throw new UpdateError("notWritable", { dir });
	const needed = Math.ceil((await sizeOf(source)) * 1.1) + 10 * 1024 * 1024;
	const free = freeBytes(dir);
	if (free !== null && free < needed) throw new UpdateError("space", { needed, free });
	rmSync(dest, { recursive: true, force: true });
	const copied = await run(["/usr/bin/ditto", source, dest], { timeoutMs: COMMAND_MS }).catch((e: Error) => ({
		code: 1,
		stdout: "",
		stderr: e.message,
	}));
	if (copied.code !== 0) {
		rmSync(dest, { recursive: true, force: true });
		throw new UpdateError("stage", { detail: detailOf(copied) });
	}
	await run(["/usr/bin/xattr", "-dr", "com.apple.quarantine", dest], { timeoutMs: COMMAND_MS }).catch(() => {});
}
