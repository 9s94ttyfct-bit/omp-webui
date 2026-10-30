import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../server/sessions/store.ts";

/**
 * Deleting rows of the full-text index does not give its file back by itself (FTS5 only marks them). The worker counts what it
 * removed and, once that is a quarter of what the index held, merges the segments and returns the pages, a piece at a time,
 * when nothing else is asked of it (`SessionStore.compacted` asks for it at once, and answers when it is done); and it folds
 * the journal into the file after a big delete. Real files, no omp.
 */

// Each test builds, indexes and compacts a library of hundreds of conversations: 0.5-2.7 s alone, more than Bun's 5 s on a busy machine.
// A test that times out is followed by `afterEach` closing its store, which rejects what it still waits for with "The search index was closed".
setDefaultTimeout(60_000);

const root = mkdtempSync(join(tmpdir(), "ompw-compact-"));
const stores: SessionStore[] = [];
let n = 0;
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let seed = 0x2545f491;
const random = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 2 ** 32;
};
const vocabulary = Array.from({ length: 3000 }, (_, i) => `w${((i * 2654435761) >>> 0).toString(36)}`);
const prose = (words: number) =>
	Array.from({ length: words }, () => vocabulary[Math.floor(random() * vocabulary.length)]).join(" ");

/** `count` conversations of `messages` messages each (the word of the conversation, `keep`, is in every one of them). */
function library(count: number, messages: number): { sessions: string; files: string[]; data: string } {
	const dir = join(root, `lib-${++n}`);
	const bucket = join(dir, "sessions", "-tmp-compact");
	mkdirSync(bucket, { recursive: true });
	const files: string[] = [];
	for (let i = 0; i < count; i++) {
		const id = `01a00000-0000-7000-8000-${(i + 1).toString(16).padStart(12, "0")}`;
		const lines: unknown[] = [
			{ type: "session", version: 3, id, timestamp: "2026-01-07T00:00:00.000Z", cwd: "/tmp/compact" },
		];
		for (let m = 0; m < messages; m++) {
			lines.push({
				type: "message",
				id: `m${i}-${m}`,
				parentId: m ? `m${i}-${m - 1}` : null,
				timestamp: "2026-01-07T00:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: `conv${i} ${prose(60)}` }] },
			});
		}
		const file = join(bucket, `2026-01-07T00-00-00-${String(i).padStart(3, "0")}Z_${id}.jsonl`);
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		files.push(file);
	}
	return { sessions: join(dir, "sessions"), files, data: join(dir, "data") };
}

function open(lib: { sessions: string; data: string }): SessionStore {
	mkdirSync(lib.data, { recursive: true });
	const store = new SessionStore(lib.sessions, join(lib.data, "index.db"));
	stores.push(store);
	return store;
}
const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0);

const pragma = (file: string, name: string): number => {
	const raw = new Database(file, { readonly: true });
	try {
		return Object.values(raw.query<Record<string, number>, []>(`PRAGMA ${name}`).get() ?? {})[0] ?? 0;
	} finally {
		raw.close();
	}
};

test("after most conversations are deleted the index file shrinks to what is left, and the rest is still found", async () => {
	const lib = library(200, 25);
	const store = open(lib);
	await store.indexed();
	const search = join(lib.data, "index.search.db");
	const before = sizeOf(search);
	expect(before).toBeGreaterThan(2 * 1024 * 1024);

	// 170 of 200 go: most of the 5000 rows it holds
	for (const file of lib.files.slice(0, 170)) rmSync(file);
	await store.refresh(true);
	await store.indexed();
	// Hits of what went are gone at once; the file is as large as it was until the worker compacts.
	expect(await store.search("conv3 ")).toHaveLength(0);
	expect(sizeOf(search)).toBeGreaterThan(before * 0.9);
	expect((await store.compacted()).compactions).toBe(1);

	const after = sizeOf(search);
	expect(after).toBeLessThan(before * 0.4);
	expect(sizeOf(`${search}-wal`)).toBe(0);
	// What is left is whole.
	const hits = await store.search("conv185", 50);
	expect(hits.map((h) => h.file)).toContain(lib.files[185]);
	expect(pragma(search, "freelist_count")).toBe(0);
});

