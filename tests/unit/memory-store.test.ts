import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	bankFiles,
	bankInfo,
	findBank,
	layoutOf,
	layoutProblem,
	listMemories,
	MemoryError,
	MemoryWriter,
	readMemory,
} from "../../server/memory/store.ts";
import {
	MEMORY_CONTENT_MAX,
	MEMORY_KINDS,
	MEMORY_PAGE,
	MEMORY_PREVIEW_CHARS,
	type MemoryQuery,
} from "../../shared/memory.ts";
import { insertDerived, type MemoryFixture, memoryFixture } from "../support/mnemopi-store.ts";

/**
 * omp's long-term memory as the Memory page reads and changes it (`server/memory/store.ts`), against databases that have
 * the tables, indexes and triggers omp 18.12.6 makes. Never a real agent directory: each test's store is a folder of its own.
 * The real omp is `tests/contract/memory.test.ts`.
 */

const NOW = "2026-10-23T12:00:00.000Z";
/** Let the process's pipes and sockets have a turn (a loop of changes settles in microtasks alone, which never gives them one). */
const yieldToIo = (): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
};
const ALL = (over: Partial<MemoryQuery> = {}): MemoryQuery => ({
	q: "",
	scope: "all",
	bank: "",
	kinds: [...MEMORY_KINDS],
	retired: "active",
	limit: MEMORY_PAGE,
	offset: 0,
	...over,
});
const rejects = async (promise: Promise<unknown>): Promise<MemoryError> => {
	try {
		await promise;
	} catch (e) {
		expect(e).toBeInstanceOf(MemoryError);
		return e as MemoryError;
	}
	throw new Error("expected a MemoryError");
};
const rowsOf = (path: string, sql: string, ...params: string[]): Record<string, unknown>[] => {
	const db = new Database(path, { readonly: true });
	try {
		return db.query<Record<string, unknown>, string[]>(sql).all(...params);
	} finally {
		db.close();
	}
};
const count = (path: string, table: string, where = "1"): number =>
	(rowsOf(path, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)[0]?.n as number) ?? -1;

/** A shared bank and some projects: the layout of a person who uses omp with `per-project-tagged` scoping. */
function seeded(): MemoryFixture {
	const fx = memoryFixture();
	fx.bank("default", {
		working: [
			{
				id: "g1",
				content: "Prefers tabs over spaces in every project.",
				source: "coding-agent-learn",
				timestamp: "2026-10-12T09:00:00.000Z",
				metadata: { session_id: "sess-g1", cwd: "/work/app", context: "Said so in the review", tool: "learn" },
				consolidatedAt: "2026-10-13T00:00:00.000Z",
				embedded: true,
			},
			{
				id: "g2",
				content: "user: rename the module\nassistant: done",
				source: "coding-agent-transcript",
				timestamp: "2026-10-11T09:00:00.000Z",
				memoryType: "episode",
				metadata: { session_id: "sess-g2", cwd: "/work/app", message_count: 2 },
			},
		],
		episodic: [
			{ id: "gE1", content: "Prefers tabs. (consolidated)", summaryOf: "g1", timestamp: "2026-10-13T09:00:00.000Z" },
		],
	}).close();
	fx.bank("app-abc123", {
		working: [
			{ id: "p1", content: "The build needs bun 1.4.", timestamp: "2026-10-14T09:00:00.000Z", embedded: true },
			{
				id: "p2",
				content: "Old advice about webpack.",
				timestamp: "2026-10-09T09:00:00.000Z",
				validUntil: "2026-10-10T00:00:00.000Z",
			},
			{ id: "p3", content: "Superseded advice.", timestamp: "2026-10-08T09:00:00.000Z", supersededBy: "p1" },
		],
	}).close();
	fx.bank("ompw-offline-x1", {
		working: [{ id: "s1", content: "scratch of this app's own helper conversation" }],
	}).close();
	fx.bank("empty-1").close();
	return fx;
}

const bankOf = (layout: Parameters<typeof findBank>[0], name: string) => {
	const file = findBank(layout, name);
	if (!file) throw new Error(`no bank ${name}`);
	return file;
};
const memoryOf = (file: Parameters<typeof readMemory>[0], id: string, now: string) => {
	const memory = readMemory(file, id, now);
	if (!memory) throw new Error(`no memory ${id}`);
	return memory;
};

