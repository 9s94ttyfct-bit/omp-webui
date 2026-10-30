import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync, watch } from "node:fs";
import { join, relative, sep } from "node:path";
import {
	type AdvisorFile,
	SEARCH_LIMIT_MAX,
	type SearchHit,
	type SessionEntry,
	type SessionSummary,
	type SubagentFile,
	type UsageTotals,
} from "../../shared/protocol.ts";
import { burst } from "../burst.ts";
import {
	checkHeader,
	giveUp,
	isDamage,
	markClosed,
	markOpen,
	openRebuildable,
	verify,
	wasLeftOpen,
} from "../db-recover.ts";
import { dropGroupAndOther } from "../private.ts";
import {
	type Coverage,
	type FileCoverage,
	fileWaitMs,
	type IndexStats,
	SearchIndex,
	type SearchIndexOptions,
} from "../search-index.ts";
import { conversationFiles, type Folder } from "./folders.ts";
import { SessionFile, SLICE_MS, yieldToLoop } from "./lines.ts";
import {
	accFromSummary,
	buildSummary,
	type Dependents,
	emptyUsage,
	foldEntry,
	isSoundUsage,
	newAcc,
	parseLine,
	type SummaryAcc,
	withDependents,
	withTitleSlot,
} from "./parse.ts";
import { SubagentIndex, sumAdvisors, sumSubagents } from "./subagents.ts";

/** Search shows at most this many hits per conversation, so a busy one cannot push every other out. */
const PER_CONVERSATION_HITS = 3;
/** A search waits this long for the index to take in what was just written; a cold index is not waited for. */
const SEARCH_WAIT_MS = 300;
/** Where a session's header is looked for when only the end of its file is read again. */
const HEAD_BYTES = 16 * 1024;
/** The layout of the tables below: a different one starts them afresh. */
const SCHEMA = "3";
/** Removals the list's change log remembers: a client that missed more than this many is sent the whole list. */
const MAX_REMEMBERED_REMOVALS = 5000;
/** Where files cannot be watched, the directory is read again this often (and a change that scan finds is announced). */
const POLL_MS = 3000;
/**
 * A scan of the files the watcher named is not the only one: after this long without a scan of every file, the next one
 * looks at all of them (an event a watcher drops would otherwise leave its file as it was until something else wrote to it).
 */
const FULL_SCAN_MS = 5 * 60_000;
/**
 * Files that change are told to the clients after this long without another change, or this long after the first one of a
 * burst however many follow: writers that never pause for a moment (several conversations or subagents at work) must not
 * hold the sidebar back for as long as they write.
 */
const QUIET_MS = 400;
const MAX_WAIT_MS = 1500;
/**
 * How long the store waits before it looks at the library for conversations it does not know yet (a file written
 * between two requests, whose watcher's event has not arrived). The look runs in the background and what it finds is
 * announced, so the page asks again and gets the file: the answer to the request that missed it was not wrong, only
 * not yet complete.
 */
const LOOK_MS = 100;

/** What the store needs of a watcher (`FSWatcher` is one). */
interface Watching {
	close(): void;
	on(event: "error", listener: (error: Error) => void): unknown;
}

/** What a store is given besides where to look: stand-ins for what a test cannot make the machine do. */
export interface StoreOptions {
	/** `fs.watch`: a machine that cannot watch files is one where this throws, or fails later with an `error`. */
	watch?: (
		dir: string,
		options: { recursive: true },
		listener: (event: string, name: string | null) => void,
	) => Watching;
	/** `POLL_MS`. */
	pollMs?: number;
	/** How the full-text index's worker is started and bounded (a test that holds the worker's indexing back). */
	searchIndex?: SearchIndexOptions;
}

/** The sessions list as a client that has an earlier one needs it (see `SessionStore.changes`). */
export interface SessionChanges {
	/** Names this answer: the next request says it has everything up to here. */
	cursor: string;
	/** `sessions` is the whole list, and what the client has is replaced by it. */
	full: boolean;
	sessions: SessionSummary[];
	/** Files that are no longer sessions (never set when `full`). */
	removed: string[];
}

const NO_DEPENDENTS: Dependents = { subagents: { count: 0, usage: emptyUsage() }, advisor: emptyUsage() };

function sameTotals(a: Dependents, b: Dependents): boolean {
	const same = (x: UsageTotals, y: UsageTotals) =>
		x.input === y.input &&
		x.output === y.output &&
		x.cacheRead === y.cacheRead &&
		x.cacheWrite === y.cacheWrite &&
		x.totalTokens === y.totalTokens &&
		x.cost === y.cost &&
		x.requests === y.requests;
	return (
		a.subagents.count === b.subagents.count && same(a.subagents.usage, b.subagents.usage) && same(a.advisor, b.advisor)
	);
}

/**
 * Where a session file's summary was read up to, so that a transcript that grew is summarized from there
 * instead of from its first byte.
 */
interface TailState {
	/** The first `upto` bytes of the file are summarized (up to the last whole line). */
	upto: number;
	/** Hash of the bytes before `upto`: when they change, the file was rewritten and is read from the start. */
	tail: string;
	/** The header line as it was, to notice a rewritten file even when its end looks the same. */
	head: string;
	/** What `SessionSummary` does not hold of the fold (see `SummaryAcc.entryTitle`). */
	entryTitle: string | null;
}

