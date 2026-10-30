import type { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, renameSync, rmSync, statSync } from "node:fs";

/**
 * The server's SQLite files (`index.db`, the session summaries; `index.search.db`, the full-text index) are caches:
 * everything in them is read again from omp's session files. A file that is damaged (cut short, written over, not a
 * database at all) must therefore never be what keeps the server down: it is moved aside and built again.
 */

/** A database that opened, but did not pass SQLite's own check. */
export class DatabaseDamaged extends Error {}

/**
 * Whether `e` says that a database file is damaged: SQLite's "not a database" and "malformed" (any `SQLITE_CORRUPT…`),
 * a check that failed, or a stored value that is not the JSON that was written. Not a busy or read-only database, or a
 * full disk: those are not repaired by starting a new file, and another server may be using this one.
 */
export function isDamage(e: unknown): boolean {
	if (e instanceof DatabaseDamaged || e instanceof SyntaxError) return true;
	return (
		typeof e === "object" &&
		e !== null &&
		"code" in e &&
		typeof e.code === "string" &&
		/^SQLITE_(NOTADB|CORRUPT)/.test(e.code)
	);
}

/** The database and its journal files, moved to `<path>.damaged…` (the one kept from an earlier time is replaced). */
export function setAside(path: string): string {
	const aside = `${path}.damaged`;
	for (const suffix of ["", "-wal", "-shm"]) {
		rmSync(`${aside}${suffix}`, { force: true });
		try {
			renameSync(`${path}${suffix}`, `${aside}${suffix}`);
		} catch (e) {
			// A journal file that is not there is nothing to keep.
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
	}
	return aside;
}

/** One line for the log: SQLite's own message is several. */
function say(path: string, aside: string, e: unknown): void {
	const why = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
	console.warn(`omp-webui: ${path} is damaged (${why}); it was moved to ${aside} and is built again from omp's files`);
}

/**
 * `open()`, and when the database at `path` turns out to be damaged, once more on a new file: the old one is kept at
 * `setAside`'s name and the log says so. `open` must close what it opened when it throws. Anything else that goes
 * wrong, and a second failure, is the caller's.
 */
export function openRebuildable<T>(path: string, open: () => T): T {
	try {
		return open();
	} catch (e) {
		if (!isDamage(e)) throw e;
		say(path, setAside(path), e);
		return open();
	}
}

/**
 * A database that was open already turned out to be damaged (a read or a write of `e`'s found a page that is not one): the
 * connection is closed, the file kept aside and the log says so. The caller opens a new one, as `openRebuildable` does at
 * the start.
 */
export function giveUp(path: string, e: unknown, close: () => void): void {
	try {
		close();
	} catch {
		// what failed may be the file itself
	}
	say(path, setAside(path), e);
}

/**
 * A look at the file before SQLite opens it, for what a read of its first page tells: it is an SQLite database, and a file
 * the header says is longer than it is was cut short. Costs a hundred bytes, not the whole file. A file that is not there or
 * is empty is a new database.
 */
export function checkHeader(path: string): void {
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return;
	}
	if (size === 0) return;
	const head = Buffer.alloc(100);
	const fd = openSync(path, "r");
	let read: number;
	try {
		read = readSync(fd, head, 0, 100, 0);
	} finally {
		closeSync(fd);
	}
	if (read < 100 || head.toString("latin1", 0, 16) !== "SQLite format 3\0")
		throw new DatabaseDamaged("file is not a database");
	const pageSize = head.readUInt16BE(16) === 1 ? 65536 : head.readUInt16BE(16);
	if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0)
		throw new DatabaseDamaged(`the header names a page size of ${pageSize}`);
	const pages = head.readUInt32BE(28);
	// The page count counts only when the change counter vouches for it (SQLite itself trusts it on the same terms). What a
	// `-wal` file holds is not in the file yet, and a checkpoint cut off by a crash leaves the file short of its header:
	// SQLite finishes it when it opens the journal.
	const journal = `${path}-wal`;
	const journalled = existsSync(journal) && statSync(journal).size > 0;
	if (!journalled && pages > 0 && head.readUInt32BE(24) === head.readUInt32BE(92) && size < pages * pageSize) {
		throw new DatabaseDamaged(`the file is ${size} bytes, its header says ${pages * pageSize}`);
	}
}

/**
 * Whether the process that had this database open before did not close it: `meta.clean` is `'0'` from `markOpen` until
 * `markClosed`. A file without the row (made before this was kept) is not known to have been left open. Needs the `meta`
 * table (`key`, `value`).
 */
export function wasLeftOpen(conn: Database): boolean {
	return conn.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'clean'").get()?.value === "0";
}

export function markOpen(conn: Database): void {
	conn.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('clean', '0')");
}

export function markClosed(conn: Database): void {
	conn.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('clean', '1')");
}

/**
 * SQLite's own check of every page of the file. It reads the whole file (about 14 ms per MB), so it is made when there is a
 * reason to doubt the file (the process before did not close it), not at every start: a page that is bad otherwise comes
 * to light when something reads or writes it, and `giveUp` answers that.
 */
export function verify(conn: Database): void {
	const checked = conn.query<{ quick_check: string }, []>("PRAGMA quick_check(1)").get()?.quick_check;
	if (checked !== "ok") throw new DatabaseDamaged(`SQLite's check says: ${checked}`);
}
