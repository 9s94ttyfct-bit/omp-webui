import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyUsage, parseSessionText, summarize, withDependents } from "../../server/sessions/parse.ts";
import { SessionStore, type StoreOptions } from "../../server/sessions/store.ts";

/**
 * A transcript that grew is summarized and indexed from where the last pass stopped, not from its first byte; one
 * that was rewritten is read again from the start. Every case compares with what reading the whole file gives.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-tail-"));
const stores: SessionStore[] = [];
afterAll(() => {
	for (const s of stores) s.close();
	rmSync(root, { recursive: true, force: true });
});

let cases = 0;
function setup() {
	const dir = join(root, `case-${cases++}`);
	const bucket = join(dir, "sessions", "-tmp-tail");
	mkdirSync(bucket, { recursive: true });
	const db = join(dir, "index.db");
	const open = (options?: StoreOptions) => {
		const store = new SessionStore(join(dir, "sessions"), db, options);
		stores.push(store);
		return store;
	};
	return {
		dir,
		bucket,
		db,
		open,
		file: join(bucket, "2026-01-09T00-00-00-000Z_01a00000-0000-7000-8000-00000000d1d1.jsonl"),
	};
}

const STAMP = "2026-01-09T00:00:00.000Z";
const header = {
	type: "session",
	version: 3,
	id: "01a00000-0000-7000-8000-00000000d1d1",
	timestamp: STAMP,
	cwd: "/tmp/tail",
};
let entryNo = 0;
const user = (text: string, extra: Record<string, unknown> = {}) => ({
	type: "message",
	id: `u${entryNo++}`,
	parentId: null,
	timestamp: STAMP,
	message: { role: "user", content: [{ type: "text", text }], ...extra },
});
const assistant = (text: string, model = "claude-haiku-5-5") => ({
	type: "message",
	id: `a${entryNo++}`,
	parentId: null,
	timestamp: STAMP,
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "anthropic",
		model,
		usage: { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, totalTokens: 26, cost: { total: 0.002 } },
	},
});
/** Longer than the window of bytes before an offset that is hashed to tell a rewrite from an append. */
const filler = () => assistant("filler ".repeat(1000));
const lines = (entries: unknown[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join("");

/** What reading the whole file gives, the shape clients get. */
function wholeFileSummary(file: string) {
	const st = statSync(file);
	const own = summarize(file, parseSessionText(readFileSync(file, "utf8")), st, 0);
	if (!own) throw new Error("no header");
	return withDependents(own, { subagents: { count: 0, usage: emptyUsage() }, advisor: emptyUsage() });
}

async function expectSameAsWholeFile(store: SessionStore, file: string) {
	await store.refresh(true);
	expect(await store.get(file)).toEqual(wholeFileSummary(file));
}

test("appended entries fold into the summary exactly as reading the whole file would", async () => {
	const t = setup();
	writeFileSync(t.file, lines([header, user("first question", { attribution: "user" }), assistant("first answer")]));
	const store = t.open();
	await expectSameAsWholeFile(store, t.file);
	const rounds: unknown[][] = [
		[user("second question"), assistant("second answer", "claude-opus-5")],
		[
			{ type: "title_change", id: "tc1", parentId: null, timestamp: STAMP, title: "Named later" },
			{ type: "title_change", id: "tc2", parentId: null, timestamp: STAMP, title: "Not this one" },
		],
		[
			{ type: "model_usage", id: "mu1", parentId: null, timestamp: STAMP, usage: assistant("x").message.usage },
			user("an agent's message", { attribution: "agent" }),
		],
		[assistant("third answer")],
	];
	for (const round of rounds) {
		appendFileSync(t.file, lines(round));
		await expectSameAsWholeFile(store, t.file);
	}
	const summary = await store.get(t.file);
	expect(summary?.title).toBe("Named later");
	expect(summary?.preview).toBe("first question");
	expect(summary?.models).toEqual(["anthropic/claude-haiku-5-5", "anthropic/claude-opus-5"]);
});

test("the start of a transcript that only grew is not read again", async () => {
	const t = setup();
	writeFileSync(t.file, lines([header, user("alpha one"), filler(), assistant("reply")]));
	const store = t.open();
	await store.refresh();
	expect((await store.get(t.file))?.preview).toBe("alpha one");

	// Change a byte in the middle without changing the length: a pass that read from the start would see it.
	writeFileSync(t.file, readFileSync(t.file, "utf8").replace("alpha one", "omega one"));
	appendFileSync(t.file, lines([user("another")]));
	await store.refresh(true);
	const summary = await store.get(t.file);
	expect(summary?.messageCount).toBe(4);
	expect(summary?.preview).toBe("alpha one");
});

test("a transcript that was rewritten is read again from the start", async () => {
	const t = setup();
	writeFileSync(t.file, lines([header, user("old words here"), assistant("old reply")]));
	const store = t.open();
	await store.indexed();
	expect((await store.search("old words")).length).toBe(1);
	const before = (await store.indexed()).resets;

	// Longer than before, but not an extension of it.
	writeFileSync(t.file, lines([header, user("new words there"), assistant("new reply"), user("and one more")]));
	await expectSameAsWholeFile(store, t.file);
	expect((await store.get(t.file))?.preview).toBe("new words there");
	const after = await store.indexed();
	expect(after.resets).toBe(before + 1);
	expect(await store.search("old words")).toEqual([]);
	expect((await store.search("new words")).length).toBe(1);

	// And shorter.
	writeFileSync(t.file, lines([header, user("tiny one")]));
	await expectSameAsWholeFile(store, t.file);
	await store.indexed();
	expect(await store.search("new words")).toEqual([]);
	expect((await store.search("tiny one")).length).toBe(1);
});

test("an entry the writer has not finished counts once it is whole, and only once", async () => {
	const t = setup();
	const whole = JSON.stringify(user("being written"));
	writeFileSync(t.file, lines([header, user("done")]) + whole.slice(0, 30));
	const store = t.open();
	await store.indexed();
	expect((await store.get(t.file))?.messageCount).toBe(1);
	expect(await store.search("being written")).toEqual([]);

	appendFileSync(t.file, `${whole.slice(30)}\n`);
	await expectSameAsWholeFile(store, t.file);
	await store.indexed();
	expect((await store.get(t.file))?.messageCount).toBe(2);
	expect((await store.search("being written")).length).toBe(1);
});

test("a last line without a newline counts when it is whole JSON, and is not counted twice when the newline comes", async () => {
	const t = setup();
	writeFileSync(t.file, lines([header, user("one")]) + JSON.stringify(user("two")));
	const store = t.open();
	await expectSameAsWholeFile(store, t.file);
	await store.indexed();
	expect((await store.get(t.file))?.messageCount).toBe(2);
	expect((await store.search("two")).length).toBe(1);

	appendFileSync(t.file, `\n${JSON.stringify(user("three"))}\n`);
	await expectSameAsWholeFile(store, t.file);
	await store.indexed();
	expect((await store.get(t.file))?.messageCount).toBe(3);
	expect((await store.search("two")).length).toBe(1);
	expect((await store.search("three")).length).toBe(1);
});

test("a title written into the fixed-width slot shows without the rest of the file being read again", async () => {
	const t = setup();
	const slot = (title: string) => {
		const s = { type: "title", v: 1, title, source: "user", updatedAt: STAMP, pad: "" };
		s.pad = " ".repeat(255 - Buffer.byteLength(JSON.stringify(s)));
		return `${JSON.stringify(s)}\n`;
	};
	writeFileSync(t.file, slot("Before") + lines([header, user("alpha one"), filler()]));
	const store = t.open();
	await store.refresh();
	expect((await store.get(t.file))?.title).toBe("Before");

	// Same length, so only the modification time says the file changed.
	const content = readFileSync(t.file, "utf8");
	writeFileSync(t.file, slot("After!") + content.slice(256).replace("alpha one", "omega one"));
	const now = new Date(Date.now() + 5000);
	utimesSync(t.file, now, now);
	await store.refresh(true);
	const summary = await store.get(t.file);
	expect(summary?.title).toBe("After!");
	// The entries were not read again (see the test above): the replaced word did not reach the summary.
	expect(summary?.preview).toBe("alpha one");
});

test("what was read survives a restart: a grown transcript is still read from where it stopped", async () => {
	const t = setup();
	writeFileSync(t.file, lines([header, user("alpha one"), filler(), assistant("reply")]));
	const first = t.open();
	await first.indexed();
	first.close();

	const second = t.open();
	writeFileSync(t.file, readFileSync(t.file, "utf8").replace("alpha one", "omega one"));
	appendFileSync(t.file, lines([assistant("more")]));
	await second.refresh(true);
	const summary = await second.get(t.file);
	expect(summary?.messageCount).toBe(4);
	expect(summary?.preview).toBe("alpha one");
	await second.indexed();
	expect((await second.search("more")).length).toBe(1);
});

test("a database from before the offsets were kept still works: its summaries stay and the file is read once when it changes", async () => {
	const t = setup();
	writeFileSync(t.file, lines([header, user("alpha one"), assistant("reply")]));
	const first = t.open();
	await first.indexed();
	first.close();

	// What version 2 left: no per-file offsets, and its full-text index inside this database.
	const db = new Database(t.db);
	db.run("DROP TABLE session_state");
	db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', '2')");
	db.run(
		"CREATE VIRTUAL TABLE fts USING fts5(text, file UNINDEXED, entry_id UNINDEXED, role UNINDEXED, ts UNINDEXED, tokenize = 'trigram')",
	);
	db.run("INSERT INTO fts (text, file, entry_id, role, ts) VALUES ('stale legacy row', ?, 'x', 'user', '')", [t.file]);
	db.close();

	const store = t.open();
	expect((await store.list()).map((s) => s.preview)).toEqual(["alpha one"]);
	await store.indexed();
	expect(await store.search("stale legacy")).toEqual([]);
	expect((await store.search("alpha one")).length).toBe(1);
	const legacy = new Database(t.db, { readonly: true });
	const tables = legacy.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name LIKE 'fts%'").all();
	legacy.close();
	expect(tables).toEqual([]);

	appendFileSync(t.file, lines([user("after the upgrade")]));
	await expectSameAsWholeFile(store, t.file);
	await store.indexed();
	expect((await store.search("after the upgrade")).length).toBe(1);
});

test("a tail append adds only the new entries to the search index", async () => {
	const t = setup();
	const first = [header, user("kiwi in the first batch"), assistant("kiwi reply"), user("no fruit here")];
	writeFileSync(t.file, lines(first));
	const store = t.open();
	const cold = await store.indexed();
	expect(cold.rows).toBe(3);
	expect(cold.resets).toBe(0);

	appendFileSync(t.file, lines([user("kiwi in the second batch"), assistant("second reply")]));
	const warm = await store.indexed();
	expect(warm.rows - cold.rows).toBe(2);
	expect(warm.resets).toBe(0);
	const hits = await store.search("kiwi", 50, t.file);
	// In rank order, which is not the order of the file.
	expect(hits.map((h) => h.snippet.replaceAll("\u0002", "[").replaceAll("\u0003", "]")).sort()).toEqual([
		"[kiwi] in the first batch",
		"[kiwi] in the second batch",
		"[kiwi] reply",
	]);

	// Nothing changed: nothing is indexed again.
	await store.refresh(true);
	expect((await store.indexed()).rows).toBe(warm.rows);
});

test("a deleted transcript leaves the index", async () => {
	const t = setup();
	writeFileSync(t.file, lines([header, user("passion fruit")]));
	const store = t.open();
	await store.indexed();
	expect((await store.search("passion")).length).toBe(1);
	rmSync(t.file);
	await store.refresh(true);
	const status = await store.indexed();
	expect(status.total).toBe(0);
	expect(await store.search("passion")).toEqual([]);
});

/** Six conversations of about 1.6 MB each, the oldest first, so that indexing them takes a while. */
function writeLibrary(t: ReturnType<typeof setup>): string[] {
	return Array.from({ length: 6 }, (_, i) => {
		const id = `01a00000-0000-7000-8000-00000000e${i}e${i}`;
		const file = join(t.bucket, `2026-01-09T00-0${i}-00-000Z_${id}.jsonl`);
		const text = `durian ${"lorem ipsum dolor sit amet ".repeat(400)}`;
		writeFileSync(file, lines([{ ...header, id }, ...Array.from({ length: 150 }, () => user(text))]));
		const at = new Date(Date.UTC(2026, 0, 9, 0, i));
		utimesSync(file, at, at);
		return file;
	});
}

test("a search does not wait for a library that is still being indexed, and says how much was ready", async () => {
	const t = setup();
	writeLibrary(t);
	const store = t.open();
	const partial = await store.searchResult("durian", 50, undefined, { waitMs: 0 });
	expect(partial.coverage.total).toBe(6);
	expect(partial.coverage.indexed).toBeLessThan(6);
	const complete = await store.indexed();
	expect(complete.indexed).toBe(6);
	expect(new Set((await store.search("durian", 200)).map((h) => h.file)).size).toBe(6);
});

test("one conversation is searched in full while the rest of a library is still waiting: it is indexed first", async () => {
	const t = setup();
	const files = writeLibrary(t);
	const store = t.open();
	const oldest = files[0] as string;
	const { hits, coverage } = await store.searchResult("durian", 200, oldest);
	expect(hits.length).toBe(150);
	expect(coverage.indexed).toBeLessThan(6);
});

test("a search that names a conversation is answered from all of it, however long it takes to index (#509)", async () => {
	const t = setup();
	// One conversation big enough that indexing it does not finish within the moment a search waits for a library.
	const id = "01a00000-0000-7000-8000-00000000f0f0";
	const file = join(t.bucket, `2026-01-09T00-00-00-000Z_${id}.jsonl`);
	const text = `durian ${"lorem ipsum dolor sit amet ".repeat(400)}`;
	writeFileSync(file, lines([{ ...header, id }, ...Array.from({ length: 200 }, () => user(text))]));
	const store = t.open();
	// The whole conversation is in the answer, and the answer says it is: the file is not left partly indexed (#509).
	const { hits, file: covered } = await store.searchResult("durian", 200, file);
	expect(hits.length).toBe(200);
	expect(covered?.complete).toBe(true);
	expect(covered?.indexed).toBe(covered?.total);
});

test("a search that names a conversation that is not in the index says so, instead of answering that it holds nothing (#509)", async () => {
	const t = setup();
	const files = writeLibrary(t);
	const store = t.open();
	const oldest = files[0] as string;
	// Asked for without a wait: the answer comes at once, and it says that the conversation is not wholly in the index,
	// so its empty hits are not read as "there is nothing in it" (#509).
	const { hits, file: covered } = await store.searchResult("durian", 200, oldest, { waitMs: 0 });
	expect(covered).toBeDefined();
	expect(covered?.complete).toBe(false);
	expect(covered?.indexed).toBeLessThan(covered?.total ?? 0);
	// Whether the hits are there or not, the answer does not claim the conversation was searched in full.
	if (hits.length > 0) expect(covered?.complete).toBe(true);
});

test("a conversation whose last line is not whole is searched in full: the index has reached the end of what it will index (#544)", async () => {
	const t = setup();
	// omp killed in the middle of a write: the last line has no newline and is not JSON yet.
	writeFileSync(
		t.file,
		`${lines([header, user("durian first"), assistant("durian reply")])}{"type":"message","id":"zz","mess`,
	);
	const store = t.open();
	await store.indexed();
	const { hits, file: covered } = await store.searchResult("durian", 200, t.file);
	expect(hits).toHaveLength(2);
	// Nothing more will come of this file until the writer finishes the line: the caller is not told to ask again.
	expect(covered?.complete).toBe(true);
	expect((await store.searchResult("durian", 200, t.file)).file?.complete).toBe(true);

	// The writer finishes the line: it is indexed, and the answer still says it is all in.
	appendFileSync(t.file, 'age":{"role":"user","content":[{"type":"text","text":"durian last"}]}}\n');
	await store.indexed();
	const done = await store.searchResult("durian", 200, t.file);
	expect(done.hits).toHaveLength(3);
	expect(done.file?.complete).toBe(true);
});

/** A conversation of `rows` lines of about a kilobyte, a match for "zyxwv" in the last one only. */
function writeBigConversation(file: string, rows: number): void {
	const filler = "lorem ipsum dolor sit amet ".repeat(40);
	const entries = Array.from({ length: rows }, (_, i) => user(i === rows - 1 ? `${filler} zyxwv-last` : filler));
	writeFileSync(file, lines([header, ...entries]));
}

test("a search that names a conversation still being indexed waits for all of it, however long that takes (#509, #545)", async () => {
	const t = setup();
	// 3000 rows: the worker takes in 500 at most per batch, so the file is several batches long.
	writeBigConversation(t.file, 3000);
	const store = t.open({
		// The real worker, held after the first batch of a file until a moment after the search has arrived (see the
		// worker): the conversation is still being indexed when the search comes, whatever the speed of the machine.
		searchIndex: { spawn: () => new Worker(new URL("../support/gated-index-worker.ts", import.meta.url)) },
	});
	// A wait of a millisecond is all a library-wide search gives the index; this one names the conversation, whose own
	// bound is its size (3 MB: three seconds), ample for the worker to be let go and finish it.
	const { hits, file: covered } = await store.searchResult("zyxwv", 50, t.file, { waitMs: 1 });
	// The one match is in the last line of the file: only an answer from all of it has it.
	expect(hits).toHaveLength(1);
	expect(covered?.complete).toBe(true);
	expect(covered?.indexed).toBe(covered?.total);
});