describe("where the memories are", () => {
	test("the shared bank is the database itself, a project's is a folder of banks; scratch banks are marked", () => {
		const fx = seeded();
		const files = bankFiles(fx.layout);
		expect(files.map((f) => [f.bank, f.scope, f.scratch])).toEqual([
			["default", "global", false],
			["app-abc123", "project", false],
			["empty-1", "project", false],
			["ompw-offline-x1", "project", true],
		]);
		expect(findBank(fx.layout, "app-abc123")?.path).toBe(fx.pathOf("app-abc123"));
		// A scratch bank is not a memory store: it cannot be named.
		expect(findBank(fx.layout, "ompw-offline-x1")).toBeNull();
	});

	test("a name that is not omp's, or a link, cannot lead out of the store", () => {
		const fx = seeded();
		mkdirSync(join(fx.root, "elsewhere"), { recursive: true });
		symlinkSync(join(fx.root, "elsewhere"), join(fx.layout.banksDir, "linked"));
		for (const bad of ["../x", "a/b", "", "x".repeat(65), "a b", 7, null, undefined, {}]) {
			expect(findBank(fx.layout, bad)).toBeNull();
		}
		expect(bankFiles(fx.layout).map((f) => f.bank)).not.toContain("linked");
	});

	test("omp's mnemopi.bank names the shared bank as omp sanitizes it; mnemopi.dbPath moves the whole store", () => {
		expect(layoutOf("/a", null, null)).toEqual({
			sharedDb: "/a/memories/mnemopi/mnemopi.db",
			banksDir: "/a/memories/mnemopi/banks",
			sharedBank: "default",
		});
		expect(layoutOf("/a", "/z/own/mem.db", "Work Notes!").sharedBank).toBe("Work-Notes");
		expect(layoutOf("/a", "/z/own/mem.db", null).banksDir).toBe("/z/own/banks");
		expect(layoutOf("/a", null, "x".repeat(80)).sharedBank.length).toBeLessThanOrEqual(64);
	});

	test("a bank tells its counts, retired ones, folders and whether this page may write to it", () => {
		const fx = seeded();
		const shared = bankInfo(bankFiles(fx.layout)[0], NOW);
		expect(shared).toMatchObject({
			bank: "default",
			scope: "global",
			label: "default",
			working: 2,
			episodic: 1,
			retired: 0,
			cwds: ["/work/app"],
			writeProblem: null,
		});
		const project = bankInfo(bankOf(fx.layout, "app-abc123"), NOW);
		// The folder's name labels a project's bank; the two retired ones (one past its `valid_until`, one superseded) are counted.
		expect(project).toMatchObject({ scope: "project", working: 3, episodic: 0, retired: 2 });
		expect(project.bytes).toBeGreaterThan(0);
	});

	test("a project's bank is labelled by the folder its memories were made in, else by its name without omp's hash", () => {
		const fx = memoryFixture();
		fx.bank("proj-1abc2def", {
			working: [{ id: "a", content: "x", metadata: { cwd: "/Users/jdoe/code/proj" } }],
		}).close();
		fx.bank("nocwd-1abc2def", { working: [{ id: "b", content: "x", metadata: null }] }).close();
		fx.bank("badjson-1abc2def", { working: [{ id: "c", content: "x", metadataText: "{not json" }] }).close();
		const label = (bank: string) => bankInfo(bankOf(fx.layout, bank), NOW).label;
		expect(label("proj-1abc2def")).toBe("proj");
		expect(label("nocwd-1abc2def")).toBe("nocwd");
		expect(label("badjson-1abc2def")).toBe("badjson");
	});

	test("a file that is not a database is reported by its bank and does not stop the others", () => {
		const fx = seeded();
		mkdirSync(join(fx.layout.banksDir, "broken-1"), { recursive: true });
		writeFileSync(join(fx.layout.banksDir, "broken-1", "mnemopi.db"), "this is not a database");
		const info = bankInfo(bankOf(fx.layout, "broken-1"), NOW);
		expect(info.error).toBeTruthy();
		expect(info.working).toBe(0);
		const list = listMemories(fx.layout, ALL(), NOW);
		expect(list.unreadable).toEqual(["broken-1"]);
		expect(list.items.length).toBeGreaterThan(0);
	});

	test("a copied store (a WAL database with no -shm file beside it) is read and changed, and reading leaves it byte for byte as it was", async () => {
		const source = memoryFixture();
		const db = source.bank("default", {
			working: [{ id: "c1", content: "Copied memory.", timestamp: "2026-10-12T09:00:00.000Z" }],
		});
		// Everything is in the main file after this: a copy of that file alone is the whole store.
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		db.close();
		const copy = memoryFixture();
		const path = copy.pathOf("default");
		mkdirSync(dirname(path), { recursive: true });
		copyFileSync(source.pathOf("default"), path);
		expect(existsSync(`${path}-shm`)).toBe(false);
		const digest = () => createHash("sha256").update(readFileSync(path)).digest("hex");
		const before = digest();

		const file = bankOf(copy.layout, "default");
		const list = listMemories(copy.layout, ALL(), NOW);
		expect(list.unreadable).toEqual([]);
		expect(list.items.map((i) => i.id)).toEqual(["c1"]);
		expect(bankInfo(file, NOW)).toMatchObject({ working: 1, writeProblem: null });
		const memory = readMemory(file, "c1", NOW);
		expect(memory?.content).toBe("Copied memory.");
		expect(digest()).toBe(before);

		const writer = new MemoryWriter(copy.dataDir);
		await writer.update(file, "c1", memory?.etag ?? "", { content: "Changed copy." });
		expect(readMemory(file, "c1", NOW)?.content).toBe("Changed copy.");
	});

	test("a hot WAL copied without its -shm (rows that were never checkpointed) is read with every row, and its copy before a change is made", async () => {
		const source = memoryFixture();
		const db = source.bank("default", {
			working: [{ id: "h1", content: "In the main file.", timestamp: "2026-10-12T09:00:00.000Z" }],
		});
		// A row that exists only in the -wal: omp (or this page) has the database open and has not checkpointed.
		db.exec("PRAGMA wal_autocheckpoint = 0");
		db.query(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, scope, author_id, author_type, channel_id, trust_tier) VALUES ('h2', 'Only in the WAL.', 'coding-agent-retain', '2026-10-13T09:00:00.000Z', 'default', 0.5, '{}', 'tool', 'fact', 'bank', 'a', 'agent', 'default', 'STATED')",
		).run();
		const copy = memoryFixture();
		const path = copy.pathOf("default");
		mkdirSync(dirname(path), { recursive: true });
		copyFileSync(source.pathOf("default"), path);
		copyFileSync(`${source.pathOf("default")}-wal`, `${path}-wal`);
		db.close();
		expect(existsSync(`${path}-shm`)).toBe(false);

		const file = bankOf(copy.layout, "default");
		const list = listMemories(copy.layout, ALL(), NOW);
		expect(list.unreadable).toEqual([]);
		expect(list.items.map((i) => i.id).sort()).toEqual(["h1", "h2"]);
		// The copy before a change is made on the connection that read it, so it needs no -shm left behind by another one.
		const writer = new MemoryWriter(copy.dataDir);
		const done = await writer.update(file, "h2", memoryOf(file, "h2", NOW).etag, { content: "Changed in the WAL." });
		expect(done.backedUp).toBe(true);
		const copies = readdirSync(writer.backupDir("default"));
		expect(copies).toHaveLength(1);
		expect(
			rowsOf(join(writer.backupDir("default"), copies[0] as string), "SELECT id FROM working_memory ORDER BY id"),
		).toEqual([{ id: "h1" }, { id: "h2" }]);
	});

	test("a copy is made before a delete whose memory the newest copy does not hold, before the edit of a memory no copy holds yet, and never before a change the lock turned away; one named for a time to come is no copy", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "default");
		let now = new Date("2026-10-23T12:00:00.000Z").getTime();
		const minutes = (n: number) => {
			now += n * 60_000;
		};
		const writer = new MemoryWriter(fx.dataDir, { clock: () => new Date(now) });
		const etag = (id: string) => memoryOf(file, id, NOW).etag;
		// The first change makes the first copy; the next, within the gap, of a memory that copy holds, makes none.
		expect((await writer.update(file, "g1", etag("g1"), { content: "One." })).backedUp).toBe(true);
		minutes(1);
		expect((await writer.update(file, "g1", etag("g1"), { content: "Two." })).backedUp).toBe(false);
		// A memory saved after the newest copy is in no copy: its edit is preceded by one, though the gap has not passed.
		const added = await writer.add(file, { content: "Saved since.", importance: 0.5, context: null, cwd: null });
		minutes(1);
		expect(
			(await writer.update(file, added.id, memoryOf(file, added.id, NOW).etag, { content: "Edited." })).backedUp,
		).toBe(true);
		// The two deletes are of memories the copy just made holds, in its second: one copy between them, which holds both.
		minutes(1);
		expect((await writer.remove(file, "g2", etag("g2"))).backedUp).toBe(true);
		expect((await writer.remove(file, "g1", etag("g1"))).backedUp).toBe(false);
		const dir = writer.backupDir("default");
		const newest = readdirSync(dir).sort().at(-1) as string;
		const ids = rowsOf(join(dir, newest), "SELECT id FROM working_memory").map((r) => r.id);
		// One copy between the deletes, and it holds both of them (and what was saved earlier).
		expect(ids).toContain("g1");
		expect(ids).toContain("g2");

		// A memory saved after the newest copy is in no copy: a delete of it is preceded by one, though the gap has not passed.
		minutes(1);
		const later = await writer.add(file, { content: "Saved after.", importance: 0.5, context: null, cwd: null });
		expect((await writer.remove(file, later.id, memoryOf(file, later.id, NOW).etag)).backedUp).toBe(true);

		// A copy named for a time that has not come (the clock was set back) does not stop the copies until then.
		const other = bankOf(fx.layout, "app-abc123");
		const otherDir = writer.backupDir("app-abc123");
		mkdirSync(otherDir, { recursive: true });
		writeFileSync(join(otherDir, "20991231T235959Z.db"), "");
		const p1 = memoryOf(other, "p1", NOW);
		expect((await writer.update(other, "p1", p1.etag, { content: "Changed." })).backedUp).toBe(true);
		expect(readdirSync(otherDir).length).toBe(2);
	});

	test("a change the write lock turned away takes no copy and prunes none", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "default");
		// omp holds the lock for longer than a change waits.
		const omp = new Database(file.path);
		omp.exec("BEGIN IMMEDIATE");
		omp.exec("UPDATE working_memory SET importance = 0.1 WHERE id = 'g1'");
		const writer = new MemoryWriter(fx.dataDir, { busyMs: 100 });
		try {
			const busy = await rejects(writer.remove(file, "g1", memoryOf(file, "g1", NOW).etag));
			expect(busy).toMatchObject({ code: "busy", status: 503 });
			// Repeating a Delete click on a locked store fills no folder of copies.
			expect(await rejects(writer.remove(file, "g1", memoryOf(file, "g1", NOW).etag))).toMatchObject({ code: "busy" });
		} finally {
			omp.exec("COMMIT");
			omp.close();
		}
		const dir = writer.backupDir("default");
		expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
		// Once omp lets go, the delete goes through and is preceded by its copy.
		expect((await writer.remove(file, "g1", memoryOf(file, "g1", NOW).etag)).backedUp).toBe(true);
		expect(readdirSync(dir)).toHaveLength(1);
	});
});

