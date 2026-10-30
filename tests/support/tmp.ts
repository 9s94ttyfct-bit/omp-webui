import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * The temp dir of the servers of a test.
 *
 * A server keeps the overlay files of its conversations in the temp dir it is given (`server/omp/approval.ts`), and
 * it sweeps the overlay directories of the servers that are gone out of it. Two servers that share one temp dir can
 * therefore take each other's overlays away: the overlay of a paused conversation is what holds the mode it was
 * given, and a server of another data dir does not know of that conversation, so it sweeps its overlay away (#461).
 *
 * Each data dir gets a temp dir of its own, under the root of the test that started it: the servers of one data dir
 * share it, as the servers of one data dir share an overlay directory in production, and a server of another data dir
 * never sweeps it. The whole of it goes when the root of the test is removed.
 */

/** The base the temp dirs of the servers of a test are made in, under the root of that test. */
export function tmpBase(root: string): string {
	const dir = join(root, "tmp");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/**
 * The temp dir of the servers of `dataDir`, under `base`: one of its own, so that no server of another data dir
 * sweeps the overlay directories of this one's dead servers. The same one for every server of that data dir, as in
 * production, where the servers of one data dir take each other's conversations over.
 */
export function serverTmp(base: string, dataDir: string): string {
	const name = createHash("sha1").update(resolve(dataDir)).digest("hex").slice(0, 10);
	const dir = join(base, `${basename(resolve(dataDir))}-${name}`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}
