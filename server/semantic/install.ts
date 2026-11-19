import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SemanticFailure } from "../../shared/semantic.ts";
import { run } from "../omp/run.ts";
import { platformId } from "../platform/capabilities.ts";
import { download, freeSpace, UpdateCancelled, UpdateError } from "../update/steps.ts";
import { tarCommand } from "../update/windows.ts";
import { type Asset, downloadHostAllowed, LLAMA_BUILD, MODEL, type RuntimeAsset, runtimeAsset } from "./assets.ts";

/**
 * Getting semantic search's files in place under `<data dir>/semantic/`:
 *
 * - `runtime-<build>/` the llama.cpp build, unpacked, with `llama-server` at its top.
 * - `model/<name>` the model file.
 *
 * Each is downloaded to `downloads/`, checked against its size and SHA-256 as it arrives (`download`, the app updater's), and
 * only then unpacked or moved in. What is already in place is not downloaded again: a download cut short (the app quit, the
 * network went) is begun again from the start of that file the next time.
 */

export class SemanticInstallError extends Error {
	constructor(readonly failure: SemanticFailure) {
		super(`${failure.code}${failure.detail ? `: ${failure.detail}` : ""}`);
	}
}

export interface Installed {
	/** `llama-server` (`llama-server.exe` on Windows). */
	server: string;
	model: string;
}

export interface InstallOptions {
	signal: AbortSignal;
	/** The bytes downloaded so far, of all there are to download in this install. */
	onProgress(received: number, total: number): void;
	/** A test's: the build and the model to get (and the build's name, which its folder is named by), and how. */
	runtime?: RuntimeAsset | null;
	build?: string;
	model?: Asset;
	fetch?: typeof fetch;
	/** What `freeSpace` says of the folder (a test's). */
	freeBytes?: (dir: string) => number | null;
}

const SERVER_NAME = platformId === "win32" ? "llama-server.exe" : "llama-server";

export function runtimeDir(dir: string, build: string = LLAMA_BUILD): string {
	return join(dir, `runtime-${build}`);
}

export function modelPath(dir: string, model: Asset = MODEL): string {
	return join(dir, "model", model.name);
}

/** What is installed in `dir`, or null while it is not all there. */
export function installed(dir: string, model: Asset = MODEL, build: string = LLAMA_BUILD): Installed | null {
	const server = join(runtimeDir(dir, build), SERVER_NAME);
	const file = modelPath(dir, model);
	try {
		if (!lstatSync(server).isFile()) return null;
		const m = lstatSync(file);
		if (!m.isFile() || m.size !== model.size) return null;
	} catch {
		return null;
	}
	return { server, model: file };
}

/** The bytes the downloads come to for this computer: the build and the model. */
export function downloadBytes(runtime: RuntimeAsset | null = runtimeAsset(), model: Asset = MODEL): number {
	return (runtime?.size ?? 0) + model.size;
}

export async function install(dir: string, opts: InstallOptions): Promise<Installed> {
	const runtime = opts.runtime === undefined ? runtimeAsset() : opts.runtime;
	if (!runtime) throw new SemanticInstallError({ code: "unsupported", detail: `${platformId}-${process.arch}` });
	const model = opts.model ?? MODEL;
	const build = opts.build ?? LLAMA_BUILD;
	const runtimeHere = existsSync(join(runtimeDir(dir, build), SERVER_NAME));
	const modelHere = (() => {
		try {
			return lstatSync(modelPath(dir, model)).size === model.size;
		} catch {
			return false;
		}
	})();
	const todo: Asset[] = [...(runtimeHere ? [] : [runtime]), ...(modelHere ? [] : [model])];
	const total = todo.reduce((n, a) => n + a.size, 0);
	const downloads = join(dir, "downloads");
	mkdirSync(downloads, { recursive: true });
	// The downloads, and the unpacked build (a few times its archive).
	const needed = total + (runtimeHere ? 0 : runtime.size * 4) + 64 * 1024 * 1024;
	const free = (opts.freeBytes ?? freeSpace)(dir);
	if (todo.length && free !== null && free < needed)
		throw new SemanticInstallError({ code: "space", detail: `${needed}/${free}` });

	let done = 0;
	opts.onProgress(0, total);
	try {
		for (const asset of todo) {
			const file = join(downloads, asset.name);
			await fetchAsset(asset, file, opts, (received) => opts.onProgress(done + received, total));
			done += asset.size;
			if (asset === model) {
				mkdirSync(dirname(modelPath(dir, model)), { recursive: true });
				renameSync(file, modelPath(dir, model));
			} else {
				await unpack(runtime, file, runtimeDir(dir, build));
				rmSync(file, { force: true });
			}
		}
	} finally {
		rmSync(downloads, { recursive: true, force: true });
	}
	const ready = installed(dir, model, build);
	if (!ready) throw new SemanticInstallError({ code: "unpack", detail: SERVER_NAME });
	removeStale(dir, model, build);
	return ready;
}

/**
 * What an install left that nothing uses: the unpacked builds of other versions (`runtime-<other build>/`), an unpack
 * that was cut short (`runtime-<build>.unpack-<id>/`: the process ended before its `finally`), and model files of other
 * names. Only those two places are looked at, and only when the current build and model are all there (a folder that
 * cannot be removed, an exe Windows still runs, is left for the next time) (#210).
 */
