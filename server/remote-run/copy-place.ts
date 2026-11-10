import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, link, lstat, mkdir, rename, rm, rmdir, stat, unlink, utimes } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { RemoteCopyError } from "../../shared/remote-copy.ts";
import { inside } from "../folder.ts";
import { platformId } from "../platform/capabilities.ts";
import { diskSpace, type Limits, leavesRoom, realHome } from "../transfer-core.ts";
import { realAsFarAsItGoes } from "../upload.ts";
import { fsFailure } from "./tar.ts";

/**
 * Where a copy of `remote_copy` is put, on either computer (`shared/remote-copy.ts`): this one's for a copy `from` another, the
 * other's (`files.ts`) for one `to` it. The same rules on both sides:
 *
 *  - Never the root, the home folder or a folder that holds it (`broad`), nor in or around a folder an omp-webui keeps its
 *    own data in (`ownData`), whatever `overwrite` says.
 *  - Nothing that is there is replaced unless `overwrite` (`exists`); with it, a file or a folder is replaced whole: a folder
 *    by the folder copied, never merged into it (what was in it and is not in the copy is gone).
 *  - Those are told by what a folder is (its device and inode), not by how its path is spelt: on a volume without case
 *    (APFS, NTFS) `~/../HOME` is the home folder. Where the target is not there yet, its path is compared too, without case
 *    on macOS and Windows.
 *  - The missing folders above it are made, once the disk is known to have room; a copy that fails removes the ones it made.
 *    What arrives is written beside it under a hidden name (`.ompw-copy-<hex>`) and moved into place only once it is whole
 *    and checked (`publish`), by a move that never replaces what came there meanwhile (`placeNew`); a copy that fails or is
 *    cancelled is removed and leaves nothing at the target.
 *  - The disk keeps what an upload keeps free (`leavesRoom`: 1 GiB / 5 % unless told otherwise).
 */

export interface Places {
	/** The home folder of the person the server runs as: what `~` is, and what is never replaced. */
	home: string;
	/** Every folder an omp-webui keeps its data in (this server's first): nothing is written in or around one. */
	dataDirs: readonly string[];
}

export type Reserve = Pick<Limits, "reserveBytes" | "reservePercent">;

/** Free space and size of the disk at a path (tests give a full one). */
export type SpaceOf = (path: string) => Promise<{ free: number; total: number }>;

/** A path as a call or a request names it: `~` and `~/…` in `home`, a relative one in `base`, an absolute one as it is. */
export function placeOf(given: string, home: string, base: string): string {
	if (given === "~") return resolve(home);
	if (given.startsWith("~/")) return resolve(home, given.slice(2));
	return resolve(base, given);
}

/** What is at `abs` itself (a link is not followed), or null when nothing is. */
async function there(abs: string): Promise<Stats | null> {
	try {
		return await lstat(abs);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		if (code === "ENOTDIR") throw new RemoteCopyError(`A part of ${abs} is a file, not a folder`, "parentNotFolder");
		throw fsFailure(e, abs);
	}
}

/** A path as a file system without case compares it (macOS's and Windows' usual volumes); as it is elsewhere. */
const fold = (p: string): string => (platformId === "darwin" || platformId === "win32" ? p.toLowerCase() : p);

/** What is at `p` (a link followed, unless `own`), as its device and inode; null when nothing is. */
async function idOf(p: string, own = false): Promise<string | null> {
	try {
		const s = own ? await lstat(p, { bigint: true }) : await stat(p, { bigint: true });
		return `${s.dev}:${s.ino}`;
	} catch {
		return null;
	}
}

/** What `real` is and every folder above it is, as far as they are there. */
async function chain(real: string): Promise<Set<string>> {
	const ids = new Set<string>();
	for (let p = real; ; p = dirname(p)) {
		const id = await idOf(p);
		if (id !== null) ids.add(id);
		if (dirname(p) === p) return ids;
	}
}

/**
 * Whether something may be put at `abs`: throws why not (`broad`, `ownData`, `exists`, `parentNotFolder`), else answers what is
 * there now (null: nothing).
 */
export async function checkTarget(abs: string, overwrite: boolean, places: Places): Promise<Stats | null> {
	// Where the target itself is, a link at it not followed: the real folder it is in, and its name.
	const parent = await realAsFarAsItGoes(dirname(abs));
	const real = join(parent, basename(abs));
	// The target itself (a link is itself, not what it leads to: replacing it replaces the link), and what it would be in.
	const self = await idOf(abs, true);
	const above = await chain(parent);
	const home = realHome(places.home);
	if (dirname(real) === real || (self !== null && (await chain(home)).has(self)) || inside(fold(real), fold(home)))
		throw new RemoteCopyError(`${abs} is the home folder or holds it: copy into a folder inside it instead`, "broad");
	for (const dir of places.dataDirs) {
		const data = await realAsFarAsItGoes(dir);
		const dataId = await idOf(data);
		const inData = (dataId !== null && (above.has(dataId) || self === dataId)) || inside(fold(data), fold(real));
		const holdsData = (self !== null && (await chain(data)).has(self)) || inside(fold(real), fold(data));
		if (inData || holdsData)
			throw new RemoteCopyError(`${abs} is where an omp-webui keeps its own data: nothing is copied there`, "ownData");
	}
	const existing = await there(abs);
	if (existing && !overwrite) throw new RemoteCopyError(`${abs} exists: pass overwrite: true to replace it`, "exists");
	return existing;
}

