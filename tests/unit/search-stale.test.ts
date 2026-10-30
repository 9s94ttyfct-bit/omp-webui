import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../server/sessions/store.ts";

/**
 * The full-text index forgets the files that went, and used to know of them only from what it was told in the same run: a
 * conversation deleted (or a library moved) while no server was running stayed in the index for good, was found by search, and
 * could not be opened. The first list a server gives the index after it starts is every file there is.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-stale-"));
const stores: SessionStore[] = [];
let n = 0;
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A sessions dir with one conversation per word, each saying its word. */
function library(words: string[]): { sessions: string; files: Record<string, string>; data: string } {
	const dir = join(root, `lib-${++n}`);
	const bucket = join(dir, "sessions", "-tmp-stale");
	mkdirSync(bucket, { recursive: true });
	const files: Record<string, string> = {};
	words.forEach((word, i) => {
		const id = `01a00000-0000-7000-8000-${(i + 1).toString(16).padStart(12, "0")}`;
		const file = join(bucket, `2026-01-07T00-00-00-000Z_${id}.jsonl`);
		const lines = [
			{ type: "session", version: 3, id, timestamp: "2026-01-07T00:00:00.000Z", cwd: "/tmp/stale" },
			{
				type: "message",
				id: `m${i}`,
				parentId: null,
				timestamp: "2026-01-07T00:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: `${word} question` }] },
			},
		];
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		files[word] = file;
	});
	return { sessions: join(dir, "sessions"), files, data: join(dir, "data") };
}

function open(sessions: string, data: string): SessionStore {
	mkdirSync(data, { recursive: true });
	const store = new SessionStore(sessions, join(data, "index.db"));
	stores.push(store);
	return store;
}

test("a conversation deleted while the server was stopped is not found after it starts again", async () => {
	const lib = library(["persimmon", "quince", "medlar"]);
	const first = open(lib.sessions, lib.data);
	await first.indexed();
	expect(await first.search("persimmon")).toHaveLength(1);
	first.close();

	rmSync(lib.files.persimmon as string);
	const second = open(lib.sessions, lib.data);
	await second.indexed();
	expect(await second.search("persimmon")).toHaveLength(0);
	// The others are as they were, and were not indexed again.
	expect((await second.search("quince")).map((h) => h.file)).toEqual([lib.files.quince]);
	expect((await second.search("medlar")).map((h) => h.file)).toEqual([lib.files.medlar]);
	expect((await second.indexed()).resets).toBe(0);
});

test("a library moved to another directory with its index leaves no rows behind for the old paths", async () => {
	const lib = library(["persimmon", "quince", "medlar"]);
	const first = open(lib.sessions, lib.data);
	await first.indexed();
	first.close();

	const moved = join(root, `moved-${++n}`);
	cpSync(lib.sessions, join(moved, "sessions"), { recursive: true });
	rmSync(lib.sessions, { recursive: true });
	const second = open(join(moved, "sessions"), lib.data);
	await second.indexed();
	const hits = await second.search("persimmon");
	expect(hits).toHaveLength(1);
	expect(hits[0]?.file.startsWith(join(moved, "sessions"))).toBe(true);
	second.close();

	const raw = new Database(join(lib.data, "index.search.db"), { readonly: true });
	try {
		// Three conversations, three rows of `files`: not six.
		expect(raw.query<{ c: number }, []>("SELECT count(*) AS c FROM files").get()?.c).toBe(3);
	} finally {
		raw.close();
	}
});

test("a conversation that appears or goes while the server runs is still told one by one", async () => {
	const lib = library(["persimmon", "quince"]);
	const store = open(lib.sessions, lib.data);
	await store.indexed();
	rmSync(lib.files.quince as string);
	await store.refresh(true);
	await store.indexed();
	expect(await store.search("quince")).toHaveLength(0);
	expect(await store.search("persimmon")).toHaveLength(1);
});

test("rows that a stop left behind for a file that was being forgotten are deleted after the next start", async () => {
	const lib = library(["persimmon", "quince", "medlar"]);
	const first = open(lib.sessions, lib.data);
	await first.indexed();
	first.close();
	// What a server that stopped while it deleted a file's rows leaves: the file under the name it was given (no list holds it)
	// and its rows, which a search would still find.
	const raw = new Database(join(lib.data, "index.search.db"));
	raw.run("UPDATE files SET file = file || char(0) || 'gone' WHERE file = ?", [lib.files.persimmon as string]);
	raw.close();
	rmSync(lib.files.persimmon as string);

	const second = open(lib.sessions, lib.data);
	await second.indexed();
	expect(await second.search("persimmon")).toHaveLength(0);
	second.close();
	const check = new Database(join(lib.data, "index.search.db"), { readonly: true });
	try {
		expect(check.query<{ c: number }, []>("SELECT count(*) AS c FROM files").get()?.c).toBe(2);
	} finally {
		check.close();
	}
});
