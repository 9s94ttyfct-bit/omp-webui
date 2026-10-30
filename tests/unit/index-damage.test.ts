import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { checkHeader, DatabaseDamaged, isDamage, openRebuildable } from "../../server/db-recover.ts";
import { SessionStore } from "../../server/sessions/store.ts";

/**
 * `index.db` (session summaries) and `index.search.db` (full-text index) are caches that omp's session files rebuild.
 * A damaged one used to end the server at every start (`SQLiteError: file is not a database`, `database disk image is
 * malformed`: #312); it is moved aside, with a line in the log, and built again.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-damage-"));
const sessions = join(root, "sessions");
const bucket = join(sessions, "-tmp-damage");
const SESSIONS = 80;
let n = 0;

function writeSession(i: number): void {
	const id = `01a00000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`;
	const stamp = new Date(Date.UTC(2026, 0, 7, 0, i)).toISOString();
	const lines = [
		{ type: "session", version: 3, id, timestamp: stamp, cwd: `/tmp/damage-${i}` },
		{
			type: "message",
			id: `m${i}`,
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: [{ type: "text", text: `loquat ${i} ${"orchard ".repeat(40)}` }] },
		},
	];
	writeFileSync(
		join(bucket, `2026-01-07T00-00-00-000Z_${id}.jsonl`),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
}

/** A data dir whose caches were built from the sessions, and closed: files as a server that quit leaves them. */
async function builtCaches(): Promise<string> {
	const dir = join(root, `data-${++n}`);
	mkdirSync(dir, { recursive: true });
	const store = new SessionStore(sessions, join(dir, "index.db"));
	await store.indexed();
	store.close();
	return dir;
}

const warned = spyOn(console, "warn").mockImplementation(() => {});
beforeAll(() => {
	mkdirSync(bucket, { recursive: true });
	for (let i = 0; i < SESSIONS; i++) writeSession(i);
});
afterEach(() => warned.mockClear());
afterAll(() => {
	warned.mockRestore();
	rmSync(root, { recursive: true, force: true });
});

const damages: [string, (file: string) => void][] = [
	["text that is no database", (file) => writeFileSync(file, "this is not a sqlite database".repeat(100))],
	["a file cut short", (file) => truncateSync(file, Math.floor(statSync(file).size * 0.6) - 17)],
	[
		"one page written over",
		(file) => {
			const fd = openSync(file, "r+");
			writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, 4096 * 2);
		},
	],
];

for (const [kind, damage] of damages) {
	test(`index.db damaged as ${kind}: the store opens, the old file is kept aside, and the list is built again`, async () => {
		const dir = await builtCaches();
		const db = join(dir, "index.db");
		const before = statSync(db).size;
		expect(before).toBeGreaterThan(4096 * 3);
		damage(db);
		const store = new SessionStore(sessions, db);
		try {
			expect(await store.list()).toHaveLength(SESSIONS);
			expect(existsSync(`${db}.damaged`)).toBe(true);
			expect(warned.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
				/index\.db is damaged .*moved to .*index\.db\.damaged/,
			);
			// The new file is a working one: another start reads it without complaint.
			await store.indexed();
		} finally {
			store.close();
		}
		warned.mockClear();
		const again = new SessionStore(sessions, db);
		try {
			expect(await again.list()).toHaveLength(SESSIONS);
			expect(warned).not.toHaveBeenCalled();
		} finally {
			again.close();
		}
	});
}