export function removeStale(dir: string, model: Asset = MODEL, build: string = LLAMA_BUILD): void {
	if (!installed(dir, model, build)) return;
	const current = `runtime-${build}`;
	const sweep = (folder: string, keep: string, only: (name: string) => boolean): void => {
		let names: string[];
		try {
			names = readdirSync(folder);
		} catch {
			return;
		}
		for (const name of names) {
			if (name === keep || !only(name)) continue;
			try {
				rmSync(join(folder, name), { recursive: true, force: true });
			} catch {
				// In use or not ours to remove: left, and looked at again by the next install or start.
			}
		}
	};
	sweep(dir, current, (name) => name.startsWith("runtime-"));
	sweep(join(dir, "model"), model.name, () => true);
}

/** `asset` to `file`, from the first of its addresses that gives all of it as listed. */
async function fetchAsset(
	asset: Asset,
	file: string,
	opts: InstallOptions,
	onProgress: (received: number) => void,
): Promise<void> {
	let last: unknown = null;
	for (const url of asset.urls) {
		try {
			await download({
				url,
				dest: file,
				size: asset.size,
				sha256: asset.sha256,
				signal: opts.signal,
				onProgress,
				allowRedirect: downloadHostAllowed,
				...(opts.fetch ? { fetch: opts.fetch } : {}),
			});
			return;
		} catch (e) {
			if (e instanceof UpdateCancelled) throw e;
			last = e;
			onProgress(0);
		}
	}
	if (last instanceof UpdateError) {
		if (last.code === "size" || last.code === "digest")
			throw new SemanticInstallError({ code: "verify", detail: asset.name });
		const p = last.params as Record<string, unknown>;
		const why = [p.reason, p.status ?? p.host].filter((v) => v !== undefined).join(" ");
		throw new SemanticInstallError({ code: "download", detail: `${asset.name}${why ? ` (${why})` : ""}` });
	}
	throw new SemanticInstallError({ code: "download", detail: asset.name });
}

/** A member's name that unpacks inside the folder: relative, with no `..` in it. */
export function memberSafe(name: string): boolean {
	if (name === "" || name.includes("\0")) return false;
	const path = name.replace(/\\/g, "/");
	if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
	return !path.split("/").some((s) => s === "..");
}

/**
 * Everything under `root` is a folder, a file, or a link to something under `root` (the builds link their libraries'
 * versioned names to one another): no link that leads out of it, nothing else.
 */
export function treeContained(root: string, dir: string = root): boolean {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const st = lstatSync(path);
		if (st.isDirectory()) {
			if (!treeContained(root, path)) return false;
		} else if (st.isSymbolicLink()) {
			const target = readlinkSync(path);
			if (isAbsolute(target)) return false;
			const to = relative(root, resolve(dirname(path), target));
			if (to === "" || to.startsWith("..") || isAbsolute(to)) return false;
		} else if (!st.isFile()) {
			return false;
		}
	}
	return true;
}

/**
 * The build's archive unpacked into `dest`: listed first (every member must stay inside), unpacked into a fresh folder beside
 * it, checked again as it is on disk, and then moved in. Its files are at the top of `dest` whether the archive has them in
 * one folder (the macOS and Linux builds) or not (Windows').
 */
async function unpack(runtime: RuntimeAsset, archive: string, dest: string): Promise<void> {
	const tar = runtime.kind === "zip" ? tarCommand() : "tar";
	const list = await run([tar, runtime.kind === "zip" ? "-tf" : "-tzf", archive], { timeoutMs: 120_000 }).catch(
		(e: Error) => ({ code: 1, stdout: "", stderr: e.message }),
	);
	const names = list.stdout
		.split("\n")
		.map((l) => l.replace(/\r$/, ""))
		.filter(Boolean);
	if (list.code !== 0 || names.length === 0 || !names.every(memberSafe))
		throw new SemanticInstallError({ code: "unpack", detail: (list.stderr.trim().split("\n")[0] ?? "").slice(0, 200) });
	const work = `${dest}.unpack-${randomUUID().slice(0, 8)}`;
	mkdirSync(work, { recursive: true });
	try {
		const out = await run([tar, runtime.kind === "zip" ? "-xf" : "-xzf", archive, "-C", work], {
			timeoutMs: 300_000,
		}).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
		if (out.code !== 0)
			throw new SemanticInstallError({
				code: "unpack",
				detail: (out.stderr.trim().split("\n")[0] ?? "").slice(0, 200),
			});
		if (!treeContained(work)) throw new SemanticInstallError({ code: "unpack", detail: "link outside the archive" });
		const top = readdirSync(work);
		const only = top.length === 1 ? join(work, top[0] as string) : null;
		const root = only && lstatSync(only).isDirectory() ? only : work;
		const server = join(root, SERVER_NAME);
		if (!existsSync(server) || !lstatSync(server).isFile())
			throw new SemanticInstallError({ code: "unpack", detail: SERVER_NAME });
		if (platformId !== "win32") chmodSync(server, 0o755);
		rmSync(dest, { recursive: true, force: true });
		renameSync(root, dest);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
