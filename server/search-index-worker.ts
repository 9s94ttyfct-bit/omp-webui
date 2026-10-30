import { Database, type Statement } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import type { SessionEntry } from "../shared/protocol.ts";
import {
	checkHeader,
	giveUp,
	isDamage,
	markClosed,
	markOpen,
	openRebuildable,
	verify,
	wasLeftOpen,
} from "./db-recover.ts";
import { dropGroupAndOther } from "./private.ts";
import type {
	Coverage,
	FileCoverage,
	FileState,
	IndexStats,
	Job,
	RawHit,
	Reply,
	SearchRequest,
} from "./search-index.ts";
import { SHORT_BEFORE, SHORT_LENGTH, SNIPPET_CLOSE, SNIPPET_OPEN, shortSnippet } from "./search-snippet.ts";
import { type LineCursor, SessionFile, yieldToLoop } from "./sessions/lines.ts";
import { parseLine, searchableText } from "./sessions/parse.ts";

/**
 * Worker thread of `search-index.ts`: keeps the full-text index of the session files up to date and answers
 * queries. See that file for what the index covers and why it lives here.
 *
 * Rows of one file share a block of row ids: `fid * 2^24 + n`, `fid` being the file's number in `files` and `n`
 * the row's position in it. A file's rows are found, and deleted, by a range of row ids; the index has no column
 * that finds them by file.
 *
 * Deleting rows of a full-text index does not give its space back: FTS5 only marks them, and the file keeps its size until
 * the segments that hold them are merged and the pages they free are returned. The worker counts the rows it removed
 * (`dead`) and, once they are a quarter of what the index ever held, compacts it between two pieces of other work
 * (`compact`).
 */

/** Row ids reserved per file. A file whose entries run past this simply stops being indexed there. */
const ROWS_PER_FILE = 2 ** 24;
/** One transaction of indexing work takes about this long, so a query is answered between two of them. */
const BATCH_MS = 10;
const BATCH_ROWS = 500;
const PROGRESS_MS = 400;
/** Rows deleted in one transaction: about 100 ms of work, so a search is answered between two, and the journal stays small. */
const DELETE_ROWS = 1500;
/** Rows removed (forgotten files, files indexed again) that make the journal worth folding into the file at once. */
const BULK_ROWS = 2000;
/** The journal is cut back to this much after each checkpoint (one transaction that deletes a big conversation writes far more). */
const WAL_LIMIT_BYTES = 16 * 1024 * 1024;
/** Compact when at least this many rows were removed, and they are this share of the rows the index ever held. */
const COMPACT_MIN_DEAD = 1000;
const COMPACT_DEAD_SHARE = 0.25;
/** The index is left alone this long before compacting starts: whoever deleted a hundred files is not done yet. */
const COMPACT_DELAY_MS = 3000;
/** Pages of segments one merge step rewrites (about 100 ms), and pages one `incremental_vacuum` step returns. */
const MERGE_PAGES = 500;
const VACUUM_PAGES = 2000;
/** A file that was not made with `auto_vacuum` gets a full `VACUUM` (once, and it changes the file) when this share of it is free. */
const VACUUM_FREE_SHARE = 0.25;

interface Indexed {
	fid: number;
	/** The first `indexed` bytes of the file are in the index. */
	indexed: number;
	/** Hash of the bytes before `indexed`, to notice that the file was rewritten. */
	tail: string;
	/** Rows written so far: the next one's position. */
	seq: number;
}

/**
 * Where indexing a file stands between two steps: its lines, read from one open file (see `SessionFile`) so that a
 * rewrite that lands meanwhile is not read as part of this one, and that file's bytes before the offset it has reached.
 */
interface Cursor {
	file: string;
	limit: number;
	open: SessionFile;
	lines: LineCursor;
}

let db: Database;
let dbPath = "";
let insertRow: Statement;
let saveFile: Statement;
let deleteRows: Statement;
const states = new Map<string, Indexed>();
const fileOfFid = new Map<number, string>();
/** How large each file is, as the server last said. */
const targets = new Map<string, FileState>();
/** Files whose index does not reach their size yet. */
const pending = new Set<string>();
/** Files a search asked about: indexed before the rest. */
const urgent: string[] = [];
let cursor: Cursor | null = null;

