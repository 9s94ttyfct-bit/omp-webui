import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, rename, rm, utimes } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { RemoteCopyError } from "../../shared/remote-copy.ts";
import { inside } from "../folder.ts";
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
 *  - The missing folders above it are made. What arrives is written beside it under a hidden name (`.ompw-copy-<hex>`) and
 *    moved into place only once it is whole and checked (`publish`); a copy that fails or is cancelled is removed and leaves
 *    nothing at the target.
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

/**
 * Whether something may be put at `abs`: throws why not (`broad`, `ownData`, `exists`, `parentNotFolder`), else answers what is
 * there now (null: nothing).
 */
export async function checkTarget(abs: string, overwrite: boolean, places: Places): Promise<Stats | null> {
	// Where the target itself is, a link at it not followed: the real folder it is in, and its name.
	const real = join(await realAsFarAsItGoes(dirname(abs)), basename(abs));
	if (dirname(real) === real || inside(real, realHome(places.home)))
		throw new RemoteCopyError(`${abs} is the home folder or holds it: copy into a folder inside it instead`, "broad");
	for (const dir of places.dataDirs) {
		const data = await realAsFarAsItGoes(dir);
		if (inside(data, real) || inside(real, data))
			throw new RemoteCopyError(`${abs} is where an omp-webui keeps its own data: nothing is copied there`, "ownData");
	}
	const existing = await there(abs);
	if (existing && !overwrite) throw new RemoteCopyError(`${abs} exists: pass overwrite: true to replace it`, "exists");
	return existing;
}

/** Make the folders above `abs` that are not there. */
export async function makeParent(abs: string): Promise<void> {
	try {
		await mkdir(dirname(abs), { recursive: true });
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOTDIR" || code === "EEXIST")
			throw new RemoteCopyError(`A part of ${dirname(abs)} is a file, not a folder`, "parentNotFolder");
		throw fsFailure(e, dirname(abs));
	}
}

/** Throws `diskFull` when writing `size` bytes in `dir` would leave its disk less than `reserve` asks. */
export async function ensureRoom(
	dir: string,
	size: number,
	reserve: Reserve,
	spaceOf: SpaceOf = diskSpace,
): Promise<void> {
	if (!leavesRoom(await spaceOf(dir), size, reserve))
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
 * Move `staged` (whole and checked) to `abs`. With `overwrite`, what is there is moved aside first, and removed once the copy
 * is in place (put back if the copy could not be); without it, something that came there meanwhile refuses it. Answers
 * whether something was replaced.
 */
export async function publish(staged: string, abs: string, overwrite: boolean): Promise<boolean> {
	const existing = await there(abs);
	if (existing && !overwrite) throw new RemoteCopyError(`${abs} exists: pass overwrite: true to replace it`, "exists");
	if (!existing) {
		await rename(staged, abs).catch((e) => Promise.reject(fsFailure(e, abs)));
		return false;
	}
	const aside = stagedBeside(abs, "old");
	await rename(abs, aside).catch((e) => Promise.reject(fsFailure(e, abs)));
	try {
		await rename(staged, abs);
	} catch (e) {
		await rename(aside, abs).catch(() => {});
		throw fsFailure(e, abs);
	}
	// What was replaced: a folder of the person's that cannot all be removed (a read-only one) is left under its hidden name.
	await rm(aside, { recursive: true, force: true }).catch(() => {});
	return true;
}

/** Remove what a copy that did not finish wrote. */
export async function discard(staged: string): Promise<void> {
	await rm(staged, { recursive: true, force: true }).catch(() => {});
}