/** A session's header and the title slot before it, from the first bytes of the open file. */
function readHead(
	file: SessionFile,
): { header: Record<string, unknown>; titleSlot: Record<string, unknown> | null; line: string } | null {
	const bytes = file.read(0, HEAD_BYTES);
	let titleSlot: Record<string, unknown> | null = null;
	let from = 0;
	for (;;) {
		const nl = bytes.indexOf(10, from);
		// A line the window ends in the middle of is not read.
		if (nl < 0) return null;
		const text = bytes.toString("utf8", from, nl);
		from = nl + 1;
		const obj = parseLine(text);
		if (!obj) continue;
		if (obj.type === "title") titleSlot = obj;
		else if (obj.type === "session") return { header: obj, titleSlot, line: text.trim() };
	}
}

/**
 * The summaries database at `dbPath`, opened and read: what each session summarized to, and how far into each file that goes.
 * Throws (closing what it opened) when the file is damaged, which `openRebuildable` answers with a new one. The pages are
 * not all checked at every start (that reads the whole file): the header is, and every page when the process before did
 * not close the file (`wasLeftOpen`); a bad page otherwise comes to light when it is read or written (`rebuild`).
 */
function openIndex(dbPath: string): {
	db: Database;
	summaries: Map<string, SessionSummary>;
	tails: Map<string, TailState>;
	index: SubagentIndex;
} {
	checkHeader(dbPath);
	const db = new Database(dbPath, { create: true });
	try {
		// The full text of every conversation is in it: for its owner only. SQLite gives its `-wal` and `-shm` files the mode
		// of the database file, and the ones an older version left are tightened after the journal mode is set.
		dropGroupAndOther(dbPath);
		db.run("PRAGMA journal_mode = WAL");
		for (const side of ["-wal", "-shm"]) dropGroupAndOther(`${dbPath}${side}`);
		// What is in here can be rebuilt from omp's files: no flush to disk per commit.
		db.run("PRAGMA synchronous = NORMAL");
		db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
		if (wasLeftOpen(db)) verify(db);
		markOpen(db);
		const schema = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema'").get();
		if (schema?.value !== SCHEMA) {
			// Version 2 kept its full-text index in this file. Summaries are the same in both versions; the index
			// now has a database of its own, and what the old one held is dropped (and the file shrunk).
			if (schema?.value !== "2") db.run("DROP TABLE IF EXISTS sessions");
			db.run("DROP TABLE IF EXISTS fts");
			db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)", [SCHEMA]);
			db.run("VACUUM");
		}
		db.run("CREATE TABLE IF NOT EXISTS sessions (file TEXT PRIMARY KEY, mtime REAL, size INTEGER, summary TEXT)");
		db.run(
			"CREATE TABLE IF NOT EXISTS session_state (file TEXT PRIMARY KEY, upto INTEGER NOT NULL, tail TEXT NOT NULL, head TEXT NOT NULL, entry_title TEXT)",
		);
		const summaries = new Map<string, SessionSummary>();
		const unsound: string[] = [];
		for (const row of db.query<{ summary: string }, []>("SELECT summary FROM sessions").all()) {
			const s: SessionSummary = JSON.parse(row.summary);
			// Totals an older version summed from malformed usage (`"0a"`, `NaN`) went on growing from there each time the
			// file did: such a file is summarized again from its first line.
			if (!isSoundUsage(s.usage) || !isSoundUsage(s.subagentUsage)) unsound.push(s.file);
			else summaries.set(s.file, s);
		}
		for (const file of unsound) {
			db.run("DELETE FROM sessions WHERE file = ?", [file]);
			db.run("DELETE FROM session_state WHERE file = ?", [file]);
		}
		const tails = new Map<string, TailState>();
		for (const r of db
			.query<{ file: string; upto: number; tail: string; head: string; entry_title: string | null }, []>(
				"SELECT file, upto, tail, head, entry_title FROM session_state",
			)
			.all()) {
			tails.set(r.file, { upto: r.upto, tail: r.tail, head: r.head, entryTitle: r.entry_title });
		}
		return { db, summaries, tails, index: new SubagentIndex(db) };
	} catch (e) {
		try {
			db.close();
		} catch {
			// what failed may be the file itself
		}
		throw e;
	}
}

/**
 * Read-only index over omp's session directory. Summaries live in the webui's own data dir and are kept up to
 * date from the end of each transcript; the full-text index is built by a worker thread (`SearchIndex`) in a
 * database of its own. omp's files are never written.
 */
export class SessionStore {
	private db: Database;
	private summaries = new Map<string, SessionSummary>();
	/** How far into each session file its summary reads (see `TailState`). */
	private tails = new Map<string, TailState>();
	/**
	 * What each session's subagents and advisors spent. Kept apart from `summaries` (which hold only a session's own
	 * requests and are cached by the session file's modification time) because a subagent or an advisor writes while
	 * its parent's file stays as it is.
	 */
	private dependents = new Map<string, Dependents>();
	private index: SubagentIndex;
	private searchIndex: SearchIndex;
	private scanning: Promise<void> | null = null;
	/** Every session file is to be looked at again: at the start, when the sessions dir appears, after a scan that failed. */
	private dirtyAll = true;
	/** The session files that changed since the last scan, as the watcher named them: all that the next scan looks at. */
	private dirtyFiles = new Set<string>();
	/** The buckets of the library (a directory under the sessions dir) and when each was last looked at. */
	private buckets = new Map<string, number>();
	/** When each folder was last looked at: a bucket (or, in a flat folder, a conversation) that is new shows in its modification time. */
	private foldersSeen = new Map<string, number>();
	/** The folders that could not be read, and have been said so (see `sessionFiles`). */
	private unreadableSaid = new Set<string>();
	/** The folders that could not be watched, and have been said so (see `watch`). */
	private unwatchableSaid = new Set<string>();
	/** The look at the library for conversations the store does not know (see `scheduleLook`). */
	private looking: ReturnType<typeof setTimeout> | undefined;
	/** When every session file was last looked at (see `FULL_SCAN_MS`). */
	private lastFull = 0;
	private listeners = new Set<() => void>();
	/** The watchers of the folders conversations are read from (one per folder that could be watched). */
	private watchers: Watching[] = [];
	/** The folders conversations are read from, as they were the last time the list was scanned. */
	private watched = new Set<string>();
	/** The folders a watcher is attached to. */
	private watching = new Set<string>();
	private poller: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	/** Names this process's cursors, so one from an earlier process is not mistaken for one of ours. */
	private readonly epoch = randomUUID().slice(0, 8);
	private rev = 0;
	/** Changes at or below this revision are not all known any more (removals are forgotten after a while). */
	private floor = 0;
	private changedAt = new Map<string, number>();
	private removedAt = new Map<string, number>();
	/** What clients were last told of each session: its summary and what its subagents and advisors spent. */
	private published = new Map<string, { own: SessionSummary; totals: Dependents }>();