/** Make the folders above `abs` that are not there; answers the first one made (undefined: none was), for `unmake`. */
export async function makeParent(abs: string): Promise<string | undefined> {
	try {
		return await mkdir(dirname(abs), { recursive: true });
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOTDIR" || code === "EEXIST")
			throw new RemoteCopyError(`A part of ${dirname(abs)} is a file, not a folder`, "parentNotFolder");
		throw fsFailure(e, dirname(abs));
	}
}

/** Remove the folders `makeParent` made above `abs` (up to `made`), as far as they are empty: a copy that failed leaves none. */
export async function unmake(abs: string, made: string | undefined): Promise<void> {
	if (made === undefined) return;
	for (let d = dirname(abs); inside(made, d); d = dirname(d)) {
		try {
			await rmdir(d);
		} catch {
			return;
		}
		if (d === made) return;
	}
}

/**
 * Throws `diskFull` when writing `size` bytes in `dir` would leave its disk less than `reserve` asks; asked of the nearest
 * folder of it that is there, before any is made.
 */
export async function ensureRoom(
	dir: string,
	size: number,
	reserve: Reserve,
	spaceOf: SpaceOf = diskSpace,
): Promise<void> {
	let at = dir;
	while ((await idOf(at)) === null && dirname(at) !== at) at = dirname(at);
	if (!leavesRoom(await spaceOf(at), size, reserve))
		throw new RemoteCopyError(`There is not enough room on the disk for ${dir}`, "diskFull");
}

/** The hidden name beside `abs` that a copy is written under until it is whole. */
export const stagedBeside = (abs: string, what = "copy"): string =>
	join(dirname(abs), `.ompw-${what}-${randomBytes(12).toString("hex")}`);

/** The permission bits and time a copy's file or folder itself is given, when they are known. */
export async function applyTop(abs: string, mode: number | null, mtime: number | null, folder: boolean): Promise<void> {
	if (mode !== null) await chmod(abs, folder ? (mode & 0o777) | 0o700 : mode & 0o777);
	if (mtime !== null) await utimes(abs, mtime, mtime);
}

/**
 * Move `staged` to `abs`, where nothing is, without ever replacing what came there since it was looked at (`rename` would):
 * a file by a hard link made at `abs` (which the system refuses when the name is taken) and the staged name then removed; a
 * folder by making `abs` as an empty folder first (refused when taken) and moving the staged one onto that empty one, which
 * the system refuses once anything has been put in it. Only on a volume without hard links (FAT, some network shares) is a
 * file moved after one last look, with a moment in which a file made there would be replaced; on Windows, which moves no
 * folder onto another, so is a folder (a folder made there meanwhile refuses it).
 */
export async function placeNew(staged: string, abs: string): Promise<void> {
	const taken = () => new RemoteCopyError(`${abs} exists: pass overwrite: true to replace it`, "exists");
	const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
	// Windows moves no folder onto another, empty or not: there it is moved after one last look.
	if (platformId === "win32" && (await lstat(staged)).isDirectory()) {
		if (await there(abs)) throw taken();
		await rename(staged, abs).catch((err) =>
			Promise.reject(code(err) === "EEXIST" || code(err) === "EPERM" ? taken() : fsFailure(err, abs)),
		);
		return;
	}
	if ((await lstat(staged)).isDirectory()) {
		try {
			await mkdir(abs);
		} catch (e) {
			throw code(e) === "EEXIST" ? taken() : fsFailure(e, abs);
		}
		try {
			await rename(staged, abs);
		} catch (e) {
			await rmdir(abs).catch(() => {});
			throw code(e) === "ENOTEMPTY" || code(e) === "EEXIST" ? taken() : fsFailure(e, abs);
		}
		return;
	}
	try {
		await link(staged, abs);
	} catch (e) {
		if (code(e) === "EEXIST") throw taken();
		if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK", "ENOSYS"].includes(code(e) ?? ""))
			throw fsFailure(e, abs);
		if (await there(abs)) throw taken();
		await rename(staged, abs).catch((err) => Promise.reject(fsFailure(err, abs)));
		return;
	}
	await unlink(staged);
}

/**
 * Move `staged` (whole and checked) to `abs` (`placeNew`). With `overwrite`, what is there is moved aside first, and removed
 * once the copy is in place (put back if the copy could not be); without it, something that came there meanwhile refuses it.
 * Answers whether something was replaced.
 */
export async function publish(staged: string, abs: string, overwrite: boolean): Promise<boolean> {
	const existing = await there(abs);
	if (existing && !overwrite) throw new RemoteCopyError(`${abs} exists: pass overwrite: true to replace it`, "exists");
	if (!existing) {
		await placeNew(staged, abs);
		return false;
	}
	const aside = stagedBeside(abs, "old");
	await rename(abs, aside).catch((e) => Promise.reject(fsFailure(e, abs)));
	try {
		await placeNew(staged, abs);
	} catch (e) {
		await rename(aside, abs).catch(() => {});
		throw e;
	}
	// What was replaced: a folder of the person's that cannot all be removed (a read-only one) is left under its hidden name.
	await rm(aside, { recursive: true, force: true }).catch(() => {});
	return true;
}

/** Remove what a copy that did not finish wrote. */
export async function discard(staged: string): Promise<void> {
	await rm(staged, { recursive: true, force: true }).catch(() => {});
}