describe("listing", () => {
	test("newest first across banks; each item says its scope, kind and where it came from", () => {
		const fx = seeded();
		const list = listMemories(fx.layout, ALL(), NOW);
		expect(list.items.map((i) => i.id)).toEqual(["p1", "gE1", "g1", "g2"]);
		const g1 = list.items.find((i) => i.id === "g1");
		expect(g1).toMatchObject({
			bank: "default",
			scope: "global",
			store: "working",
			kind: "note",
			retired: false,
			importance: 0.75,
			provenance: {
				origin: "learn",
				tool: "learn",
				sessionId: "sess-g1",
				cwd: "/work/app",
				context: "Said so in the review",
				source: "coding-agent-learn",
			},
		});
		expect(list.items.find((i) => i.id === "g2")?.kind).toBe("conversation");
		expect(list.items.find((i) => i.id === "gE1")).toMatchObject({ kind: "consolidated", store: "episodic" });
		expect(list.items.find((i) => i.id === "p1")?.scope).toBe("project");
		// Scratch banks and the retired are not in it.
		expect(list.items.map((i) => i.id)).not.toContain("s1");
		expect(list.total).toBe(4);
		expect(list.counts).toEqual({ note: 2, conversation: 1, consolidated: 1 });
	});

	test("kinds, scope and bank narrow the list, and the counts say what the other kinds would show", () => {
		const fx = seeded();
		const notes = listMemories(fx.layout, ALL({ kinds: ["note"] }), NOW);
		expect(notes.items.map((i) => i.id)).toEqual(["p1", "g1"]);
		expect(notes.total).toBe(2);
		expect(notes.counts).toEqual({ note: 2, conversation: 1, consolidated: 1 });
		expect(listMemories(fx.layout, ALL({ kinds: ["conversation"] }), NOW).items.map((i) => i.id)).toEqual(["g2"]);
		expect(listMemories(fx.layout, ALL({ kinds: ["consolidated"] }), NOW).items.map((i) => i.id)).toEqual(["gE1"]);
		expect(listMemories(fx.layout, ALL({ kinds: [] }), NOW)).toMatchObject({ items: [], total: 0 });
		expect(listMemories(fx.layout, ALL({ scope: "global" }), NOW).items.map((i) => i.id)).toEqual(["gE1", "g1", "g2"]);
		expect(listMemories(fx.layout, ALL({ scope: "project" }), NOW).items.map((i) => i.id)).toEqual(["p1"]);
		expect(listMemories(fx.layout, ALL({ bank: "app-abc123" }), NOW).items.map((i) => i.id)).toEqual(["p1"]);
		expect(listMemories(fx.layout, ALL({ bank: "nope" }), NOW).items).toEqual([]);
	});

	test("retired memories (past their valid_until, or superseded) are listed only when asked for", () => {
		const fx = seeded();
		expect(listMemories(fx.layout, ALL({ retired: "retired" }), NOW).items.map((i) => i.id)).toEqual(["p2", "p3"]);
		const all = listMemories(fx.layout, ALL({ retired: "all" }), NOW);
		expect(all.items.map((i) => i.id)).toEqual(["p1", "gE1", "g1", "g2", "p2", "p3"]);
		expect(all.items.filter((i) => i.retired).map((i) => i.id)).toEqual(["p2", "p3"]);
		// A `valid_until` that has not come is not retired.
		expect(
			listMemories(fx.layout, ALL({ retired: "retired" }), "2026-10-01T00:00:00.000Z").items.map((i) => i.id),
		).toEqual(["p3"]);
	});

	test("search finds text, the folder, the reason the agent gave and the id; case does not matter", () => {
		const fx = seeded();
		const ids = (q: string) => listMemories(fx.layout, ALL({ q }), NOW).items.map((i) => i.id);
		expect(ids("TABS")).toEqual(["gE1", "g1"]);
		expect(ids("bun 1.4")).toEqual(["p1"]);
		expect(ids("said so in the review")).toEqual(["g1"]);
		expect(ids("/work/app")).toEqual(["p1", "g1", "g2"]);
		expect(ids("g2")).toEqual(["g2"]);
		expect(ids("no such thing")).toEqual([]);
		// The text is not a pattern: nothing in it is interpreted.
		expect(ids("%")).toEqual([]);
		expect(ids("' OR 1=1 --")).toEqual([]);
		// Counts follow the search.
		expect(listMemories(fx.layout, ALL({ q: "tabs" }), NOW).counts).toEqual({
			note: 1,
			conversation: 0,
			consolidated: 1,
		});
	});

	test("a page is a slice of the newest-first list; the total is of all pages", () => {
		const fx = memoryFixture();
		const rows = Array.from({ length: 12 }, (_, i) => ({
			id: `m${String(i).padStart(2, "0")}`,
			content: `memory ${i}`,
			timestamp: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`,
		}));
		fx.bank("default", { working: rows }).close();
		const page = (offset: number, limit: number) => listMemories(fx.layout, ALL({ offset, limit }), NOW);
		expect(page(0, 5).items.map((i) => i.id)).toEqual(["m11", "m10", "m09", "m08", "m07"]);
		expect(page(5, 5).items.map((i) => i.id)).toEqual(["m06", "m05", "m04", "m03", "m02"]);
		expect(page(10, 5).items.map((i) => i.id)).toEqual(["m01", "m00"]);
		expect(page(0, 5).total).toBe(12);
		expect(page(20, 5).items).toEqual([]);
	});

	test("a long memory is cut to a preview, and says how long it is", () => {
		const fx = memoryFixture();
		const long = "é".repeat(MEMORY_PREVIEW_CHARS + 500);
		fx.bank("default", {
			working: [
				{ id: "long", content: long },
				{ id: "short", content: "short", timestamp: "2026-10-09T00:00:00.000Z" },
			],
		}).close();
		const [a, b] = listMemories(fx.layout, ALL(), NOW).items;
		expect(a.content).toHaveLength(MEMORY_PREVIEW_CHARS);
		expect(a).toMatchObject({ length: long.length, truncated: true });
		expect(b).toMatchObject({ content: "short", length: 5, truncated: false });
		// Opened, the whole of it.
		const detail = memoryOf(bankOf(fx.layout, "default"), "long", NOW);
		expect(detail.content).toBe(long);
		expect(detail.truncated).toBe(false);
	});

	test("an empty store, or none at all, lists nothing", () => {
		const fx = memoryFixture();
		expect(listMemories(fx.layout, ALL(), NOW)).toEqual({
			items: [],
			total: 0,
			counts: { note: 0, conversation: 0, consolidated: 0 },
			unreadable: [],
		});
		fx.bank("default").close();
		expect(listMemories(fx.layout, ALL(), NOW).items).toEqual([]);
	});

	test("a database with fewer columns than omp 18.12 makes is read as far as it goes, and not written", () => {
		const fx = memoryFixture();
		mkdirSync(join(fx.layout.sharedDb, ".."), { recursive: true });
		const db = new Database(fx.layout.sharedDb, { create: true });
		db.exec("CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, timestamp TEXT)");
		db.exec("INSERT INTO working_memory VALUES ('old1', 'an older layout', '2026-10-01T00:00:00.000Z')");
		expect(layoutProblem(db)).toContain("lacks");
		db.close();
		const list = listMemories(fx.layout, ALL(), NOW);
		expect(list.items.map((i) => i.id)).toEqual(["old1"]);
		expect(list.items[0]).toMatchObject({ kind: "note", retired: false, importance: null });
		expect(bankInfo(bankFiles(fx.layout)[0], NOW).writeProblem).toContain("lacks");
		expect(readMemory(bankFiles(fx.layout)[0], "old1", NOW)).toMatchObject({ editable: false, retirable: false });
	});
});

describe("opening one memory", () => {
	test("everything omp keeps of a working memory, and the consolidated memories made of it", () => {
		const fx = seeded();
		const d = memoryOf(bankOf(fx.layout, "default"), "g1", NOW);
		expect(d).toMatchObject({
			id: "g1",
			store: "working",
			content: "Prefers tabs over spaces in every project.",
			veracity: "tool",
			memoryType: "fact",
			trustTier: "STATED",
			author: "coding-agent",
			consolidatedAt: "2026-10-13T00:00:00.000Z",
			consolidatedInto: ["gE1"],
			summaryOf: [],
			editable: true,
			retirable: true,
		});
		expect(d.etag).toMatch(/^[0-9a-f]{16}$/);
	});

	test("a consolidated memory names its sources, and takes its provenance from them while they exist", () => {
		const fx = seeded();
		const d = memoryOf(bankOf(fx.layout, "default"), "gE1", NOW);
		expect(d).toMatchObject({
			store: "episodic",
			kind: "consolidated",
			summaryOf: [{ id: "g1", exists: true }],
			editable: false,
			retirable: true,
			provenance: { origin: "consolidated", sessionId: "sess-g1", cwd: "/work/app", tool: "learn" },
		});
		// Its source gone (omp's own deletion, or this page's), it still opens, and says so.
		const db = new Database(fx.pathOf("default"));
		db.exec("DELETE FROM working_memory WHERE id = 'g1'");
		db.close();
		const again = memoryOf(bankOf(fx.layout, "default"), "gE1", NOW);
		expect(again.summaryOf).toEqual([{ id: "g1", exists: false }]);
		expect(again.provenance.sessionId).toBeNull();
	});

	test("an unknown id is null, and the etag follows what a change would overwrite", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "default");
		expect(readMemory(file, "nope", NOW)).toBeNull();
		const before = memoryOf(file, "g1", NOW);
		expect(memoryOf(file, "g1", NOW).etag).toBe(before.etag);
		const writer = new MemoryWriter(fx.dataDir);
		await writer.update(file, "g1", before.etag, { content: "Prefers tabs." });
		expect(memoryOf(file, "g1", NOW).etag).not.toBe(before.etag);
	});
});

describe("changing a memory", () => {
	test("a rewrite changes the text and importance, keeps the search index in step, and drops the stale embedding", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "app-abc123");
		const writer = new MemoryWriter(fx.dataDir);
		const before = memoryOf(file, "p1", NOW);
		expect(count(file.path, "memory_embeddings", "memory_id = 'p1'")).toBe(1);
		const done = await writer.update(file, "p1", before.etag, {
			content: "The build needs zebrafish 9.",
			importance: 0.9,
		});
		expect(done.backedUp).toBe(true);
		const after = memoryOf(file, "p1", NOW);
		expect(after).toMatchObject({ content: "The build needs zebrafish 9.", importance: 0.9 });
		// omp finds it by its new words (its own triggers keep the index) and no longer by its old ones.
		expect(
			rowsOf(file.path, "SELECT id FROM fts_working WHERE fts_working MATCH 'zebrafish'").map((r) => r.id),
		).toEqual(["p1"]);
		expect(rowsOf(file.path, "SELECT id FROM fts_working WHERE fts_working MATCH 'bun'")).toEqual([]);
		// The old text's embedding is gone, so that omp makes one again at its next start; the other memories keep theirs.
		expect(count(file.path, "memory_embeddings", "memory_id = 'p1'")).toBe(0);
		expect(rowsOf(file.path, "SELECT embed_text FROM working_memory WHERE id = 'p1'")[0].embed_text).toBeNull();
		// What the rewrite does not own is left as it was.
		expect(
			rowsOf(file.path, "SELECT source, timestamp, session_id, consolidated_at FROM working_memory WHERE id = 'p1'")[0],
		).toEqual({
			source: "coding-agent-retain",
			timestamp: "2026-10-14T09:00:00.000Z",
			session_id: "app-abc123",
			consolidated_at: null,
		});
		expect(count(file.path, "working_memory")).toBe(3);
	});

	test("an importance alone leaves the embedding, which is of the text", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "app-abc123");
		const writer = new MemoryWriter(fx.dataDir);
		await writer.update(file, "p1", memoryOf(file, "p1", NOW).etag, { importance: 0.2 });
		expect(readMemory(file, "p1", NOW)).toMatchObject({ importance: 0.2, content: "The build needs bun 1.4." });
		expect(count(file.path, "memory_embeddings", "memory_id = 'p1'")).toBe(1);
	});

	test("a change made on a memory that changed since it was read is refused, and changes nothing", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "default");
		const writer = new MemoryWriter(fx.dataDir);
		const seen = memoryOf(file, "g1", NOW);
		// omp (or another change) rewrote it meanwhile.
		const db = new Database(file.path);
		db.exec("UPDATE working_memory SET content = 'omp changed it' WHERE id = 'g1'");
		db.close();
		for (const attempt of [
			writer.update(file, "g1", seen.etag, { content: "mine" }),
			writer.retire(file, "g1", seen.etag),
			writer.restore(file, "g1", seen.etag),
			writer.remove(file, "g1", seen.etag),
		]) {
			expect((await rejects(attempt)).code).toBe("stale");
		}
		expect(readMemory(file, "g1", NOW)).toMatchObject({ content: "omp changed it", retired: false });
	});

	test("a consolidated memory is retired, not rewritten or deleted (as in omp); nothing else is refused", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "default");
		const writer = new MemoryWriter(fx.dataDir);
		const e = memoryOf(file, "gE1", NOW);
		expect((await rejects(writer.update(file, "gE1", e.etag, { content: "x" }))).code).toBe("notEditable");
		expect((await rejects(writer.remove(file, "gE1", e.etag))).code).toBe("notEditable");
		expect(count(file.path, "episodic_memory")).toBe(1);
		await writer.retire(file, "gE1", e.etag);
		expect(readMemory(file, "gE1", new Date().toISOString())).toMatchObject({ retired: true });
		expect(listMemories(fx.layout, ALL(), new Date().toISOString()).items.map((i) => i.id)).not.toContain("gE1");
	});

	test("retire stops omp recalling it (valid_until is set); restore brings it back; both leave the text alone", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "app-abc123");
		const writer = new MemoryWriter(fx.dataDir, { clock: () => new Date("2026-10-23T12:00:00.000Z") });
		await writer.retire(file, "p1", null);
		const row = rowsOf(file.path, "SELECT content, valid_until, superseded_by FROM working_memory WHERE id = 'p1'")[0];
		expect(row).toEqual({
			content: "The build needs bun 1.4.",
			valid_until: "2026-10-23T12:00:00.000Z",
			superseded_by: null,
		});
		expect(
			listMemories(fx.layout, ALL({ retired: "retired" }), "2026-10-24T00:00:00.000Z").items.map((i) => i.id),
		).toContain("p1");
		await writer.restore(file, "p1", null);
		expect(rowsOf(file.path, "SELECT valid_until, superseded_by FROM working_memory WHERE id = 'p1'")[0]).toEqual({
			valid_until: null,
			superseded_by: null,
		});
		// A superseded one comes back too.
		await writer.restore(file, "p3", null);
		expect(rowsOf(file.path, "SELECT superseded_by FROM working_memory WHERE id = 'p3'")[0].superseded_by).toBeNull();
	});

	test("a deletion takes away the memory and what omp made from it, and nothing of any other memory", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "default");
		const db = new Database(file.path);
		insertDerived(db, "g1");
		insertDerived(db, "g2");
		db.close();
		const writer = new MemoryWriter(fx.dataDir);
		await writer.remove(file, "g1", memoryOf(file, "g1", NOW).etag);
		const of = (table: string, col: string, id: string) => count(file.path, table, `${col} = '${id}'`);
		expect(of("working_memory", "id", "g1")).toBe(0);
		for (const [table, col, id] of [
			["facts", "source_msg_id", "g1"],
			["annotations", "memory_id", "g1"],
			["memory_embeddings", "memory_id", "g1"],
			["memoria_facts", "source_memory_id", "g1"],
			["memoria_kg", "source_memory_id", "g1"],
			["gists", "memory_id", "g1"],
		] as const) {
			expect(of(table, col, id), `${table} of g1`).toBe(0);
			if (table !== "memory_embeddings") expect(of(table, col, "g2"), `${table} of g2`).toBe(1);
		}
		// Graph edges to the memory, to its gist and to its facts go; those of the other memory stay.
		expect(count(file.path, "graph_edges", "source = 'g1' OR target = 'fact-g1'")).toBe(0);
		expect(count(file.path, "graph_edges", "source = 'g2' OR target = 'fact-g2'")).toBe(2);
		// The consolidated copy is not touched (it is retired on its own).
		expect(count(file.path, "episodic_memory")).toBe(1);
		// The indexes are in step.
		expect(count(file.path, "fts_working")).toBe(count(file.path, "working_memory"));
		expect(rowsOf(file.path, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
		expect(rowsOf(file.path, "SELECT id FROM fts_working WHERE fts_working MATCH 'tabs'")).toEqual([]);
	});

	test("a deletion retires what was made from it that is still recalled, and leaves a summary omp already retired or replaced as it is", async () => {
		const fx = memoryFixture();
		const file = fx.bank("default", {
			working: [{ id: "w1", content: "The deploy needs a token.", timestamp: "2026-10-12T09:00:00.000Z" }],
			episodic: [
				// Still recalled: its valid_until is in the future (omp's `invalidate` would move it back to now).
				{ id: "e-future", content: "future", summaryOf: "w1", validUntil: "2027-01-01T00:00:00.000Z" },
				// Already retired, and already replaced by another memory: neither is touched.
				{ id: "e-retired", content: "retired", summaryOf: "w1", validUntil: "2026-10-01T00:00:00.000Z" },
				{ id: "e-superseded", content: "superseded", summaryOf: "w1", supersededBy: "e-future" },
				{ id: "e-other", content: "other", summaryOf: "w2" },
			],
		});
		file.close();
		const bank = bankOf(fx.layout, "default");
		const now = "2026-10-23T12:00:00.000Z";
		const writer = new MemoryWriter(fx.dataDir, { clock: () => new Date(now) });
		await writer.remove(bank, "w1", memoryOf(bank, "w1", now).etag, { retireConsolidated: true });
		const rows = rowsOf(bank.path, "SELECT id, valid_until, superseded_by FROM episodic_memory ORDER BY id");
		expect(rows).toEqual([
			// The one still recalled is retired at the time of the change.
			{ id: "e-future", valid_until: now, superseded_by: null },
			// A summary of another memory is not this one's to retire.
			{ id: "e-other", valid_until: null, superseded_by: null },
			// One omp had already retired: its own time stays (a later one would make it recalled for a while).
			{ id: "e-retired", valid_until: "2026-10-01T00:00:00.000Z", superseded_by: null },
			// One omp had replaced: the replacement is not taken away, and neither is the summary.
			{ id: "e-superseded", valid_until: null, superseded_by: "e-future" },
		]);
		expect(count(bank.path, "working_memory", "id = 'w1'")).toBe(0);
	});

	test("an addition is a working memory as omp's own save writes it: recalled by its bank, found by search, never trimmed", async () => {
		const fx = seeded();
		const writer = new MemoryWriter(fx.dataDir, { clock: () => new Date("2026-10-23T12:00:00.000Z") });
		const shared = bankOf(fx.layout, "default");
		const { id } = await writer.add(shared, {
			content: "Always answer in Chinese.",
			importance: 0.9,
			context: "asked on the Memory page",
			cwd: null,
		});
		expect(id).toMatch(/^[0-9a-f]{16}$/);
		const row = rowsOf(shared.path, "SELECT * FROM working_memory WHERE id = ?", id)[0];
		expect(row).toMatchObject({
			content: "Always answer in Chinese.",
			source: "omp-webui",
			timestamp: "2026-10-23T12:00:00.000Z",
			// What omp recalls a bank's memories by: the bank is the session (omp opens each bank with its name as its session id).
			session_id: "default",
			channel_id: "default",
			scope: "bank",
			importance: 0.9,
			veracity: "stated",
			memory_type: "fact",
			trust_tier: "STATED",
			author_type: "user",
			// Marked consolidated, as omp marks what it imports: omp's trim of old unconsolidated working memories skips it.
			consolidated_at: "2026-10-23T12:00:00.000Z",
			valid_until: null,
			superseded_by: null,
		});
		expect(JSON.parse(String(row.metadata_json))).toEqual({
			cwd: null,
			context: "asked on the Memory page",
			operation: "web-ui",
		});
		expect(
			rowsOf(shared.path, "SELECT id FROM fts_working WHERE fts_working MATCH 'chinese'").map((r) => r.id),
		).toEqual([id]);
		const added = memoryOf(shared, id, NOW);
		expect(added).toMatchObject({
			kind: "note",
			scope: "global",
			provenance: { origin: "web", context: "asked on the Memory page" },
		});
		// A project's memory carries the folder its bank is of.
		const project = bankOf(fx.layout, "app-abc123");
		const mine = await writer.add(project, { content: "Use pnpm.", importance: 0.5, context: null, cwd: "/work/app" });
		expect(readMemory(project, mine.id, NOW)).toMatchObject({ scope: "project", provenance: { cwd: "/work/app" } });
		expect(rowsOf(project.path, "SELECT session_id FROM working_memory WHERE id = ?", mine.id)[0].session_id).toBe(
			"app-abc123",
		);
	});

	test("a memory is not longer than omp's stores (64,000 characters), and nothing is written for one that is", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "default");
		const writer = new MemoryWriter(fx.dataDir);
		const long = "x".repeat(MEMORY_CONTENT_MAX + 1);
		expect((await rejects(writer.add(file, { content: long, importance: 0.5, context: null, cwd: null }))).code).toBe(
			"tooLong",
		);
		expect((await rejects(writer.update(file, "g1", memoryOf(file, "g1", NOW).etag, { content: long }))).code).toBe(
			"tooLong",
		);
		expect(count(file.path, "working_memory")).toBe(2);
		expect(existsSync(fx.dataDir) && readdirSync(fx.dataDir)).toEqual([]);
		// The longest that is allowed is written whole.
		const edge = await writer.add(file, {
			content: "y".repeat(MEMORY_CONTENT_MAX),
			importance: 0.5,
			context: null,
			cwd: null,
		});
		expect(memoryOf(file, edge.id, NOW).content).toHaveLength(MEMORY_CONTENT_MAX);
	});

	test("nothing is created: a database that is not there is not made, and a memory not there is not found", async () => {
		const fx = memoryFixture();
		const ghost = { bank: "default", scope: "global" as const, path: fx.layout.sharedDb, scratch: false };
		const writer = new MemoryWriter(fx.dataDir);
		expect((await rejects(writer.add(ghost, { content: "x", importance: 0.5, context: null, cwd: null }))).code).toBe(
			"unreadable",
		);
		expect(existsSync(fx.layout.sharedDb)).toBe(false);
		const seed = seeded();
		const file = bankOf(seed.layout, "default");
		const w = new MemoryWriter(seed.dataDir);
		expect((await rejects(w.update(file, "ghost", "0123456789abcdef", { content: "x" }))).code).toBe("notFound");
		expect((await rejects(w.retire(file, "ghost", null))).code).toBe("notFound");
		expect((await rejects(w.remove(file, "ghost", "0123456789abcdef"))).code).toBe("notFound");
	});

	test("a layout this page does not know is refused before anything is copied or written", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "default");
		// omp's trigger that keeps the full-text index of a changed text in step is gone: a rewrite would leave the index stale.
		const db = new Database(file.path);
		db.exec("DROP TRIGGER wm_au");
		db.close();
		const writer = new MemoryWriter(fx.dataDir);
		const e = await rejects(writer.update(file, "g1", memoryOf(file, "g1", NOW).etag, { content: "x" }));
		expect(e.code).toBe("layout");
		expect(e.message).toContain("wm_au");
		expect(readMemory(file, "g1", NOW)).toMatchObject({
			content: "Prefers tabs over spaces in every project.",
			editable: false,
		});
		expect(existsSync(join(fx.dataDir, "memory-backups"))).toBe(false);
		expect(bankInfo(file, NOW).writeProblem).toContain("wm_au");
	});
});

describe("the copy made before a change", () => {
	const clockAt = (start: string) => {
		let now = new Date(start).getTime();
		return {
			clock: () => new Date(now),
			advance: (ms: number) => {
				now += ms;
			},
		};
	};

	test("is made by SQLite from the database as it was, is private, and holds the state before the change", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "default");
		const { clock } = clockAt("2026-10-23T12:00:00.000Z");
		const writer = new MemoryWriter(fx.dataDir, { clock });
		const result = await writer.update(file, "g1", memoryOf(file, "g1", NOW).etag, { content: "changed" });
		expect(result.backedUp).toBe(true);
		const dir = writer.backupDir("default");
		expect(readdirSync(dir)).toEqual(["20261023T120000Z.db"]);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "20261023T120000Z.db")).mode & 0o777).toBe(0o600);
		// The copy is a database of its own, with the old text, and it was taken before the change.
		expect(
			rowsOf(join(dir, "20261023T120000Z.db"), "SELECT content FROM working_memory WHERE id = 'g1'")[0].content,
		).toBe("Prefers tabs over spaces in every project.");
		expect(rowsOf(join(dir, "20261023T120000Z.db"), "SELECT COUNT(*) AS n FROM fts_working")[0].n).toBe(2);
		expect(memoryOf(file, "g1", NOW).content).toBe("changed");
	});

	test("is made at most once in the gap per bank, again after it, and only the newest are kept", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "app-abc123");
		const other = bankOf(fx.layout, "default");
		const time = clockAt("2026-10-23T12:00:00.000Z");
		const writer = new MemoryWriter(fx.dataDir, { clock: time.clock, backupGapMs: 600_000, keepBackups: 3 });
		const change = async (n: number) =>
			(await writer.add(file, { content: `note ${n}`, importance: 0.5, context: null, cwd: null })).backedUp;
		expect(await change(1)).toBe(true);
		time.advance(60_000);
		expect(await change(2)).toBe(false);
		// Another bank has its own copies.
		expect((await writer.add(other, { content: "other", importance: 0.5, context: null, cwd: null })).backedUp).toBe(
			true,
		);
		for (let i = 3; i <= 7; i++) {
			time.advance(601_000);
			expect(await change(i)).toBe(true);
		}
		const kept = readdirSync(writer.backupDir("app-abc123")).sort();
		// Six copies were made (the first, and one after each gap that passed); the newest three are kept.
		expect(kept).toEqual(["20261023T123103Z.db", "20261023T124104Z.db", "20261023T125105Z.db"]);
		expect(readdirSync(writer.backupDir("default"))).toEqual(["20261023T120100Z.db"]);
		// The newest was made just before the last change: it holds everything but that.
		expect(count(join(writer.backupDir("app-abc123"), kept[2]), "working_memory")).toBe(
			count(file.path, "working_memory") - 1,
		);
	});

	test("two copies in the same second do not overwrite each other, and only files made as this makes them are pruned", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "app-abc123");
		const writer = new MemoryWriter(fx.dataDir, {
			clock: () => new Date("2026-10-23T12:00:00.000Z"),
			backupGapMs: 0,
			keepBackups: 2,
		});
		const dir = writer.backupDir("app-abc123");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "notes.txt"), "mine");
		writeFileSync(join(dir, "20200101T000000Z.db.keep"), "mine");
		for (let i = 0; i < 4; i++) await writer.add(file, { content: `n${i}`, importance: 0.5, context: null, cwd: null });
		expect(readdirSync(dir).sort()).toEqual([
			"20200101T000000Z.db.keep",
			"20261023T120000Z-2.db",
			"20261023T120000Z-3.db",
			"notes.txt",
		]);
	});

	test("that cannot be made stops the change: nothing is written", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "default");
		// The data directory is a file: no folder of copies can be made in it.
		const notAFolder = join(fx.root, "not-a-folder");
		writeFileSync(notAFolder, "x");
		const writer = new MemoryWriter(notAFolder);
		const e = await rejects(writer.update(file, "g1", memoryOf(file, "g1", NOW).etag, { content: "x" }));
		expect(e.code).toBe("backup");
		expect(memoryOf(file, "g1", NOW).content).toBe("Prefers tabs over spaces in every project.");
		expect((await rejects(writer.add(file, { content: "x", importance: 0.5, context: null, cwd: null }))).code).toBe(
			"backup",
		);
		expect(count(file.path, "working_memory")).toBe(2);
	});
});

describe("omp writing to the same database", () => {
	test("a change waits for omp's write lock for as long as it is told to, then says so, and has changed nothing", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "default");
		const omp = new Database(file.path);
		omp.exec("BEGIN IMMEDIATE");
		omp.exec("UPDATE working_memory SET importance = 0.1 WHERE id = 'g2'");
		const writer = new MemoryWriter(fx.dataDir, { busyMs: 100 });
		const started = Date.now();
		const e = await rejects(writer.update(file, "g1", memoryOf(file, "g1", NOW).etag, { content: "mine" }));
		expect(e).toMatchObject({ code: "busy", status: 503 });
		expect(Date.now() - started).toBeGreaterThanOrEqual(90);
		omp.exec("COMMIT");
		omp.close();
		expect(memoryOf(file, "g1", NOW).content).toBe("Prefers tabs over spaces in every project.");
		// Once omp lets go, the same change goes through, and omp's own is there too.
		await writer.update(file, "g1", memoryOf(file, "g1", NOW).etag, { content: "mine" });
		expect(memoryOf(file, "g1", NOW).content).toBe("mine");
		expect(memoryOf(file, "g2", NOW).importance).toBe(0.1);
	});

	test("a change that is waiting goes through as soon as omp commits, and sees what omp wrote", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "default");
		const etag = memoryOf(file, "g1", NOW).etag;
		// omp (a process of its own) holds the lock for a moment, then rewrites the very memory the change is about. The hold
		// is a real one, of a real process, for the real SQLite to wait on: no fake clock can stand in for the lock.
		const holder = Bun.spawn(
			[
				"bun",
				"-e",
				`const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(file.path)}); db.exec("PRAGMA busy_timeout = 5000"); db.exec("BEGIN IMMEDIATE"); console.log("locked"); Bun.sleepSync(300); db.exec("UPDATE working_memory SET content = 'omp was here' WHERE id = 'g1'"); db.exec("COMMIT"); db.close();`,
			],
			{ stdout: "pipe", stderr: "inherit" },
		);
		const reader = holder.stdout.getReader();
		await reader.read(); // "locked"
		const writer = new MemoryWriter(fx.dataDir, { busyMs: 5000 });
		// The change was made on the text omp is about to rewrite: waiting for the lock, it finds the memory is another now.
		const e = await rejects(writer.update(file, "g1", etag, { content: "mine" }));
		expect(e.code).toBe("stale");
		await holder.exited;
		expect(memoryOf(file, "g1", NOW).content).toBe("omp was here");
	});

	test("while a process of its own keeps inserting (omp retaining turns), every one of our changes lands, none of omp's is lost, and the database is whole", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "app-abc123");
		const script = join(import.meta.dir, "..", "support", "omp-writer.ts");
		const omp = Bun.spawn(["bun", script, file.path, "app-abc123", "250", "2"], { stdout: "pipe", stderr: "inherit" });
		const lines = omp.stdout.getReader();
		const decoder = new TextDecoder();
		expect(decoder.decode((await lines.read()).value)).toContain("started");
		// Every copy the run makes is kept: how many it makes is how many changes fit in omp's run, which a slow machine
		// makes several hundred (the pruning of the oldest ones has a test of its own).
		const writer = new MemoryWriter(fx.dataDir, {
			backupGapMs: 600_000,
			busyMs: 8000,
			keepBackups: Number.POSITIVE_INFINITY,
		});
		const mine: string[] = [];
		// Until omp is done, and at least a dozen changes: the loop gives the process's pipes a turn between changes (every
		// change settles in microtasks, and a loop of those alone would never let the exit of omp's process be heard).
		let ompDone = false;
		void omp.exited.then(() => {
			ompDone = true;
		});
		for (let i = 0; !ompDone || i < 12; i++) {
			const added = await writer.add(file, {
				content: `mine ${i} flamingo`,
				importance: 0.5,
				context: null,
				cwd: "/work/app",
			});
			mine.push(added.id);
			const open = memoryOf(file, added.id, NOW);
			if (i % 3 === 0) await writer.update(file, added.id, open.etag, { content: `mine ${i} edited flamingo` });
			if (i % 4 === 1) await writer.remove(file, added.id, memoryOf(file, added.id, NOW).etag);
			if (i % 4 === 2) await writer.retire(file, added.id, null);
			await yieldToIo();
		}
		await omp.exited;
		let rest = "";
		for (let chunk = await lines.read(); !chunk.done; chunk = await lines.read()) rest += decoder.decode(chunk.value);
		expect(rest).toContain("done 250");
		// Every memory omp wrote is there; ours are there but for the ones we deleted.
		expect(count(file.path, "working_memory", "id LIKE 'omp%'")).toBe(250);
		const deleted = mine.filter((_, i) => i % 4 === 1);
		expect(count(file.path, "working_memory", `id IN (${mine.map((m) => `'${m}'`).join(",")})`)).toBe(
			mine.length - deleted.length,
		);
		for (const id of deleted) expect(readMemory(file, id, NOW)).toBeNull();
		for (const [i, id] of mine.entries()) {
			if (i % 4 === 1) continue;
			const open = memoryOf(file, id, new Date().toISOString());
			expect(open.content).toBe(i % 3 === 0 ? `mine ${i} edited flamingo` : `mine ${i} flamingo`);
			expect(open.retired).toBe(i % 4 === 2);
		}
		// The database is whole, and the search index has exactly the memories there are.
		expect(rowsOf(file.path, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
		expect(count(file.path, "fts_working")).toBe(count(file.path, "working_memory"));
		expect(rowsOf(file.path, "SELECT COUNT(*) AS n FROM fts_working WHERE fts_working MATCH 'flamingo'")[0].n).toBe(
			mine.length - deleted.length,
		);
		// A copy before each delete; each copy is a whole database. Each is opened once: there may be hundreds of them.
		const copies = readdirSync(writer.backupDir("app-abc123")).sort();
		expect(copies.length).toBeGreaterThan(1);
		const copied = new Set<unknown>();
		for (const name of copies) {
			const copy = join(writer.backupDir("app-abc123"), name);
			expect(rowsOf(copy, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
			for (const row of rowsOf(copy, "SELECT id FROM working_memory")) copied.add(row.id);
		}
		// The first memory the run deleted is in a copy, and so is every later one: a copy is taken before each delete.
		for (const id of deleted) expect(copied.has(id), id).toBe(true);
	}, 60_000);

	test("two changes of ours on one memory at once: one lands, the other is told it changed", async () => {
		const fx = seeded();
		const file = bankOf(fx.layout, "default");
		const writer = new MemoryWriter(fx.dataDir);
		const etag = memoryOf(file, "g1", NOW).etag;
		const results = await Promise.allSettled([
			writer.update(file, "g1", etag, { content: "first" }),
			writer.update(file, "g1", etag, { content: "second" }),
		]);
		expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
		const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
		expect((lost.reason as MemoryError).code).toBe("stale");
		expect(memoryOf(file, "g1", NOW).content).toBe("first");
	});

	test("reading never needs write access: a database file this process may not write is still listed and opened", () => {
		const fx = seeded();
		chmodSync(fx.pathOf("default"), 0o444);
		try {
			expect(listMemories(fx.layout, ALL(), NOW).items).toHaveLength(4);
			expect(readMemory(bankOf(fx.layout, "default"), "g1", NOW)).not.toBeNull();
		} finally {
			chmodSync(fx.pathOf("default"), 0o644);
		}
	});
});