	constructor(
		readonly sessionsDir: string,
		private readonly dbPath: string,
		private readonly options: StoreOptions = {},
		/**
		 * The other folders conversations are kept in: the ones the server has started omp with `--session-dir` or
		 * `--profile` (see `SessionRoots`). They are read like the sessions dir, and their conversations are listed,
		 * searched and reopened like the others.
		 */
		private extraRoots: () => Folder[] = () => [],
	) {
		const opened = openRebuildable(dbPath, () => openIndex(dbPath));
		this.db = opened.db;
		this.summaries = opened.summaries;
		this.tails = opened.tails;
		this.index = opened.index;
		this.searchIndex = new SearchIndex(dbPath.replace(/(\.db)?$/, ".search.db"), options.searchIndex);
		this.watch();
	}

	/**
	 * The folders conversations are read from: omp's own sessions directory and the ones the server has started omp
	 * with `--session-dir` or `--profile`. A root that is the sessions dir, or that is inside it, is not a root of
	 * its own.
	 */
	private roots(): Folder[] {
		const out = new Map<string, Folder>([[this.sessionsDir, { dir: this.sessionsDir, flat: false }]]);
		for (const folder of this.extraRoots()) {
			if (!folder.dir || out.has(folder.dir)) continue;
			if (folder.dir.startsWith(this.sessionsDir + sep)) continue;
			out.set(folder.dir, folder);
		}
		return [...out.values()];
	}