test("a file made before `auto_vacuum` is rewritten once, and kept in that mode: the next deletions are returned in pieces", async () => {
	const lib = library(200, 25);
	const first = open(lib);
	await first.indexed();
	first.close();
	const search = join(lib.data, "index.search.db");
	// An index as the versions before this one made it: no incremental vacuum.
	const raw = new Database(search);
	raw.run("PRAGMA auto_vacuum = NONE");
	raw.run("VACUUM");
	raw.close();
	expect(pragma(search, "auto_vacuum")).toBe(0);
	const before = sizeOf(search);

	for (const file of lib.files.slice(0, 170)) rmSync(file);
	const store = open(lib);
	expect((await store.compacted()).compactions).toBe(1);
	store.close();
	expect(pragma(search, "auto_vacuum")).toBe(2);
	expect(sizeOf(search)).toBeLessThan(before * 0.4);
});

test("an index with a history of removed files is compacted without anything being deleted: the rows it lost are counted from its file numbers", async () => {
	const lib = library(200, 25);
	const first = open(lib);
	await first.indexed();
	first.close();
	const search = join(lib.data, "index.search.db");
	const before = sizeOf(search);
	// What the versions before this one left: files forgotten, rows deleted, nothing counted, nothing compacted.
	const raw = new Database(search);
	raw.run("DELETE FROM meta WHERE key = 'dead'");
	const gone = raw.query<{ fid: number; file: string }, []>("SELECT fid, file FROM files ORDER BY fid LIMIT 170").all();
	for (const g of gone) {
		raw.run("DELETE FROM fts WHERE rowid >= ? AND rowid < ?", [g.fid * 2 ** 24, (g.fid + 1) * 2 ** 24]);
		raw.run("DELETE FROM files WHERE fid = ?", [g.fid]);
		rmSync(g.file);
	}
	raw.close();

	const store = open(lib);
	expect((await store.compacted()).compactions).toBe(1);
	expect(sizeOf(search)).toBeLessThan(before * 0.4);
});

test("an index that is not mostly dead rows is left as it is", async () => {
	const lib = library(120, 25);
	const store = open(lib);
	await store.indexed();
	// A tenth of it goes: under a quarter, so there is nothing to compact.
	for (const file of lib.files.slice(0, 12)) rmSync(file);
	await store.refresh(true);
	const done = await store.compacted();
	expect(done.compactions).toBe(0);
	expect(done.rows).toBeGreaterThan(0);
});

test("the journal is folded into the file, and cut off, after a delete that wrote a lot to it", async () => {
	const lib = library(3, 4);
	// One conversation of thousands of messages: deleting it is thousands of rows.
	const bigFile = join(
		lib.sessions,
		"-tmp-compact",
		"2026-01-07T00-00-00-999Z_01a00000-0000-7000-8000-00000000ffff.jsonl",
	);
	const lines: unknown[] = [
		{
			type: "session",
			version: 3,
			id: "01a00000-0000-7000-8000-00000000ffff",
			timestamp: "2026-01-07T00:00:00.000Z",
			cwd: "/tmp/compact",
		},
	];
	for (let m = 0; m < 6000; m++) {
		lines.push({
			type: "message",
			id: `b${m}`,
			parentId: m ? `b${m - 1}` : null,
			timestamp: "2026-01-07T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: `big${m} ${prose(40)}` }] },
		});
	}
	writeFileSync(bigFile, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	const store = open(lib);
	await store.indexed();
	rmSync(bigFile);
	await store.refresh(true);
	await store.indexed();
	expect(sizeOf(join(lib.data, "index.search.db-wal"))).toBe(0);
	expect(await store.search("big5999")).toHaveLength(0);
});