test("index.db that is empty or missing is just built, with nothing to report", async () => {
	const dir = join(root, `data-${++n}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "index.db"), "");
	const store = new SessionStore(sessions, join(dir, "index.db"));
	try {
		expect(await store.list()).toHaveLength(SESSIONS);
		expect(existsSync(join(dir, "index.db.damaged"))).toBe(false);
		expect(warned).not.toHaveBeenCalled();
	} finally {
		store.close();
	}
});

test("a summary that is not the JSON that was stored counts as damage too", async () => {
	const dir = await builtCaches();
	const db = join(dir, "index.db");
	const raw = new Database(db);
	raw.run("UPDATE sessions SET summary = '{ not json'");
	raw.close();
	const store = new SessionStore(sessions, db);
	try {
		expect(await store.list()).toHaveLength(SESSIONS);
		expect(existsSync(`${db}.damaged`)).toBe(true);
	} finally {
		store.close();
	}
});

test("index.search.db that is not a database: the worker moves it aside and searches work again", async () => {
	const dir = await builtCaches();
	const search = join(dir, "index.search.db");
	writeFileSync(search, "garbage".repeat(2000));
	for (const side of ["-wal", "-shm"]) rmSync(`${search}${side}`, { force: true });
	const store = new SessionStore(sessions, join(dir, "index.db"));
	try {
		await store.indexed();
		const hits = await store.search("loquat", 200);
		expect(hits.length).toBeGreaterThan(0);
		expect(existsSync(`${search}.damaged`)).toBe(true);
	} finally {
		store.close();
	}
});

test("a second damage replaces the file kept for the first: one is kept, not one per start", async () => {
	const dir = await builtCaches();
	const db = join(dir, "index.db");
	for (let round = 0; round < 2; round++) {
		writeFileSync(db, "not a database".repeat(50));
		const store = new SessionStore(sessions, db);
		try {
			expect(await store.list()).toHaveLength(SESSIONS);
			await store.indexed();
		} finally {
			store.close();
		}
	}
	expect(existsSync(`${db}.damaged`)).toBe(true);
	expect(existsSync(`${db}.damaged.damaged`)).toBe(false);
});

test("isDamage names damage, not a busy or unreadable database", () => {
	expect(isDamage(Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" }))).toBe(true);
	expect(isDamage(Object.assign(new Error("malformed"), { code: "SQLITE_CORRUPT" }))).toBe(true);
	expect(isDamage(Object.assign(new Error("malformed"), { code: "SQLITE_CORRUPT_VTAB" }))).toBe(true);
	expect(isDamage(new SyntaxError("JSON Parse error"))).toBe(true);
	expect(isDamage(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }))).toBe(false);
	expect(isDamage(Object.assign(new Error("unable to open"), { code: "SQLITE_CANTOPEN" }))).toBe(false);
	expect(isDamage(new Error("anything else"))).toBe(false);
	// A busy database is the caller's: nothing is moved, nothing is retried.
	let opened = 0;
	expect(() =>
		openRebuildable(join(root, "never-touched.db"), () => {
			opened++;
			throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
		}),
	).toThrow("locked");
	expect(opened).toBe(1);
});

/**
 * A start does not read every page of the files (about 14 ms per MB: seconds before search is ready, for an index of a
 * big library): the header is looked at, and every page only when the process before did not close the file. A bad page
 * that is read later is answered when it is read.
 */

/** Every page of the full-text index's data and content that is not a root page: what holds rows, and what opening reads, not. */
function rowPages(file: string): number[] {
	const raw = new Database(file, { readonly: true });
	try {
		return raw
			.query<{ pageno: number }, []>(
				"SELECT pageno FROM dbstat WHERE name IN ('fts_data', 'fts_content') AND path != '/'",
			)
			.all()
			.map((r) => r.pageno);
	} finally {
		raw.close();
	}
}

/** Those pages written over. */
function writeOverRowPages(file: string): void {
	const pages = rowPages(file);
	expect(pages.length).toBeGreaterThan(20);
	const fd = openSync(file, "r+");
	try {
		for (const page of pages) writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, (page - 1) * 4096);
	} finally {
		closeSync(fd);
	}
}

function markLeftOpen(file: string): void {
	const raw = new Database(file);
	raw.run("UPDATE meta SET value = '0' WHERE key = 'clean'");
	raw.run("PRAGMA wal_checkpoint(TRUNCATE)");
	raw.close();
}

/** A library with enough rows for the full-text index to have pages besides its roots. */
function writeManySessions(dir: string, count: number): string {
	const b = join(dir, "sessions", "-tmp-many");
	mkdirSync(b, { recursive: true });
	for (let i = 0; i < count; i++) {
		const id = `01a00000-0000-7000-8000-${(i + 5000).toString(16).padStart(12, "0")}`;
		const lines = [
			{ type: "session", version: 3, id, timestamp: "2026-01-07T00:00:00.000Z", cwd: `/tmp/many-${i % 7}` },
		];
		for (let m = 0; m < 8; m++) {
			lines.push({
				type: "message",
				id: `m${i}-${m}`,
				parentId: m ? `m${i}-${m - 1}` : (null as never),
				timestamp: "2026-01-07T00:00:00.000Z",
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: `quince ${i} ${m} ${"harvest ".repeat(20)} ${(i * 7919 + m * 104729).toString(36).repeat(6)}`,
						},
					],
				},
			} as never);
		}
		writeFileSync(
			join(b, `2026-01-07T00-00-00-000Z_${id}.jsonl`),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);
	}
	return join(dir, "sessions");
}

async function manyCaches(): Promise<{ dir: string; sessionsDir: string }> {
	const dir = join(root, `data-${++n}`);
	mkdirSync(dir, { recursive: true });
	const sessionsDir = writeManySessions(dir, 250);
	const store = new SessionStore(sessionsDir, join(dir, "index.db"));
	await store.indexed();
	store.close();
	return { dir, sessionsDir };
}

test("closing a store says so in both databases, and folds the search index's journal into its file", async () => {
	const dir = join(root, `data-${++n}`);
	mkdirSync(dir, { recursive: true });
	const store = new SessionStore(sessions, join(dir, "index.db"));
	await store.indexed();
	const clean = (file: string) => {
		const raw = new Database(file, { readonly: true });
		try {
			return raw.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'clean'").get()?.value;
		} finally {
			raw.close();
		}
	};
	// While a process has them open they say they are: a kill leaves it that way.
	expect(clean(join(dir, "index.db"))).toBe("0");
	expect(clean(join(dir, "index.search.db"))).toBe("0");
	store.close();
	expect(clean(join(dir, "index.db"))).toBe("1");
	expect(clean(join(dir, "index.search.db"))).toBe("1");
	expect(existsSync(join(dir, "index.search.db-wal")) ? statSync(join(dir, "index.search.db-wal")).size : 0).toBe(0);
});

test("index.search.db with bad pages that only a full check would find: the start leaves them, the search that reads them starts the index again", async () => {
	const { dir, sessionsDir } = await manyCaches();
	const search = join(dir, "index.search.db");
	expect(statSync(search).size).toBeGreaterThan(4096 * 40);
	writeOverRowPages(search);
	const store = new SessionStore(sessionsDir, join(dir, "index.db"));
	try {
		await store.indexed();
		// Nothing has read those pages: no check at the start, nothing moved aside.
		expect(existsSync(`${search}.damaged`)).toBe(false);
		expect(warned).not.toHaveBeenCalled();
		// A search reads them, and is answered all the same.
		await store.search("quince", 50);
		expect(existsSync(`${search}.damaged`)).toBe(true);
		// What the index held is indexed again from the session files.
		await store.indexed();
		const hits = await store.search("quince", 200);
		expect(new Set(hits.map((h) => h.file)).size).toBeGreaterThan(50);
	} finally {
		store.close();
	}
});

test("index.search.db with bad pages after a process that did not close it: the start looks at every page", async () => {
	const { dir, sessionsDir } = await manyCaches();
	const search = join(dir, "index.search.db");
	writeOverRowPages(search);
	markLeftOpen(search);
	const store = new SessionStore(sessionsDir, join(dir, "index.db"));
	try {
		await store.indexed();
		expect(existsSync(`${search}.damaged`)).toBe(true);
		expect((await store.search("quince", 200)).length).toBeGreaterThan(50);
	} finally {
		store.close();
	}
});

/** The root page of the index behind `session_state`'s primary key: written to by every summary, read by none at the start. */
function stateIndexPage(file: string): number {
	const raw = new Database(file, { readonly: true });
	try {
		return (
			raw
				.query<{ p: number }, []>(
					"SELECT rootpage AS p FROM sqlite_master WHERE name = 'sqlite_autoindex_session_state_1'",
				)
				.get()?.p ?? 0
		);
	} finally {
		raw.close();
	}
}

function writeOverPage(file: string, page: number): void {
	const fd = openSync(file, "r+");
	try {
		writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, (page - 1) * 4096);
	} finally {
		closeSync(fd);
	}
}

test("index.db with a bad page the start does not read: the first write that meets it moves the file aside and the list is built again", async () => {
	const dir = await builtCaches();
	const db = join(dir, "index.db");
	writeOverPage(db, stateIndexPage(db));
	const store = new SessionStore(sessions, db);
	try {
		expect(await store.list()).toHaveLength(SESSIONS);
		expect(existsSync(`${db}.damaged`)).toBe(false);
		// A conversation grows: its summary is written, and the write needs the bad page.
		const file = join(
			bucket,
			`2026-01-07T00-00-00-000Z_01a00000-0000-7000-8000-${(3).toString(16).padStart(12, "0")}.jsonl`,
		);
		appendFileSync(
			file,
			`${JSON.stringify({ type: "message", id: "late", parentId: "m3", timestamp: "2026-01-07T01:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "later" }] } })}\n`,
		);
		await store.refresh(true);
		const list = await store.list();
		expect(list).toHaveLength(SESSIONS);
		expect(list.find((x) => x.file.endsWith(basename(file)))?.messageCount).toBe(2);
		expect(existsSync(`${db}.damaged`)).toBe(true);
		expect(warned.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/index\.db is damaged .*moved to/);
	} finally {
		store.close();
	}
});

test("index.db with that bad page after a process that did not close it: the start finds it", async () => {
	const dir = await builtCaches();
	const db = join(dir, "index.db");
	writeOverPage(db, stateIndexPage(db));
	markLeftOpen(db);
	const store = new SessionStore(sessions, db);
	try {
		expect(existsSync(`${db}.damaged`)).toBe(true);
		expect(await store.list()).toHaveLength(SESSIONS);
	} finally {
		store.close();
	}
});

test("a header that is not an SQLite database's, or says the file is longer than it is, is damage without a page being read", () => {
	const text = join(root, "header-text.db");
	writeFileSync(text, "this is not a sqlite database".repeat(100));
	expect(() => checkHeader(text)).toThrow(DatabaseDamaged);
	const short = join(root, "header-short.db");
	writeFileSync(short, "SQLite");
	expect(() => checkHeader(short)).toThrow(DatabaseDamaged);

	const good = join(root, "header-good.db");
	const raw = new Database(good);
	raw.run("PRAGMA journal_mode = WAL");
	raw.run("CREATE TABLE t (x TEXT)");
	for (let i = 0; i < 200; i++) raw.run("INSERT INTO t VALUES (?)", [`row ${i} ${"x".repeat(200)}`]);
	// Still open, with the journal not folded in: what a running server's files look like.
	expect(() => checkHeader(good)).not.toThrow();
	raw.run("PRAGMA wal_checkpoint(TRUNCATE)");
	raw.close();
	expect(() => checkHeader(good)).not.toThrow();
	truncateSync(good, Math.floor(statSync(good).size / 2) - 11);
	expect(() => checkHeader(good)).toThrow(/header says/);

	// Nothing there, or an empty file, is a new database.
	expect(() => checkHeader(join(root, "header-missing.db"))).not.toThrow();
	const empty = join(root, "header-empty.db");
	writeFileSync(empty, "");
	expect(() => checkHeader(empty)).not.toThrow();
});