/** The cursor is dropped, and its file closed (a read in flight finishes first, and finds the file closed). */
function dropCursor(): void {
	cursor?.open.close();
	cursor = null;
}
let running = false;
let lastProgress = 0;
/** The database is closed (the server is stopping): nothing is written any more. */
let closed = false;
/** Rows in the index now, and rows removed from it since it was last compacted (kept in `meta`). */
let liveRows = 0;
let deadRows = 0;
/** Rows removed since the journal was last folded into the file. */
let removedSinceCheckpoint = 0;
/** Calls of `onFiles` that are still deleting the rows of files that went. */
let removing = 0;
let compacting = false;
let compactTimer: ReturnType<typeof setTimeout> | undefined;
/** When the work that is going on now began its slice (see `turn`). */
let sliceBegan = performance.now();
/** What a forgotten file's name in `files` ends with until its rows are deleted. */
const GONE = "\0gone";
/** Counts the databases opened: what a step began on another one (the file was damaged meanwhile) is not written to this. */
let generation = 0;

const post = (reply: Reply) => self.postMessage(reply);
const stats: IndexStats = { rows: 0, resets: 0, compactions: 0 };

function coverage(): Coverage {
	return { indexed: targets.size - pending.size, total: targets.size };
}

/**
 * How much of one file the index holds: the bytes of it that are in the index, of all there are (`total` is what the
 * server last said it is; a file the index was never told of is nothing of it). `complete` is not "every byte": the
 * index takes in whole lines, and a transcript that ends in one that is not whole (omp stopped in the middle of a
 * write, a truncated copy) has its last bytes left out until the writer finishes it. A file that has left `pending`
 * has been taken in as far as it will be, and the caller is not to wait for more of it (#544).
 */
function fileCoverage(file: string): FileCoverage {
	const target = targets.get(file);
	const st = states.get(file);
	const total = target?.size ?? st?.indexed ?? 0;
	const indexed = Math.min(st?.indexed ?? 0, total);
	return { indexed, total, complete: target !== undefined && st !== undefined && !pending.has(file) };
}

/** Let the loop turn once work has gone on for a slice, so that what arrived meanwhile (a search) is answered between two pieces of it. */
async function turn(): Promise<void> {
	if (performance.now() - sliceBegan < BATCH_MS) return;
	await yieldToLoop();
	sliceBegan = performance.now();
}

function setMeta(conn: Database, key: string, value: number): void {
	conn.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, String(value)]);
}

/**
 * Opens the index at `dbPath` and reads what it knows of each file; throws, closing it, when it is damaged. A file that is
 * a database at all and as long as its header says is taken as it is: the pages are not read until a query or an indexing
 * step needs them (a bad one is answered by `recover`), except after a process that did not close the file, whose
 * last writes may have been cut off (`wasLeftOpen`): then SQLite looks at every page.
 */