	/**
	 * The roots as they are now, and what changed since the last time: a folder that is new holds conversations the
	 * list has not looked at yet, so the next scan is a full one and the folder is watched from then on.
	 */
	private rootsChanged(): boolean {
		let changed = false;
		for (const { dir } of this.roots()) {
			if (this.watched.has(dir)) continue;
			this.watched.add(dir);
			changed = true;
		}
		return changed;
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private watch(): void {
		if (this.closed) return;
		const roots = this.roots();
		const missing = roots.filter((folder) => !existsSync(folder.dir));
		if (missing.length === roots.length) {
			// Fresh install: omp creates the directory with the first session. Poll until it
			// exists, then rescan and attach the watcher.
			const poll = setInterval(() => {
				if (!this.roots().some((folder) => existsSync(folder.dir))) return;
				clearInterval(poll);
				this.poller = undefined;
				this.dirtyAll = true;
				this.markChanged();
				this.watch();
			}, 1000);
			poll.unref?.();
			this.poller = poll;
			return;
		}
		const touched = burst(() => this.markChanged(), QUIET_MS, MAX_WAIT_MS);
		const watchOne = this.options.watch ?? watch;
		for (const folder of roots) {
			const { dir } = folder;
			// A folder that is already watched is left alone: a second watcher on it would say the same thing twice.
			if (this.watching.has(dir)) continue;
			// A folder that is not there yet (the first conversation in it was never written) is looked at by the next
			// scan; the watcher is attached when it appears.
			if (!existsSync(dir)) continue;
			try {
				const watcher = watchOne(dir, { recursive: true }, (_event, name) => {
					if (!name?.endsWith(".jsonl")) return;
					this.noteFile(folder, name);
					touched();
				});
				// One that fails later (a limit reached, the directory removed) is no longer watching: an error not listened to ends the process.
				watcher.on("error", (e) => this.poll(e));
				this.watchers.push(watcher);
				this.watching.add(dir);
				this.unwatchableSaid.delete(dir);
			} catch (e) {
				// A root the server may not read cannot be watched (EACCES, EPERM). It is left out and said once, by
				// its own path: the other roots keep their watchers, and the library is not put on the poller for it.
				// Any other failure (the limit on watches reached) is the other case: the whole library is polled
				// instead, for that root as for omp's own.
				if (dir !== this.sessionsDir && isPermission(e)) {
					if (!this.unwatchableSaid.has(dir)) {
						this.unwatchableSaid.add(dir);
						console.warn(
							`omp-webui: ${dir} cannot be watched (${(e as Error).message}); it is not watched, and is read again with the next full scan`,
						);
					}
					continue;
				}
				this.poll(e);
			}
		}
	}

	/**
	 * A root whose folder was not there when the roots were last watched and is now (omp makes the folder of a
	 * `--session-dir` or a profile with its first write) gets its watcher, and the library is read again once: what was
	 * written before the watcher was attached raised no event. The conversation itself is found by the look, but only a
	 * watcher sees its later writes. Not while files are polled instead of watched: the poll reads every folder anyway.
	 *
	 * A root that could not be watched is not one that appeared: it is tried again with the next full scan, and not on
	 * every request, which would read the whole library every time.
	 */
	private watchAppeared(): void {
		if (this.closed || this.poller) return;
		if (
			!this.roots().some(
				(folder) => !this.watching.has(folder.dir) && !this.unwatchableSaid.has(folder.dir) && existsSync(folder.dir),
			)
		)
			return;
		this.dirtyAll = true;
		this.watch();
	}

	/**
	 * Files cannot be watched (the system's limit on watches, a file system that has none): the directory is read again
	 * every `POLL_MS` instead, and a scan that finds a change announces it as a watcher's event would.
	 */
	private poll(why: unknown): void {
		if (this.closed || this.poller) return;
		for (const watcher of this.watchers) watcher.close();
		this.watchers = [];
		this.watching.clear();
		const every = this.options.pollMs ?? POLL_MS;
		console.warn(
			`omp-webui: cannot watch ${this.sessionsDir} (${why instanceof Error ? why.message : String(why)}); the session list is read again every ${every / 1000} s`,
		);
		let failing = false;
		this.poller = setInterval(async () => {
			const before = this.rev;
			try {
				await this.refresh(true);
				failing = false;
			} catch (e) {
				// Said once, not every time it is tried again.
				if (!failing) console.warn(`omp-webui: reading ${this.sessionsDir} failed: ${(e as Error).message}`);
				failing = true;
				return;
			}
			if (this.rev !== before) for (const fn of this.listeners) fn();
		}, every);
		this.poller.unref?.();
	}

	/** Stop watching, end the search index's thread and close the database (closing again does nothing). The store is not used afterwards. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const watcher of this.watchers) watcher.close();
		this.watchers = [];
		this.watching.clear();
		clearInterval(this.poller);
		clearTimeout(this.looking);
		this.searchIndex.close();
		try {
			// Said in the file, so that the next start does not look at every page of it (`wasLeftOpen`).
			markClosed(this.db);
		} catch {
			// a database that cannot be written to is closed all the same
		}
		// The journal is folded into the file first: its prepared statements (the subagent index's) keep the connection
		// from closing for good, and what was written must not wait in a `-wal` file that is read back beside another database.
		this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		this.db.close();
	}

	/**
	 * The summaries database turned out to be damaged while it was in use (a page nothing read at the start is read or written
	 * now): it is kept aside, a new one is made and everything is summarized again, from omp's files.
	 */
	private rebuild(e: unknown): void {
		giveUp(this.dbPath, e, () => this.db.close());
		const opened = openRebuildable(this.dbPath, () => openIndex(this.dbPath));
		this.db = opened.db;
		this.summaries = opened.summaries;
		this.tails = opened.tails;
		this.index = opened.index;
		this.dependents.clear();
	}

	/** Tell whoever listens that the session list changed. */
	private markChanged(): void {
		for (const fn of this.listeners) fn();
	}

	/**
	 * The watcher of `folder` saw `name` (relative to that folder) change: the session file it belongs to is looked at
	 * again by the next scan, and no other. That is `<bucket>/<session>.jsonl` (`<session>.jsonl` in a flat folder), or,
	 * for what is in the directory of a session's artifacts (`<bucket>/<session>/…`, `<session>/…`: its subagents' and
	 * advisors' transcripts), that session's file.
	 */
	private noteFile(folder: Folder, name: string): void {
		const parts = name.split(/[\\/]/);
		if (folder.flat) {
			const [entry, ...inside] = parts;
			if (!entry) return;
			this.dirtyFiles.add(join(folder.dir, inside.length === 0 ? entry : `${entry}.jsonl`));
			return;
		}
		const [bucket, entry, ...inside] = parts;
		if (!bucket || !entry) return;
		if (inside.length === 0) this.dirtyFiles.add(join(folder.dir, bucket, entry));
		else this.dirtyFiles.add(join(folder.dir, bucket, `${entry}.jsonl`));
	}

	/**
	 * Top-level session files of every folder conversations are read from (see `conversationFiles`), and the folders
	 * that exist and could not be read (one that is a file, one without permission). Such a folder, when it is one of the
	 * extra roots, must not take the library down with it: it is left out of the listing, said once, and what the store
	 * knows of it is kept (see `scan`). A failure in omp's own sessions directory is the scan's, as it always was: it is
	 * reported by every request until it heals, not answered from what the store had.
	 */
	private sessionFiles(): { files: string[]; unreadable: string[] } {
		const files: string[] = [];
		const unreadable: string[] = [];
		for (const folder of this.roots()) {
			if (!existsSync(folder.dir)) continue;
			try {
				files.push(...conversationFiles(folder));
				this.unreadableSaid.delete(folder.dir);
			} catch (e) {
				if (folder.dir === this.sessionsDir) throw e;
				unreadable.push(folder.dir);
				// Said once while it stays unreadable, not on every request.
				if (!this.unreadableSaid.has(folder.dir)) {
					this.unreadableSaid.add(folder.dir);
					console.warn(`omp-webui: ${folder.dir} cannot be read (${(e as Error).message}); it is left out of the list`);
				}
			}
		}
		return { files, unreadable };
	}

	/**
	 * The session files that are on disk and that the store has no summary of: a conversation written since the last
	 * scan, whose watcher's event has not arrived yet, in any folder conversations are read from. The buckets are
	 * looked at by their modification time (a file added to a bucket changes it), so a bucket that has not changed
	 * since the last look is not read at all: a listing of every bucket is a hundred times the work of a stat of each
	 * of them. A flat folder holds the conversations themselves, so its own modification time says one was added.
	 */
	private filesNotKnown(): string[] {
		const fresh: string[] = [];
		const unknown = (path: string) => {
			if (!this.summaries.has(path)) fresh.push(path);
		};
		for (const folder of this.roots()) {
			// A bucket that is new (a project the library did not have) is in the folder, whose modification time says so.
			let seenDir: number;
			try {
				seenDir = statSync(folder.dir).mtimeMs;
			} catch {
				continue;
			}
			if (seenDir === this.foldersSeen.get(folder.dir)) continue;
			this.foldersSeen.set(folder.dir, seenDir);
			if (folder.flat) {
				for (const path of conversationFiles(folder)) unknown(path);
				continue;
			}
			for (const bucket of readdirSync(folder.dir, { withFileTypes: true })) {
				if (!bucket.isDirectory()) continue;
				const dir = join(folder.dir, bucket.name);
				if (this.buckets.has(dir)) continue;
				this.buckets.set(dir, statSync(dir).mtimeMs);
				for (const file of readdirSync(dir, { withFileTypes: true })) {
					if (file.isFile() && file.name.endsWith(".jsonl")) unknown(join(dir, file.name));
				}
			}
		}
		for (const [bucket, seen] of this.buckets) {
			let now: number;
			try {
				now = statSync(bucket).mtimeMs;
			} catch {
				continue;
			}
			if (now === seen) continue;
			this.buckets.set(bucket, now);
			for (const file of readdirSync(bucket, { withFileTypes: true })) {
				if (file.isFile() && file.name.endsWith(".jsonl")) unknown(join(bucket, file.name));
			}
		}
		return fresh;
	}

	/**
	 * Scan when files changed. The files the watcher named are looked at, and no others (what a change costs is what changed,
	 * not the size of the library); every file when `force`, at the start, after a scan that failed, and once in a while
	 * (a watcher can drop an event, and nothing would ever say that file changed). Unchanged files reuse cached summaries. A
	 * caller arriving while a scan runs waits for it: the first caller already cleared what was dirty, so checking that
	 * first would return before the index is filled.
	 */
	async refresh(force = false): Promise<void> {
		if (this.scanning) return this.scanning;
		// A folder that is new holds conversations the list has not looked at yet: the whole library is read again,
		// and the folder is watched from then on.
		if (this.rootsChanged()) {
			this.dirtyAll = true;
			this.watch();
		}
		this.watchAppeared();
		const named = this.dirtyFiles.size > 0;
		if (!force && !this.dirtyAll && !named) return;
		const full = force || this.dirtyAll || Date.now() - this.lastFull > FULL_SCAN_MS;
		const files = full ? null : [...this.dirtyFiles];
		this.dirtyAll = false;
		this.dirtyFiles.clear();
		this.scanning = this.scanOnce(files)
			.then(() => {
				if (full) {
					this.lastFull = Date.now();
					// A folder that was not there when the last scan ran may be there now: it is watched from then on.
					this.watch();
				}
			})
			.catch((e) => {
				// A scan that failed has not read what changed: the next request reads it again (and fails again if it still must).
				this.dirtyAll = true;
				throw e;
			})
			.finally(() => {
				this.scanning = null;
			});
		return this.scanning;
	}

	/**
	 * A scan (of `files`, or of every session file when null), and one more of every file on a new database when the one in
	 * use turns out to be damaged; a second failure is the caller's.
	 */
	private async scanOnce(files: string[] | null): Promise<void> {
		try {
			await (files ? this.scanFiles(files) : this.scan());
		} catch (e) {
			if (!isDamage(e) || this.closed) throw e;
			this.rebuild(e);
			await this.scan();
		}
	}

	/**
	 * What a session file's scan does: its subagents' and advisors' totals, and its summary when the file changed. Every
	 * scan of a file, whether or not the session file changed: its subagents and advisors write on their own.
	 */
	private async scanFile(file: string, st: { mtimeMs: number; size: number }): Promise<void> {
		// Not `listSubagents`: damage found here ends this scan, and `scanOnce` makes it again on a new database.
		const { subagents, advisors } = await this.index.scan(file);
		this.dependents.set(file, { subagents: sumSubagents(subagents), advisor: sumAdvisors(advisors) });
		const cached = this.summaries.get(file);
		if (!(cached && cached.modifiedAt === st.mtimeMs && cached.size === st.size)) {
			await this.summarizeFile(file, subagents.length);
		}
	}

	/** Forget session files that are gone: their summaries (and where each was read up to), totals and transcripts. */
	private drop(files: string[]): void {
		for (const f of files) {
			this.index.forgetSession(f);
			this.dependents.delete(f);
		}
		const known = files.filter((f) => this.summaries.has(f));
		if (!known.length) return;
		const delSummary = this.db.prepare("DELETE FROM sessions WHERE file = ?");
		const delState = this.db.prepare("DELETE FROM session_state WHERE file = ?");
		this.db.transaction(() => {
			for (const f of known) {
				this.summaries.delete(f);
				this.tails.delete(f);
				delSummary.run(f);
				delState.run(f);
			}
		})();
	}

	/** Every session file there is. */
	private async scan(): Promise<void> {
		const seen = new Set<string>();
		let sliceBegan = performance.now();
		const { files, unreadable } = this.sessionFiles();
		// What is known of a folder that cannot be read now is kept: it may be a permission that comes back, and the
		// conversations in it are not gone.
		for (const known of this.summaries.keys()) {
			if (unreadable.some((dir) => known.startsWith(`${dir}${sep}`))) seen.add(known);
		}
		for (const file of files) {
			seen.add(file);
			let st: { mtimeMs: number; size: number };
			try {
				st = statSync(file);
			} catch {
				continue;
			}
			await this.scanFile(file, st);
			// A library read for the first time is thousands of files: the event loop gets its turn between them.
			if (performance.now() - sliceBegan > SLICE_MS) {
				await yieldToLoop();
				sliceBegan = performance.now();
			}
		}
		this.index.prune(seen);
		for (const f of this.dependents.keys()) if (!seen.has(f)) this.dependents.delete(f);
		this.drop([...this.summaries.keys()].filter((f) => !seen.has(f)));
		// The full-text index follows in its own thread: nothing here waits for it.
		this.searchIndex.sync(this.indexEntries(this.summaries.keys()));
		this.noteChanges();
	}

	/** Only `files`, the session files that changed: a scan costs what they do. */
	private async scanFiles(files: string[]): Promise<void> {
		const gone: string[] = [];
		let sliceBegan = performance.now();
		for (const file of files) {
			let st: { mtimeMs: number; size: number } | null = null;
			try {
				const found = statSync(file);
				if (found.isFile()) st = found;
			} catch {
				// removed
			}
			if (st) await this.scanFile(file, st);
			else gone.push(file);
			if (performance.now() - sliceBegan > SLICE_MS) {
				await yieldToLoop();
				sliceBegan = performance.now();
			}
		}
		this.drop(gone);
		const entries = this.indexEntries(files);
		if (!this.searchIndex.update(entries, gone)) this.searchIndex.sync(this.indexEntries(this.summaries.keys()));
		this.noteChanges({ files, gone });
	}

	/** What the full-text index is told of the session files in `files` that have a summary. */
	private indexEntries(files: Iterable<string>): { file: string; size: number; mtime: number }[] {
		const out: { file: string; size: number; mtime: number }[] = [];
		for (const f of files) {
			const s = this.summaries.get(f);
			if (s) out.push({ file: s.file, size: s.size, mtime: s.modifiedAt });
		}
		return out;
	}

	/**
	 * Summarize a session file that changed. A transcript only grows at its end, so when what was read before
	 * is still what the file starts with, only the lines after it are folded into the summary; the whole file
	 * is read again only when it was rewritten or has never been read. The file is opened once and all of it is read
	 * from that (see `SessionFile`): a rewrite that lands meanwhile is the next scan's to find, as a file that changed.
	 */
	private async summarizeFile(file: string, subagentCount: number): Promise<void> {
		const open = SessionFile.open(file);
		// Removed since it was listed: the next scan drops it.
		if (!open) return;
		try {
			const st = { mtimeMs: open.mtimeMs, size: open.size };
			const prior = this.summaries.get(file);
			const tail = this.tails.get(file);
			let from = 0;
			let acc: SummaryAcc | null = null;
			let header: Record<string, unknown> | null = null;
			let titleSlot: Record<string, unknown> | null = null;
			let headerLine: string | null = null;
			if (prior && tail && st.size >= tail.upto) {
				const head = readHead(open);
				if (head && head.line === tail.head && open.windowHash(tail.upto) === tail.tail) {
					acc = accFromSummary(prior, tail.entryTitle);
					({ header, titleSlot } = head);
					headerLine = head.line;
					from = tail.upto;
				}
			}
			acc ??= newAcc();
			const lines = open.lines(from);
			let upto = from;
			let sliceBegan = performance.now();
			for (;;) {
				const line = await lines.next();
				if (!line) break;
				const obj = parseLine(line.text);
				// The writer may be in the middle of this line: it is read once it is whole.
				if (!obj && !line.terminated && line.text.trim()) break;
				upto = line.end;
				if (!obj) continue;
				if (obj.type === "title" && !header) titleSlot = obj;
				else if (obj.type === "session" && !header) {
					header = obj;
					headerLine = line.text.trim();
				} else if (typeof obj.id === "string") foldEntry(acc, obj as SessionEntry);
				if (performance.now() - sliceBegan > SLICE_MS) {
					await yieldToLoop();
					sliceBegan = performance.now();
				}
			}
			const summary = buildSummary(file, withTitleSlot(header, titleSlot), acc, st, subagentCount);
			if (!summary || headerLine === null) return;
			// Hashed from the bytes that were read, not from whatever the path names now.
			const state: TailState = {
				upto,
				tail: open.windowHash(upto),
				head: headerLine,
				entryTitle: acc.entryTitle,
			};
			this.summaries.set(file, summary);
			this.tails.set(file, state);
			this.db.transaction(() => {
				this.db.run("INSERT OR REPLACE INTO sessions (file, mtime, size, summary) VALUES (?, ?, ?, ?)", [
					file,
					st.mtimeMs,
					st.size,
					JSON.stringify(summary),
				]);
				this.db.run(
					"INSERT OR REPLACE INTO session_state (file, upto, tail, head, entry_title) VALUES (?, ?, ?, ?, ?)",
					[file, state.upto, state.tail, state.head, state.entryTitle],
				);
			})();
		} finally {
			open.close();
		}
	}

	/** A session as clients see it: its own requests, its subagents' and its advisors' together. */
	private withTotals(own: SessionSummary): SessionSummary {
		return withDependents(own, this.dependents.get(own.file) ?? NO_DEPENDENTS);
	}

	async list(): Promise<SessionSummary[]> {
		await this.refresh();
		return this.all();
	}

	private all(): SessionSummary[] {
		return [...this.summaries.values()].map((s) => this.withTotals(s)).sort((a, b) => b.modifiedAt - a.modifiedAt);
	}

	/**
	 * What changed in the list since `since`, a cursor this store handed out earlier: the summaries that are new or
	 * different, and the files that are gone. A cursor from another process, from before the oldest removal this
	 * store still remembers, or none at all, gets the whole list (`full`) instead. Writing to a conversation changes
	 * one summary, and that is all a client that has the rest is sent.
	 */
	async changes(since: string | null): Promise<SessionChanges> {
		await this.refresh();
		const cursor = `${this.epoch}.${this.rev}`;
		const [epoch, rev] = (since ?? "").split(".");
		const at = Number(rev);
		if (epoch !== this.epoch || rev === undefined || !Number.isInteger(at) || at < this.floor || at > this.rev) {
			return { cursor, full: true, sessions: this.all(), removed: [] };
		}
		const sessions: SessionSummary[] = [];
		for (const [file, changed] of this.changedAt) {
			const own = this.summaries.get(file);
			if (changed > at && own) sessions.push(this.withTotals(own));
		}
		const removed = [...this.removedAt].filter(([, gone]) => gone > at).map(([file]) => file);
		// A conversation can be on disk that the watcher has not named yet (its event is still on its way, and a file
		// written in the same moment as a scan is seen by the next scan, not by that one). The list the client holds is
		// made of the files the store knows, so the store looks for the ones it does not know.
		//
		// The look is not part of the answer: it is a listing of every bucket, and what a change to one conversation
		// costs must not be what the library is. It is scheduled instead, and what it finds is announced, so the page
		// asks again and gets the file. A request that has changes to send does not schedule one either: the file it
		// does not know about is in the list a moment later.
		if (sessions.length === 0 && removed.length === 0) this.scheduleLook();
		return { cursor: `${this.epoch}.${this.rev}`, full: false, sessions, removed };
	}

	/**
	 * Look at the library for conversations the store does not know, a moment after a request that found nothing: a
	 * conversation written between two requests, whose watcher's event has not arrived yet. What the look finds is
	 * scanned and announced, so the page that asked asks again and gets it. One look at a time, and none of them
	 * while the store is closed.
	 */
	private scheduleLook(): void {
		if (this.closed || this.looking) return;
		this.looking = setTimeout(() => {
			this.looking = undefined;
			if (this.closed) return;
			try {
				const fresh = this.filesNotKnown();
				if (fresh.length === 0) return;
				for (const file of fresh) this.dirtyFiles.add(file);
				this.scanning = this.scanOnce([...this.dirtyFiles])
					.then(() => {
						for (const fn of this.listeners) fn();
					})
					.catch(() => {
						this.dirtyAll = true;
					})
					.finally(() => {
						this.scanning = null;
					});
			} catch {
				// The library could not be read: the next full scan will see it.
			}
		}, LOOK_MS);
		this.looking.unref?.();
	}

	/**
	 * After a scan: stamp what changed since the last one with a new revision, and what went away. Of every session when
	 * the scan was of all of them, else of the `files` it looked at and the ones among them that are `gone`.
	 */
	private noteChanges(only?: { files: Iterable<string>; gone: Iterable<string> }): void {
		const changed: string[] = [];
		for (const file of only ? only.files : this.summaries.keys()) {
			const own = this.summaries.get(file);
			if (!own) continue;
			const totals = this.dependents.get(file) ?? NO_DEPENDENTS;
			const known = this.published.get(file);
			if (known && known.own === own && sameTotals(known.totals, totals)) continue;
			this.published.set(file, { own, totals });
			changed.push(file);
		}
		const removed = (only ? [...only.gone] : [...this.published.keys()]).filter(
			(f) => this.published.has(f) && !this.summaries.has(f),
		);
		if (changed.length === 0 && removed.length === 0) return;
		const rev = ++this.rev;
		for (const file of changed) {
			this.changedAt.set(file, rev);
			this.removedAt.delete(file);
		}
		for (const file of removed) {
			this.published.delete(file);
			this.changedAt.delete(file);
			this.removedAt.set(file, rev);
		}
		// Removals are remembered for a while only; a client older than the oldest one forgotten is sent everything.
		for (const [file, gone] of this.removedAt) {
			if (this.removedAt.size <= MAX_REMEMBERED_REMOVALS) break;
			this.removedAt.delete(file);
			this.floor = Math.max(this.floor, gone);
		}
	}

	async get(file: string): Promise<SessionSummary | null> {
		await this.refresh();
		const own = this.summaries.get(file);
		return own ? this.withTotals(own) : null;
	}

	/**
	 * Wait until the full-text index covers every session file as it is now. Searching does not wait for this
	 * (see `searchResult`): it is for tests and for callers that must not miss a hit.
	 */
	async indexed(): Promise<Coverage & IndexStats> {
		await this.refresh(true);
		return this.searchIndex.flush();
	}

	/**
	 * `indexed`, and then the full-text index compacted if what was removed from it is enough to be worth it: the worker does
	 * that by itself when it has been left alone for a few seconds, and this is for whoever must see the file as small as it gets.
	 */
	async compacted(): Promise<Coverage & IndexStats> {
		await this.refresh(true);
		return this.searchIndex.flush(true);
	}

	/** How many session files the full-text index covers, of all there are, as of its last report. */
	get searchCoverage(): Coverage {
		return this.searchIndex.coverage;
	}

	/**
	 * Message hits for `query`, at most `PER_CONVERSATION_HITS` per conversation so one busy
	 * conversation cannot crowd out the rest. Hits come grouped by conversation (conversations
	 * ordered by their best hit, hits within one by rank); `more` on a conversation's last hit
	 * counts its matches that are not in the result. With `file`, only that conversation is
	 * searched and nothing is capped but `limit`.
	 */
	async search(query: string, limit = 50, file?: string): Promise<SearchHit[]> {
		return (await this.searchResult(query, limit, file)).hits;
	}

	/**
	 * `search`, with how much of the library the index covered when it answered. The query runs in the index's
	 * thread. It first waits a moment for the index to take in what was just written, so a conversation that
	 * grew a second ago is searched in full; a library that is still being indexed for the first time answers
	 * from what is indexed so far, and `coverage` says how much that is. `waitMs` is how long it waits. With `signal`, a
	 * search whose request is dropped is cut short (it rejects with the signal's reason) and the index skips it.
	 *
	 * With `file`, the search waits for that one conversation to be in the index (as long as that takes), and `file`
	 * says how much of it the answer is from: a caller that asked for one conversation must be able to tell it was
	 * searched in full from one where it was not searched at all (#509).
	 */
	async searchResult(
		query: string,
		limit = 50,
		file?: string,
		{
			waitMs = SEARCH_WAIT_MS,
			signal,
			perConversation,
			words = false,
		}: { waitMs?: number; signal?: AbortSignal; perConversation?: number; words?: boolean } = {},
	): Promise<{ hits: SearchHit[]; coverage: Coverage; file?: FileCoverage }> {
		await this.refresh();
		const q = query.trim();
		if (!q) return { hits: [], coverage: this.searchIndex.coverage };
		const max = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), SEARCH_LIMIT_MAX) : 50;
		// The sidebar asks for one hit a conversation (#717), so that `max` is a number of conversations.
		const cap = file
			? max
			: perConversation !== undefined && perConversation >= 1
				? Math.min(Math.trunc(perConversation), PER_CONVERSATION_HITS)
				: PER_CONVERSATION_HITS;
		// A search for one conversation waits for that conversation to be wholly in the index: how long that takes is
		// the size of it, not the moment a library-wide search waits (#509).
		const size = file ? (this.summaries.get(file)?.size ?? 0) : 0;
		const {
			hits: found,
			coverage,
			file: covered,
		} = await this.searchIndex.search(
			{ q, max, cap, file, waitMs, words, ...(file ? { fileWaitMs: fileWaitMs(size, waitMs) } : {}) },
			signal,
		);
		const hits: SearchHit[] = found.map((h) => {
			const s = this.summaries.get(h.file);
			return {
				file: h.file,
				entryId: h.entryId,
				role: h.role,
				snippet: h.snippet,
				timestamp: h.timestamp,
				title: s?.title ?? s?.preview ?? null,
				cwd: s?.cwd ?? "",
				...(h.more > 0 ? { more: h.more } : {}),
			};
		});
		return { hits, coverage, ...(covered ? { file: covered } : {}) };
	}

	/**
	 * Every session file in `file`'s lineage family: omp's `branch` and `fork`
	 * write a new file whose header `parentSession` names the source (as a path
	 * or a session id), keeping the shared prefix's entry ids.
	 */
	async family(file: string): Promise<string[]> {
		await this.refresh();
		const byId = new Map<string, string>();
		const byBase = new Map<string, string>();
		for (const s of this.summaries.values()) {
			byId.set(s.id, s.file);
			byBase.set(s.file.split(sep).pop() ?? s.file, s.file);
		}
		const parentOf = (f: string): string | null => {
			const p = this.summaries.get(f)?.parentSession;
			if (!p) return null;
			if (this.summaries.has(p)) return p;
			return byId.get(p) ?? byBase.get(p.split(/[\\/]/).pop() ?? p) ?? null;
		};
		let root = file;
		const climbed = new Set([root]);
		for (let p = parentOf(root); p && !climbed.has(p); p = parentOf(p)) {
			climbed.add(p);
			root = p;
		}
		const children = new Map<string, string[]>();
		for (const f of this.summaries.keys()) {
			const p = parentOf(f);
			if (p) children.set(p, [...(children.get(p) ?? []), f]);
		}
		const out: string[] = [];
		const seen = new Set<string>();
		const stack = [root];
		while (stack.length) {
			const f = stack.pop() as string;
			if (seen.has(f)) continue;
			seen.add(f);
			out.push(f);
			stack.push(...(children.get(f) ?? []));
		}
		if (!seen.has(file)) out.push(file);
		return out;
	}

	/**
	 * Whether `path` is inside a folder conversations are read from, written or not. The path is compared as it is: a
	 * file found under a folder and the folder itself are the same path only when the path is the real one (`/var` is
	 * a link to `/private/var` on macOS), so callers pass the real path (or the real folder joined to the name).
	 */
	inFolders(path: string): boolean {
		return this.roots().some(({ dir }) => {
			const rel = relative(dir, path);
			return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
		});
	}

	/**
	 * Resolve a client-supplied path, refusing anything outside a folder conversations are read from. A conversation
	 * started with `--session-dir` or `--profile` keeps its file in one of the other folders, and is served like the
	 * others.
	 */
	resolveSessionPath(file: string): string | null {
		try {
			const real = realpathSync(file);
			if (!real.endsWith(".jsonl")) return null;
			return this.inFolders(real) ? real : null;
		} catch {
			return null;
		}
	}

	/** The subagent transcripts of a session (see `SubagentIndex`). */
	async listSubagents(file: string): Promise<SubagentFile[]> {
		return (await this.transcripts(file)).subagents;
	}

	/** The advisor transcripts of a session (see `SubagentIndex`). */
	async listAdvisors(file: string): Promise<AdvisorFile[]> {
		return (await this.transcripts(file)).advisors;
	}

	/**
	 * The subagent and the advisor transcripts of a session, from one look at its artifacts directory, with the providers
	 * each spent (what a page shows a conversation with: its quota pills, #688).
	 */
	async transcripts(file: string): Promise<{ subagents: SubagentFile[]; advisors: AdvisorFile[] }> {
		try {
			return await this.index.scan(file, true);
		} catch (e) {
			if (!isDamage(e) || this.closed) throw e;
			this.rebuild(e);
			return this.index.scan(file, true);
		}
	}
}

/** Whether `e` says that the server is not allowed to read or watch the folder. */
function isPermission(e: unknown): boolean {
	const code = (e as NodeJS.ErrnoException | null)?.code;
	return code === "EACCES" || code === "EPERM";
}
