import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * What this server keeps in its data dir is for its user alone: the search index holds the text of every conversation,
 * and the token opens the whole API. The directory is 0700 and what is in it 0600 (a file's mode is only set where it
 * is created: `{ mode: 0o600 }` at each write).
 */

/**
 * `dir` made (with its parents) and closed to everyone but its owner, along with what an earlier version put in it with
 * the default modes: the group and other bits of each entry are dropped (an owner's executable bit stays).
 * A directory somebody else owns (`OMP_WEBUI_DATA_DIR=/tmp`) is none of ours to change, and neither is what is not ours
 * in it: that is left, with a warning.
 */
export function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		const info = lstatSync(dir);
		if (info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
			console.warn(`omp-webui: ${dir} is not this user's own directory: its permissions are left as they are`);
			return;
		}
		chmodSync(dir, 0o700);
		for (const name of readdirSync(dir)) dropGroupAndOther(join(dir, name));
	} catch (e) {
		console.warn(`omp-webui: could not make ${dir} private: ${(e as Error).message}`);
	}
}

/** The group and other permissions of `path` dropped (not followed if it is a link); a file that is not there is fine. */
export function dropGroupAndOther(path: string): void {
	try {
		const info = lstatSync(path);
		if (info.isSymbolicLink() || (info.mode & 0o077) === 0) return;
		chmodSync(path, info.mode & 0o700);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`omp-webui: could not make ${path} private: ${(e as Error).message}`);
		}
	}
}