function openDatabase(path: string): void {
	checkHeader(path);
	const fresh = !existsSync(path) || statSync(path).size === 0;
	const conn = new Database(path, { create: true });
	try {
		// The full text of every conversation is in it: for its owner only, its journal files included.
		dropGroupAndOther(path);
		// Pages that deleted rows free can only be given back to the system when the file says so before its first table
		// (and before the journal mode, which writes the header): an older file is converted by a `VACUUM` in `compact`.
		if (fresh) conn.run("PRAGMA auto_vacuum = INCREMENTAL");
		conn.run("PRAGMA journal_mode = WAL");
		for (const side of ["-wal", "-shm"]) dropGroupAndOther(`${path}${side}`);
		// An index that can be rebuilt does not need a flush to disk per commit.
		conn.run("PRAGMA synchronous = NORMAL");
		conn.run(`PRAGMA journal_size_limit = ${WAL_LIMIT_BYTES}`);
		// A write that meets another connection's (another server that overlaps this one for a moment, a tool reading the file)
		// waits for it: failing would leave the file it was indexing out of the index until it changes again.
		conn.run("PRAGMA busy_timeout = 5000");
		conn.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
		if (wasLeftOpen(conn)) verify(conn);
		markOpen(conn);
		conn.run(
			"CREATE TABLE IF NOT EXISTS files (fid INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT NOT NULL UNIQUE, indexed INTEGER NOT NULL DEFAULT 0, tail TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL DEFAULT 0)",
		);
		conn.run(
			"CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(text, entry_id UNINDEXED, role UNINDEXED, ts UNINDEXED, tokenize = 'trigram')",
		);
		insertRow = conn.prepare("INSERT INTO fts (rowid, text, entry_id, role, ts) VALUES (?, ?, ?, ?, ?)");
		saveFile = conn.prepare("UPDATE files SET indexed = ?, tail = ?, seq = ? WHERE fid = ?");
		deleteRows = conn.prepare("DELETE FROM fts WHERE rowid >= ? AND rowid < ?");
		states.clear();
		fileOfFid.clear();
		liveRows = 0;
		for (const r of conn
			.query<{ fid: number; file: string; indexed: number; tail: string; seq: number }, []>(
				"SELECT fid, file, indexed, tail, seq FROM files",
			)
			.all()) {
			states.set(r.file, { fid: r.fid, indexed: r.indexed, tail: r.tail, seq: r.seq });
			fileOfFid.set(r.fid, r.file);
			liveRows += r.seq;
		}
		const dead = conn.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'dead'").get();
		if (dead) deadRows = Number(dead.value);
		else {
			// An index made before the rows removed were counted: files had numbers (`fid`) that are not in `files` any more, and
			// each of them held about what the files that are still there hold on average.
			const handedOut =
				conn.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'files'").get()?.seq ?? 0;
			deadRows = Math.round(Math.max(0, handedOut - states.size) * (liveRows / Math.max(1, states.size)));
			setMeta(conn, "dead", deadRows);
		}
		db = conn;
		dbPath = path;
		closed = false;
		removedSinceCheckpoint = 0;
		generation++;
	} catch (e) {
		try {
			conn.close();
		} catch {
			// what failed may be the file itself
		}
		throw e;
	}
}

/** A page of the index turned out to be damaged while it was in use: the file is kept aside, and everything is indexed again. */
function recover(e: unknown): void {
	clearTimeout(compactTimer);
	compactTimer = undefined;
	giveUp(dbPath, e, () => {
		for (const statement of [insertRow, saveFile, deleteRows]) statement.finalize();
		db.close();
	});
	openDatabase(dbPath);
	dropCursor();
	for (const file of targets.keys()) pending.add(file);
	void pump();
}

/** The server is stopping: what was written is folded into the file and the file is closed, so the next start knows it was. */
function closeDatabase(): void {
	if (closed) return;
	closed = true;
	clearTimeout(compactTimer);
	try {
		markClosed(db);
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		for (const statement of [insertRow, saveFile, deleteRows]) statement.finalize();
		db.close();
	} catch {
		// the file stays marked as open, and the next start checks it
	}
}

/** The journal folded into the file and cut off: after a delete that wrote a lot to it, it would otherwise stay as large as it got. */
function checkpoint(): void {
	removedSinceCheckpoint = 0;
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** The file's row ids are `[first, first + ROWS_PER_FILE)`. */
const firstRowId = (fid: number): number => fid * ROWS_PER_FILE;

function stateOf(file: string): Indexed {
	const known = states.get(file);
	if (known) return known;
	const { lastInsertRowid } = db.run("INSERT INTO files (file) VALUES (?)", [file]);
	const fid = Number(lastInsertRowid);
	const fresh: Indexed = { fid, indexed: 0, tail: "", seq: 0 };
	states.set(file, fresh);
	fileOfFid.set(fid, file);
	return fresh;
}

/** `rows` rows left the index: they are dead weight in it until it is compacted. */
function removed(rows: number): void {
	liveRows -= rows;
	deadRows += rows;
	removedSinceCheckpoint += rows;
	setMeta(db, "dead", deadRows);
}

/**
 * Delete the rows of `st`'s file, `DELETE_ROWS` to a transaction with the loop turning in between (the rows of a 300 MB
 * conversation take seconds to delete in one piece, and nothing else is answered meanwhile). False when the database was
 * closed or replaced meanwhile.
 */
async function deleteBlock(st: Indexed): Promise<boolean> {
	const gen = generation;
	const first = firstRowId(st.fid);
	const end = firstRowId(st.fid + 1);
	for (let at = first; at < first + st.seq; at += DELETE_ROWS) {
		// The last piece reaches to the end of the block, whatever was written past `seq`.
		const to = at + DELETE_ROWS >= first + st.seq ? end : at + DELETE_ROWS;
		db.transaction(() => deleteRows.run(at, to))();
		await turn();
		if (closed || gen !== generation) return false;
	}
	return true;
}

/** Drop what the index holds of a file, so that it is indexed again from the start. */
async function reset(st: Indexed): Promise<boolean> {
	stats.resets++;
	const rows = st.seq;
	if (!(await deleteBlock(st))) return false;
	db.transaction(() => {
		saveFile.run(0, "", 0, st.fid);
		removed(rows);
	})();
	st.indexed = 0;
	st.tail = "";
	st.seq = 0;
	dropCursor();
	if (removedSinceCheckpoint >= BULK_ROWS) checkpoint();
	return true;
}

/** The file is gone from every answer at once; its rows are deleted a piece at a time (a restart finishes what a stop left). */
async function forget(file: string): Promise<void> {
	targets.delete(file);
	pending.delete(file);
	const st = states.get(file);
	if (cursor?.file === file) dropCursor();
	if (!st) return;
	states.delete(file);
	fileOfFid.delete(st.fid);
	// A file of the same name may come back while the rows are deleted: the name is free at once. What a stop leaves of this
	// one is under the name it has now, which no list holds, and is finished after the next start.
	if (!file.endsWith(GONE)) db.run("UPDATE files SET file = ? WHERE fid = ?", [`${file}${GONE}`, st.fid]);
	const rows = st.seq;
	if (!(await deleteBlock(st))) return;
	db.transaction(() => {
		db.run("DELETE FROM files WHERE fid = ?", [st.fid]);
		removed(rows);
	})();
}

async function onFiles(
	files: { file: string; size: number; mtime: number }[],
	gone: string[],
	full: boolean,
): Promise<void> {
	// What there is to index is known now, and indexing starts while the rows of the files that went are deleted.
	for (const f of files) {
		const before = targets.get(f.file);
		targets.set(f.file, { size: f.size, mtime: f.mtime });
		// A file that was written to without growing may have been rewritten: `step` checks the bytes it indexed.
		const touched = before !== undefined && before.mtime !== f.mtime;
		// Its open file may be the one before the write: the next step opens it again.
		if (touched && cursor?.file === f.file) dropCursor();
		if (touched || states.get(f.file)?.indexed !== f.size) pending.add(f.file);
		else pending.delete(f.file);
	}
	void pump();
	const listed = new Set(files.map((f) => f.file));
	// A full list is every file there is: what is indexed of any other file (deleted or moved while no server ran) goes.
	const leaving = full ? [...states.keys()].filter((file) => !listed.has(file)) : [];
	removing++;
	try {
		for (const file of [...leaving, ...gone]) {
			await forget(file);
			await turn();
		}
		// Many files forgotten at once (a library deleted or moved) wrote a lot to the journal: it is folded in now, not when it fills.
		if (!closed && removedSinceCheckpoint >= BULK_ROWS) checkpoint();
	} finally {
		removing--;
		wake();
	}
	scheduleCompaction();
}

/** The file to work on next: one a search asked about, else the one most recently written to. */
function pick(): string | null {
	while (urgent.length) {
		const file = urgent[0] as string;
		if (pending.has(file)) return file;
		urgent.shift();
	}
	if (cursor && pending.has(cursor.file)) return cursor.file;
	let best: string | null = null;
	let bestAt = -1;
	for (const file of pending) {
		const at = targets.get(file)?.mtime ?? 0;
		if (at > bestAt) {
			best = file;
			bestAt = at;
		}
	}
	return best;
}

interface Row {
	rowid: number;
	text: string;
	entryId: string;
	role: string;
	ts: string;
}

/** Index about `BATCH_MS` of the next lines of `file`. */
async function step(file: string): Promise<void> {
	const target = targets.get(file);
	if (!target) {
		pending.delete(file);
		return;
	}
	const gen = generation;
	const st = stateOf(file);
	if (!(cursor?.file === file && cursor.limit === target.size && cursor.open.isOpen)) {
		dropCursor();
		// Opened once: what is checked, read and fingerprinted below is of this file, whatever the path is replaced with.
		const open = SessionFile.open(file);
		if (!open) {
			// Gone since it was listed: the server says so.
			pending.delete(file);
			return;
		}
		// Whatever indexed bytes this run did not write itself must still be what this file says.
		if (st.indexed > target.size || (st.indexed > 0 && open.windowHash(st.indexed) !== st.tail)) {
			if (!(await reset(st))) {
				open.close();
				return;
			}
		}
		if (st.indexed >= target.size) {
			open.close();
			pending.delete(file);
			return;
		}
		cursor = { file, limit: target.size, open, lines: open.lines(st.indexed, target.size) };
	}
	const { lines, open, limit } = cursor;
	const rows: Row[] = [];
	const began = performance.now();
	let consumed = st.indexed;
	let seq = st.seq;
	let exhausted = false;
	for (;;) {
		const line = await lines.next();
		if (!line) {
			exhausted = true;
			break;
		}
		const obj = parseLine(line.text);
		// The writer may be in the middle of this line: it is indexed once it is whole.
		if (!obj && !line.terminated && line.text.trim()) {
			exhausted = true;
			break;
		}
		consumed = line.end;
		if (obj && typeof obj.id === "string") {
			const s = searchableText(obj as SessionEntry);
			if (s && seq < ROWS_PER_FILE) {
				rows.push({
					rowid: firstRowId(st.fid) + seq++,
					text: s.text,
					entryId: obj.id,
					role: s.role,
					ts: typeof obj.timestamp === "string" ? obj.timestamp : "",
				});
			}
		}
		if (rows.length >= BATCH_ROWS || performance.now() - began > BATCH_MS) break;
	}
	// The database may have been closed or replaced while the lines were read, and the file forgotten (or reported as
	// changed, which closes its open file: what was read since is of a file that is no longer the one to index): this step
	// is of the database it began on, and of a file that is still there.
	if (closed || gen !== generation || states.get(file) !== st || !open.isOpen) return;
	if (consumed !== st.indexed) {
		const tail = open.windowHash(consumed);
		db.transaction(() => {
			for (const r of rows) insertRow.run(r.rowid, r.text, r.entryId, r.role, r.ts);
			stats.rows += rows.length;
			liveRows += rows.length;
			saveFile.run(consumed, tail, seq, st.fid);
		})();
		st.indexed = consumed;
		st.tail = tail;
		st.seq = seq;
	}
	// Done with what was asked for: the whole file, or all of it that is complete lines. A file that grew
	// meanwhile was reported again, and its next request is for more than this cursor's limit.
	if (exhausted && limit === targets.get(file)?.size) {
		pending.delete(file);
		dropCursor();
	}
}

function reportProgress(force: boolean): void {
	const now = performance.now();
	if (!force && now - lastProgress < PROGRESS_MS) return;
	lastProgress = now;
	post({ t: "progress", coverage: coverage() });
}

/** Index until nothing is pending, between messages. */
async function pump(): Promise<void> {
	if (running) return;
	running = true;
	try {
		for (let file = pick(); file !== null && !closed; file = pick()) {
			try {
				await step(file);
			} catch (e) {
				if (isDamage(e)) {
					// A page of the index is bad: it is started again and every file is to be indexed again, this one included.
					recover(e);
					continue;
				}
				// One file that cannot be indexed (gone mid-read, a broken line) must not stop the rest.
				console.error(`search index: ${file}: ${e instanceof Error ? e.message : String(e)}`);
				pending.delete(file);
				dropCursor();
			}
			reportProgress(false);
			wake();
			await yieldToLoop();
		}
	} finally {
		running = false;
	}
	reportProgress(true);
	wake();
	scheduleCompaction();
}

/** Whether what was removed from the index is enough of it to be worth compacting. */
function compactionWanted(): boolean {
	return deadRows >= COMPACT_MIN_DEAD && deadRows >= COMPACT_DEAD_SHARE * (deadRows + liveRows);
}

/** Compact the index once nothing has been asked of it for a moment: whoever deleted a hundred files is probably not done. */
function scheduleCompaction(): void {
	if (closed || compacting || compactTimer !== undefined || !compactionWanted()) return;
	compactTimer = setTimeout(() => {
		compactTimer = undefined;
		void compact();
	}, COMPACT_DELAY_MS);
}

/** Compact now if it is due, and answer when that is done: no waiting for a quiet moment (for whoever must see the file as small as it gets). */
async function compactNow(): Promise<void> {
	clearTimeout(compactTimer);
	compactTimer = undefined;
	await waitFor(() => !compacting, Number.POSITIVE_INFINITY);
	while (compactionWanted() && !closed) {
		await waitFor(idle, Number.POSITIVE_INFINITY);
		const done = stats.compactions;
		await compact();
		// Nothing came of it with nothing else to do (it failed, and said so): not again.
		if (stats.compactions === done && idle()) return;
	}
}

const pragma = (name: string): number =>
	Object.values(db.query<Record<string, number>, []>(`PRAGMA ${name}`).get() ?? { n: 0 })[0] ?? 0;
const totalChanges = (): number => db.query<{ c: number }, []>("SELECT total_changes() AS c").get()?.c ?? 0;

/**
 * Give back what removed rows took. FTS5 merges its segments a few pages at a time (`merge` with a negative count does what
 * `optimize` does, in steps of about 100 ms, each its own transaction), which leaves the pages they free on the freelist;
 * `incremental_vacuum` hands those back to the system, in steps as well. Between two steps the worker answers what was asked
 * meanwhile, and indexing a file that changed goes first: the work is taken up again after it.
 */
async function compact(): Promise<void> {
	if (compacting || closed) return;
	compacting = true;
	const gen = generation;
	const deadAtStart = deadRows;
	try {
		for (;;) {
			if (closed || gen !== generation) return;
			if (pending.size > 0 || running) return;
			const before = totalChanges();
			db.run("INSERT INTO fts(fts, rank) VALUES('merge', ?)", [-MERGE_PAGES]);
			// A step that had nothing to merge counts as one change (its own row).
			if (totalChanges() - before <= 1) break;
			await yieldToLoop();
		}
		const free = pragma("freelist_count");
		const pages = pragma("page_count");
		if (pragma("auto_vacuum") === 2) {
			for (let left = free; left > 0; left = pragma("freelist_count")) {
				if (closed || gen !== generation) return;
				db.run(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`);
				await yieldToLoop();
			}
		} else if (free >= VACUUM_FREE_SHARE * pages) {
			// A file made before `auto_vacuum` was asked for: once, it is rewritten, and kept in that mode from then on.
			db.run("PRAGMA auto_vacuum = INCREMENTAL");
			db.run("VACUUM");
		}
		// What was removed while it ran is still to be compacted.
		deadRows = Math.max(0, deadRows - deadAtStart);
		setMeta(db, "dead", deadRows);
		checkpoint();
		stats.compactions++;
	} catch (e) {
		if (isDamage(e)) recover(e);
		else console.error(`search index: compaction: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		compacting = false;
	}
	wake();
}

interface Waiter {
	done(): boolean;
	resolve(): void;
}
let waiters: Waiter[] = [];

/** Let everyone whose wait is over go on. */
function wake(): void {
	const stillWaiting: Waiter[] = [];
	for (const w of waiters) {
		if (w.done()) w.resolve();
		else stillWaiting.push(w);
	}
	waiters = stillWaiting;
}

/** Resolves when `done()` holds, or after `ms`. */
function waitFor(done: () => boolean, ms: number): Promise<void> {
	if (done()) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	// `setTimeout` takes an infinite delay for 1 ms.
	const timer = Number.isFinite(ms) ? setTimeout(resolve, ms) : undefined;
	waiters.push({
		done,
		resolve: () => {
			clearTimeout(timer);
			resolve();
		},
	});
	return promise;
}

/** Everything told about is indexed (what a search waits for). */
const indexed = (): boolean => pending.size === 0 && !running;
/** And the rows of the files that went are deleted. */
const idle = (): boolean => indexed() && removing === 0;

/** The words of `q` for a search that matches every word in any order (#717); one entry for a phrase search. */
function termsOf(req: SearchRequest): string[] {
	if (!req.words) return [req.q];
	const words = [...new Set(req.q.split(/\s+/).filter(Boolean))];
	return words.length ? words : [req.q];
}

/** An FTS5 query that matches every term as a phrase of its own (FTS5 ANDs adjacent phrases). */
const ftsQuery = (terms: readonly string[]): string => terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");

function search(req: SearchRequest): RawHit[] {
	const terms = termsOf(req);
	const q = terms[0] as string;
	const only = req.file === undefined ? null : (states.get(req.file) ?? null);
	if (req.file !== undefined && !only) return [];
	// Trigram FTS needs ≥3 characters in every term; a shorter one makes the whole search an unranked substring scan.
	const ranked = terms.every((t) => [...t].length >= 3);
	const range: [number, number] | [] = only ? [firstRowId(only.fid), firstRowId(only.fid + 1)] : [];
	type Match = { rid: number; fid: number; total: number };
	const where = only ? "AND rowid >= ? AND rowid < ?" : "";
	const scan = terms.map(() => "instr(lower(text), lower(?)) > 0").join(" AND ");
	const matches = ranked
		? db
				.query<Match, (string | number)[]>(
					`WITH m AS (
						SELECT rowid AS rid, rowid >> 24 AS fid, rank AS r,
							row_number() OVER (PARTITION BY rowid >> 24 ORDER BY rank, rowid) AS n,
							count(*) OVER (PARTITION BY rowid >> 24) AS total
						FROM fts WHERE fts MATCH ? ${where}
					) SELECT rid, fid, total FROM m WHERE n <= ? ORDER BY r, rid`,
				)
				.all(ftsQuery(terms), ...range, req.cap)
		: db
				.query<Match, (string | number)[]>(
					`WITH m AS (
						SELECT rowid AS rid, rowid >> 24 AS fid,
							row_number() OVER (PARTITION BY rowid >> 24 ORDER BY rowid) AS n,
							count(*) OVER (PARTITION BY rowid >> 24) AS total
						FROM fts WHERE ${scan} ${where}
					) SELECT rid, fid, total FROM m WHERE n <= ? ORDER BY rid`,
				)
				.all(...terms, ...range, req.cap);

	// Matches arrive best-first, so grouping by first appearance orders conversations by their best hit.
	const groups = new Map<number, Match[]>();
	for (const m of matches) {
		const g = groups.get(m.fid);
		if (g) g.push(m);
		else groups.set(m.fid, [m]);
	}
	const picked: { match: Match; more: number }[] = [];
	for (const g of groups.values()) {
		const take = g.slice(0, req.max - picked.length);
		take.forEach((match, i) => {
			const more = i === take.length - 1 ? match.total - take.length : 0;
			picked.push({ match, more });
		});
		if (picked.length >= req.max) break;
	}
	if (!picked.length) return [];

	// Snippets are the costly part of a hit: build them only for the rows that survived.
	const rids = JSON.stringify(picked.map((p) => p.match.rid));
	type Snip = { rid: number; entry_id: string; role: string; ts: string; snippet: string };
	const rows = ranked
		? db
				.query<Snip, [string, string]>(
					`SELECT rowid AS rid, entry_id, role, ts, snippet(fts, 0, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 24) AS snippet FROM fts WHERE fts MATCH ?1 AND rowid IN (SELECT value FROM json_each(?2))`,
				)
				.all(ftsQuery(terms), rids)
		: db
				.query<Snip & { start: number; total: number }, [string, string]>(
					`SELECT rowid AS rid, entry_id, role, ts, substr(text, max(1, instr(lower(text), lower(?1)) - ${SHORT_BEFORE}), ${SHORT_LENGTH}) AS snippet, max(1, instr(lower(text), lower(?1)) - ${SHORT_BEFORE}) AS start, length(text) AS total FROM fts WHERE rowid IN (SELECT value FROM json_each(?2))`,
				)
				.all(q, rids)
				.map(({ start, total, ...row }) => ({ ...row, snippet: shortSnippet(row.snippet, q, start, total) }));
	const byRid = new Map(rows.map((r) => [r.rid, r]));
	const hits: RawHit[] = [];
	for (const { match, more } of picked) {
		const r = byRid.get(match.rid);
		const file = fileOfFid.get(match.fid);
		if (!r || file === undefined) continue;
		hits.push({ file, entryId: r.entry_id, role: r.role, snippet: r.snippet, timestamp: r.ts, more });
	}
	return hits;
}

/** False until the database is open: a worker that could not open it (its directory is gone) indexes nothing and answers searches with an error. */
let opened = false;

self.onmessage = async (event: MessageEvent<Job>) => {
	const job = event.data;
	try {
		if (job.t === "open") {
			// A damaged index is moved aside and started again: it is only what the session files say (`db-recover.ts`).
			openRebuildable(job.dbPath, () => openDatabase(job.dbPath));
			opened = true;
			return;
		}
		if (job.t === "close") {
			// The server waits on this (`SearchIndex.close`) before it ends the thread: the file must be closed by then.
			if (opened) closeDatabase();
			Atomics.store(job.done, 0, 1);
			Atomics.notify(job.done, 0);
			return;
		}
		if (!opened) {
			if (job.t === "files") return;
			throw new Error("The search index is not open");
		}
		if (closed) return;
		switch (job.t) {
			case "files":
				await onFiles(job.files, job.gone, job.full === true);
				return;
			case "flush":
				await waitFor(idle, Number.POSITIVE_INFINITY);
				if (job.compact) await compactNow();
				post({ t: "flushed", id: job.id, coverage: coverage(), stats });
				return;
			case "search": {
				// The page that asked has moved on (the server sets the flag when the request is dropped): the answer would go to
				// nobody, and the query is the costly part of a search.
				const cancelled = () => Atomics.load(job.cancel, 0) === 1;
				if (cancelled()) {
					post({ t: "result", id: job.id, hits: [], coverage: coverage() });
					return;
				}
				const { file } = job.req;
				if (file !== undefined && pending.has(file)) urgent.push(file);
				void pump();
				// A library that is still being indexed for the first time is not waited for beyond this. A conversation the
				// search names is waited for until it is whole: it is the one file the caller is sure about, and an answer
				// from a half-indexed one would claim that a conversation was searched when it was not (#509). How long that
				// takes is the size of the file, not a fixed moment: the bound is the file's own.
				if (file === undefined) await waitFor(indexed, job.req.waitMs);
				else await waitFor(() => !pending.has(file), job.req.fileWaitMs ?? job.req.waitMs);
				let hits: RawHit[] = [];
				// Not answered from a closed file (the server is stopping); one that turns out damaged is started again, and what
				// it held is back as it is indexed (the answer says how much of that is: `coverage`).
				if (!closed && !cancelled()) {
					try {
						hits = search(job.req);
					} catch (e) {
						if (!isDamage(e)) throw e;
						recover(e);
					}
				}
				// What of the named conversation the answer is from: a caller that asked for one file must know whether it
				// was searched in full, or the empty answer it got would read as "nothing in it" (it was not searched).
				post({
					t: "result",
					id: job.id,
					hits,
					coverage: coverage(),
					...(file === undefined ? {} : { file: fileCoverage(file) }),
				});
				return;
			}
		}
	} catch (e) {
		const id = job.t === "search" || job.t === "flush" ? job.id : null;
		let message = e instanceof Error ? e.message : String(e);
		if (isDamage(e) && opened && !closed) {
			try {
				recover(e);
			} catch (again) {
				message = again instanceof Error ? again.message : String(again);
			}
		}
		post({ t: "error", id, message });
	}
};
