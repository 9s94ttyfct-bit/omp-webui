import { afterAll, expect, test } from "bun:test";
import {
	appendFileSync,
	closeSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type FileIndex, IndexCache, nextChunk, Role, readEntries } from "../../server/history-index.ts";
import { parseViewRequest, ViewError } from "../../server/history-request.ts";
import { parseSessionText } from "../../server/sessions/parse.ts";
import type { SessionEntry, SessionFileData } from "../../shared/protocol.ts";
import { promptsOf } from "../../web/src/lib/recall.ts";
import { sumEntries, usageByModel } from "../../web/src/lib/totals.ts";
import { activeMs } from "../../web/src/lib/turn-stats.ts";
import { FIXTURE, seedFixtures } from "../support/fixtures.ts";
import { ask, askStats, pathTo, scratch, turns, writeSession } from "../support/history-fixtures.ts";
import { assistant, entry, user } from "../support/session-entries.ts";

/**
 * The windows of the history (`server/history.ts`) and the index they are made from (`server/history-index.ts`), over files of a
 * known shape: what a window holds, where it begins and ends, what the path above it leaves, the other versions of its
 * entries, and the figures of the whole file. The answers are read as the page reads them.
 */

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
	const d = scratch();
	dirs.push(d);
	return d;
}

const roleOf = (e: SessionEntry): string => (e.message as { role?: string } | undefined)?.role ?? e.type;

// ------------------------------------------------------------------ the index

test("the index finds the entries of a file as the lines were written, by the start of the line or by parsing it", () => {
	const d = dir();
	const stamp = (n: number) => `2026-01-20T10:00:0${n}.000Z`;
	const lines = [
		// omp's key order: read from the start of the line.
		`{"type":"message","id":"a","parentId":null,"timestamp":"${stamp(0)}","message":{"role":"user","content":[{"type":"text","text":"hi"}],"attribution":"user"}}`,
		// Another key order, an escape in the id, a non-ASCII character: parsed.
		`{"id":"b","type":"message","parentId":"a","timestamp":"${stamp(1)}","message":{"role":"assistant","content":[]}}`,
		`{"type":"message","id":"c\\u00e9","parentId":"b","timestamp":"${stamp(2)}","message":{"role":"toolResult","content":[]}}`,
		`{"type":"label","id":"dé","parentId":"c\\u00e9","timestamp":"${stamp(3)}"}`,
		"",
		"   ",
		"this is not json",
		`{"type":"custom","note":"an object that is no entry: it has no id"}`,
		`[1,2,3]`,
		// No parentId at all: a root.
		`{"type":"label","id":"e","timestamp":"${stamp(4)}"}`,
		// A line that stops short (the writer is not done): it has the start of an entry and no end.
		`{"type":"message","id":"g","parentId":"e","timestamp":"${stamp(5)}","message":{"role":"user","content":[`,
	];
	const file = writeSession(d, "index", lines, { title: "A title", eol: "\r\n" });
	const index = new IndexCache().get(file);
	expect(index.ids).toEqual(["a", "b", "cé", "dé", "e"]);
	expect(index.parents).toEqual([null, "a", "b", "cé", null]);
	expect(index.types).toEqual(["message", "message", "message", "label", "label"]);
	expect(index.stamps).toEqual([stamp(0), stamp(1), stamp(2), stamp(3), stamp(4)]);
	expect(index.roles.slice(0, 3)).toEqual([Role.USER, Role.ASSISTANT, Role.OTHER]);
	expect(index.roles[3]).toBe(Role.NOT_MESSAGE);
	expect(index.head).toBe("e");
	// The lines come back as written, without the CR that ended them.
	const fd = require("node:fs").openSync(file, "r");
	try {
		expect(readEntries(fd, index, [0, 1, 2, 3, 4])).toEqual([lines[0], lines[1], lines[2], lines[3], lines[9]]);
	} finally {
		require("node:fs").closeSync(fd);
	}
	// The header is the file's, with the title slot's title.
	expect(JSON.parse(index.header())).toMatchObject({
		type: "session",
		cwd: "/tmp/ompw-fixture-project",
		title: "A title",
	});
	expect(index.parentOf(1)).toBe(0);
	expect(index.parentOf(0)).toBe(-1);
});

test("a parent id with characters beyond Latin-1 is kept as written: the child finds its parent whichever is written first, and the window serves it", () => {
	const d = dir();
	const at = (n: number) => `2026-01-20T10:00:0${n}.000Z`;
	for (const [n, id] of ["父", "🙂", "é父🙂x"].entries()) {
		const child = { type: "label", id: "kid", parentId: id, timestamp: at(1) };
		const parent = { type: "label", id, timestamp: at(2) };

		// The parent is written after its child (the line of the child is parsed: it has characters the fast path leaves to the parser).
		const late = writeSession(d, `late-${n}`, [child, parent]);
		const cache = new IndexCache();
		const index = cache.get(late);
		expect(index.ids).toEqual(["kid", id]);
		expect(index.parents).toEqual([id, null]);
		expect(index.parentOf(0)).toBe(1);
		expect(index.children().get(id)).toEqual([0]);
		// A child written after the children were listed is listed under the same key.
		appendFileSync(late, `${JSON.stringify({ type: "label", id: "kid2", parentId: id, timestamp: at(3) })}\n`);
		expect(cache.get(late)).toBe(index);
		expect(index.children().get(id)).toEqual([0, 2]);
		expect(index.parentOf(2)).toBe(1);
		const served = ask(new IndexCache(), late, [late], { kind: "tail", leaf: "kid" });
		expect(served.ids).toEqual([id, "kid"]);
		expect(served.own.entries.find((e) => e.id === "kid")?.parentId).toBe(id);

		// The parent is written first, the usual order.
		const usual = writeSession(d, `usual-${n}`, [parent, child]);
		const usualIndex = new IndexCache().get(usual);
		expect(usualIndex.parents).toEqual([null, id]);
		expect(usualIndex.parentOf(1)).toBe(0);
		expect(usualIndex.children().get(id)).toEqual([1]);

		// The parent is not in the file at all: the page is told which id it named.
		const orphan = writeSession(d, `orphan-${n}`, [child]);
		const orphanIndex = new IndexCache().get(orphan);
		expect(orphanIndex.parents).toEqual([id]);
		expect(orphanIndex.parentOf(0)).toBe(-1);
		const orphaned = ask(new IndexCache(), orphan, [orphan], { kind: "tail" });
		expect(orphaned.own.entries[0]?.parentId).toBe(id);
	}
});

test("a line longer than a piece is indexed whole, and the piece it is read with grows by one jump to 16 MB and then doubles", () => {
	const MB = 1024 * 1024;
	// 2 MB (the piece) → 16 MB → 32 MB → 64 MB → 128 MB: a line of 2-16 MB is read at 16 MB and copied once, not at 4 and 8 MB first.
	const sizes = [2 * MB];
	for (let i = 0; i < 4; i++) sizes.push(nextChunk(sizes[i] as number));
	expect(sizes).toEqual([2 * MB, 16 * MB, 32 * MB, 64 * MB, 128 * MB]);

	const d = dir();
	// Lines that end in the first read after the piece (3 MB), in the 16 MB read (9 MB), and past it (17 MB, read at 32 MB).
	for (const [name, bytes] of [
		["three", 3 * MB],
		["nine", 9 * MB],
		["seventeen", 17 * MB],
	] as const) {
		const entries = [user("a", null, 0, "one"), user("big", "a", 1, "x".repeat(bytes)), user("c", "big", 2, "three")];
		const file = writeSession(d, name, entries);
		const index = new IndexCache().get(file);
		expect(index.ids, name).toEqual(["a", "big", "c"]);
		expect(index.parents, name).toEqual([null, "a", "big"]);
		expect(index.lens[1], name).toBeGreaterThan(bytes);
		const fd = openSync(file, "r");
		try {
			expect(readEntries(fd, index, [0, 1, 2]), name).toEqual(entries.map((e) => JSON.stringify(e)));
		} finally {
			closeSync(fd);
		}
	}
});

test("a last line with no newline is an entry when it is whole, and is read again when the file grows", () => {
	const d = dir();
	const whole = JSON.stringify(user("a", null, 0, "one"));
	const cache = new IndexCache();
	const lines = `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-01-20T10:00:00.000Z", cwd: "/x" })}\n${whole}`;
	const plain = join(d, "plain.jsonl");
	writeFileSync(plain, lines);
	const a = cache.get(plain);
	expect(a.ids).toEqual(["a"]);
	expect(a.committed).toBe(0);

	// The writer finishes the line and writes another: the entry is not counted twice.
	appendFileSync(plain, `\n${JSON.stringify(assistant("b", "a", 1, { text: "two" }))}\n`);
	const b = cache.get(plain);
	expect(b).toBe(a);
	expect(b.ids).toEqual(["a", "b"]);
	expect(b.committed).toBe(2);
	expect(b.parentOf(1)).toBe(0);

	// A last line that is not whole is not an entry yet.
	appendFileSync(plain, `{"type":"message","id":"c","parentId":"b","timest`);
	expect(cache.get(plain).ids).toEqual(["a", "b"]);
	appendFileSync(plain, `amp":"2026-01-20T10:00:09.000Z"}\n`);
	expect(cache.get(plain).ids).toEqual(["a", "b", "c"]);
});

test("a file that grew is indexed from where it stopped; a file that was rewritten or replaced is indexed again", () => {
	const d = dir();
	const file = writeSession(d, "grow", turns(3));
	const cache = new IndexCache();
	const first = cache.get(file);
	expect(first.length).toBe(12);
	expect(cache.get(file)).toBe(first);

	appendFileSync(
		file,
		`${turns(1, { prefix: "n", parent: "f2", at: 100 })
			.map((e) => JSON.stringify(e))
			.join("\n")}\n`,
	);
	const grown = cache.get(file);
	expect(grown).toBe(first);
	expect(grown.length).toBe(16);
	expect(grown.head).toBe("nf0");
	expect(grown.parentOf(12)).toBe(grown.byId.get("f2") as number);
	// The children and the newest entries were kept up to date, not left as they were.
	expect(grown.children().get("f2")).toEqual([12]);
	expect(grown.newestUnder()[grown.byId.get("u0") as number]).toBe(15);

	// The same inode, the same length, other bytes at the ends: a rewrite.
	const text = readFileSync(file, "utf8");
	writeFileSync(file, text.replace("prompt 0", "prompt X").replace("answer 2", "answer Z"));
	utimesSync(file, new Date(), new Date(Date.now() + 5000));
	const rewritten = cache.get(file);
	expect(rewritten).not.toBe(first);
	expect(rewritten.length).toBe(16);

	// A rewrite that is longer, with the same start and an end that is not the old one.
	const before = cache.get(file);
	const rest = readFileSync(file, "utf8").split("\n");
	writeFileSync(
		file,
		`${[...rest.slice(0, -3), JSON.stringify(user("zz", null, 500, "other")), ""].join("\n")}\n${"\n".repeat(0)}`,
	);
	appendFileSync(file, `${JSON.stringify(user("zy", "zz", 501, "yet another"))}\n`);
	const longer = cache.get(file);
	expect(longer).not.toBe(before);
	expect(longer.ids.at(-1)).toBe("zy");
	expect(longer.byId.has("nf0")).toBe(false);

	// A file replaced by another (another inode) is another file.
	const other = join(d, "other.jsonl");
	writeFileSync(other, `${rest.join("\n")}\n`);
	renameSync(other, file);
	expect(cache.get(file)).not.toBe(longer);
});

test("the cache keeps a handful of indexes, the least recently used going first, and a job's indexes are not dropped under it", () => {
	const d = dir();
	const files = [1, 2, 3, 4].map((n) => writeSession(d, `lru${n}`, turns(n)));
	const cache = new IndexCache({ max: 2 });
	const [a, b, c, e] = files.map((f) => cache.get(f)) as [FileIndex, FileIndex, FileIndex, FileIndex];
	// All four are held until the job is over.
	expect(cache.size).toBe(4);
	cache.trim();
	expect(cache.size).toBe(2);
	expect(cache.get(files[2] as string)).toBe(c);
	expect(cache.get(files[3] as string)).toBe(e);
	expect(cache.get(files[0] as string)).not.toBe(a);
	expect(cache.get(files[1] as string)).not.toBe(b);

	// Past the byte limit only the newest stays.
	const small = new IndexCache({ bytes: 1 });
	for (const f of files) small.get(f);
	small.trim();
	expect(small.size).toBe(1);
});

// ------------------------------------------------------------------ the windows

/** A conversation of 40 turns of four entries each: 160 entries in one chain. */
function longChain() {
	const d = dir();
	const entries = turns(40);
	const file = writeSession(d, "chain", entries);
	return { file, entries, ids: entries.map((e) => e.id), cache: new IndexCache() };
}

test("the end of a conversation is a window that begins at a prompt, ends at the last entry, and says there is more above", () => {
	const { file, ids, cache } = longChain();
	const tail = ask(cache, file, [file], { kind: "tail", limit: 10 });
	expect(tail.doc.view?.kind).toBe("tail");
	expect(tail.doc.view?.leaf).toBe(ids.at(-1) as string);
	expect(tail.doc.view?.head).toBe(ids.at(-1) as string);
	expect(tail.ids.at(-1)).toBe(ids.at(-1) as string);
	// The last ten entries begin inside a turn: the window goes back to the prompt of that turn.
	expect(tail.ids).toEqual(ids.slice(-12));
	expect(tail.own.entries[0]?.id).toBe("u37");
	expect(tail.doc.view?.earlier).toBe(true);
	expect(tail.doc.view?.later).toBe(false);
	expect(tail.own.entries.every((e, i) => i === 0 || e.parentId === tail.own.entries[i - 1]?.id)).toBe(true);

	// Everything the file has fits in one window when the budget is the server's own.
	const whole = ask(cache, file, [file], { kind: "tail" });
	expect(whole.ids).toEqual(ids.slice(-160));
	expect(whole.doc.view?.earlier).toBe(false);
	// The entries are what the file has, as written.
	expect(whole.own.entries).toEqual(parseSessionText(readFileSync(file, "utf8")).entries);
});

test("older windows put one above the other give the whole path, and each begins at a prompt", () => {
	const { file, ids, cache } = longChain();
	let page = ask(cache, file, [file], { kind: "tail", limit: 30 });
	let path = page.ids;
	const pages = [page.ids.length];
	while (page.doc.view?.earlier) {
		page = ask(cache, file, [file], { kind: "before", at: page.ids[0] as string, limit: 30 });
		// It ends at the parent of the entry it is above.
		expect(page.own.entries.at(-1)?.id).toBe(path[0] ? ids[ids.indexOf(path[0]) - 1] : undefined);
		expect(page.doc.view?.later).toBe(true);
		expect(roleOf(page.own.entries[0] as SessionEntry)).toBe("user");
		path = [...page.ids, ...path];
		pages.push(page.ids.length);
	}
	expect(path).toEqual(ids);
	// 30 entries is a budget, not a size: a page is the whole turns that hold it.
	expect(pages.length).toBeGreaterThan(3);
	expect(pages.every((n) => n >= 28 && n <= 36)).toBe(true);
});

test("a window around an entry has a quarter of the budget above it and the rest below, and later windows reach the leaf", () => {
	const { file, ids, cache } = longChain();
	const at = "u20";
	const around = ask(cache, file, [file], { kind: "around", at, limit: 40 });
	expect(around.ids).toContain(at);
	const above = around.ids.indexOf(at);
	const below = around.ids.length - above - 1;
	// 10 entries above, the prompt that begins them at most three further back; 29 below, the end up to three further on.
	expect(above).toBeGreaterThanOrEqual(10);
	expect(above).toBeLessThanOrEqual(13);
	expect(below).toBeGreaterThanOrEqual(28);
	expect(below).toBeLessThanOrEqual(33);
	expect(around.doc.view?.leaf).toBe(ids.at(-1) as string);
	expect(around.doc.view?.later).toBe(true);
	expect(around.doc.view?.earlier).toBe(true);
	expect(roleOf(around.own.entries[0] as SessionEntry)).toBe("user");

	let page = around;
	const got = [...around.ids];
	while (page.doc.view?.later) {
		const last = page.ids.at(-1) as string;
		page = ask(cache, file, [file], { kind: "after", at: last, leaf: around.doc.view?.leaf ?? undefined, limit: 40 });
		// It begins at the child of the entry it follows, and at a prompt.
		expect(page.own.entries[0]?.parentId).toBe(last);
		expect(roleOf(page.own.entries[0] as SessionEntry)).toBe("user");
		expect(page.doc.view?.above).toBeUndefined();
		got.push(...page.ids);
	}
	expect(got).toEqual(ids.slice(ids.indexOf(got[0] as string)));
	expect(got.at(-1)).toBe(ids.at(-1) as string);
	expect(page.doc.view?.later).toBe(false);
});

test("an agent's own message is no prompt: a window does not begin at it, nor end before it", () => {
	const d = dir();
	const turn = turns(2);
	const reminder = user("remind", "r0_0", 50, "reminder");
	reminder.message = { ...(reminder.message as object), attribution: "agent" };
	// The first turn: the prompt, a step, the agent's reminder to itself, another step, the answer.
	const rest = turns(1, { prefix: "z", parent: "remind", at: 60, steps: 1 }).slice(1);
	const first = [
		turn[0],
		turn[1],
		turn[2],
		reminder,
		{ ...(rest[0] as SessionEntry), parentId: "remind" },
		...rest.slice(1),
	] as SessionEntry[];
	const file = writeSession(d, "reminder", [
		...first,
		...turns(1, { prefix: "n", parent: first.at(-1)?.id ?? null, at: 100 }),
	]);
	const cache = new IndexCache();
	const window = ask(cache, file, [file], { kind: "tail", limit: 4 });
	// The last turn is four entries; the one before it ends at the answer, and the window is the turn alone.
	expect(window.ids[0]).toBe("nu0");
	// Reaching for four entries from the answer of the turn with the reminder lands inside it: the window goes back to the prompt.
	const inside = ask(cache, file, [file], { kind: "tail", leaf: first.at(-1)?.id, limit: 2 });
	expect(inside.ids[0]).toBe("u0");
	expect(inside.ids).toContain("remind");
	// And a window that ends at it is not cut before it.
	const down = ask(cache, file, [file], { kind: "after", at: "u0", limit: 3 });
	expect(down.ids).toContain("remind");
	expect(down.ids.at(-1)).toBe(first.at(-1)?.id);
});

test("a window ends before a prompt, so a turn is not split", () => {
	const { file, ids, cache } = longChain();
	const first = ask(cache, file, [file], { kind: "around", at: "u3", limit: 20 });
	const last = first.ids.at(-1) as string;
	const next = ids[ids.indexOf(last) + 1] as string;
	expect(next.startsWith("u")).toBe(true);
	// "a5_0" is inside turn 5: the page begins at its tool result, and goes on to the end of the turn, past the one entry asked for.
	const page = ask(cache, file, [file], { kind: "after", at: "a5_0", limit: 1 });
	expect(page.ids).toEqual(["r5_0", "f5"]);
	expect(ids[ids.indexOf("f5") + 1]).toBe("u6");
	// Asked for two, it ends at the turn's end as well, with nothing added.
	expect(ask(cache, file, [file], { kind: "after", at: "a5_0", limit: 2 }).ids).toEqual(["r5_0", "f5"]);
});

test("a turn longer than the reach of a window is cut before an assistant message, never between a tool call and its result", () => {
	const d = dir();
	const long = turns(1, { prefix: "x", steps: 300 });
	const entries = [...long, ...turns(1, { prefix: "y", parent: long.at(-1)?.id ?? null, at: 2000 })];
	const file = writeSession(d, "long-turn", entries);
	const cache = new IndexCache();
	const ids = entries.map((e) => e.id);
	let page = ask(cache, file, [file], { kind: "tail" });
	const pages = [page];
	while (page.doc.view?.earlier) {
		page = ask(cache, file, [file], { kind: "before", at: page.ids[0] as string });
		pages.unshift(page);
	}
	expect(pages.flatMap((p) => p.ids)).toEqual(ids);
	expect(pages.length).toBe(3);
	// The first window begins at the prompt; the others where an assistant message does.
	expect(roleOf(pages[0]?.own.entries[0] as SessionEntry)).toBe("user");
	for (const p of pages.slice(1)) expect(roleOf(p.own.entries[0] as SessionEntry)).toBe("assistant");
	// A tool call and its result are in one window.
	for (const p of pages.slice(0, -1)) expect(roleOf(p.own.entries.at(-1) as SessionEntry)).toBe("toolResult");
	for (const p of pages) {
		const calls = p.own.entries.filter(
			(e) => roleOf(e) === "assistant" && JSON.stringify(e).includes('"toolCall"'),
		).length;
		const results = p.own.entries.filter((e) => roleOf(e) === "toolResult").length;
		expect(calls).toBe(results);
	}
	// Going the other way, the windows end before an assistant message too.
	const down = ask(cache, file, [file], { kind: "around", at: "xu0", limit: 40 });
	expect(down.doc.view?.later).toBe(true);
	const next = ids[ids.indexOf(down.ids.at(-1) as string) + 1] as string;
	expect(next.startsWith("xa") || next.startsWith("u") || next.startsWith("xu")).toBe(true);
});

test("limit narrows a window, and no window holds fewer entries than the minimum however large they are", () => {
	const d = dir();
	// A chain of prompts of 400 KB each: every entry begins a turn, so nothing is added to reach one.
	const big: SessionEntry[] = [];
	for (let i = 0; i < 30; i++) big.push(user(`p${i}`, i ? `p${i - 1}` : null, i, `${i} ${"z".repeat(400_000)}`));
	const file = writeSession(d, "big-entries", big);
	const cache = new IndexCache();
	// The byte budget would stop it after two; the minimum is eight.
	expect(ask(cache, file, [file], { kind: "tail" }).ids.length).toBe(8);
	expect(ask(cache, file, [file], { kind: "tail", limit: 3 }).ids.length).toBe(3);
	expect(ask(cache, file, [file], { kind: "tail", limit: 1 }).ids.length).toBe(1);
	expect(ask(cache, file, [file], { kind: "tail", limit: 20 }).ids.length).toBe(8);
	// The same holds for the stretches that go the other way, and around an entry.
	expect(ask(cache, file, [file], { kind: "after", at: "p0" }).ids.length).toBe(8);
	expect(ask(cache, file, [file], { kind: "after", at: "p0", limit: 3 }).ids.length).toBe(3);
	expect(ask(cache, file, [file], { kind: "around", at: "p15" }).ids.length).toBe(8);
	// One entry that is larger than the whole budget still comes.
	const huge = [user("h0", null, 0, "a"), user("h1", "h0", 1, "b".repeat(4 * 1024 * 1024))];
	const hugeFile = writeSession(d, "huge", huge);
	const answered = ask(cache, hugeFile, [hugeFile], { kind: "tail", limit: 1 });
	expect(answered.ids).toEqual(["h1"]);
	expect(answered.doc.view?.earlier).toBe(true);
});

test("a window that holds the root of its path says nothing is above it, including a path whose ancestor is not in the file", () => {
	const d = dir();
	const entries = turns(2);
	const file = writeSession(d, "root", entries);
	const cache = new IndexCache();
	const all = ask(cache, file, [file], { kind: "tail" });
	expect(all.doc.view).toMatchObject({ earlier: false, later: false });
	expect(all.doc.view?.above).toEqual({ carry: [], prompts: [] });
	expect(ask(cache, file, [file], { kind: "before", at: "u0" }).ids).toEqual([]);
	expect(ask(cache, file, [file], { kind: "before", at: "u0" }).doc.view).toMatchObject({
		earlier: false,
		later: false,
	});
	expect(ask(cache, file, [file], { kind: "after", at: "f1" }).ids).toEqual([]);

	// A file whose first entry names a parent the file does not have: the path begins there.
	const orphan = writeSession(d, "orphan", turns(2, { parent: "missing" }));
	const cut = ask(cache, orphan, [orphan], { kind: "tail" });
	expect(cut.ids).toEqual(entries.map((e) => e.id));
	expect(cut.doc.view?.earlier).toBe(false);
	expect(cut.own.entries[0]?.parentId).toBe("missing");
});

test("an entry that is not in the file is not a window: the view names it", () => {
	const { file, cache } = longChain();
	for (const view of [
		{ kind: "before", at: "nope" },
		{ kind: "after", at: "nope" },
		{ kind: "around", at: "nope" },
		{ kind: "tail", leaf: "nope" },
		{ kind: "after", at: "u1", leaf: "nope" },
	] as const) {
		let thrown: unknown;
		try {
			ask(cache, file, [file], view);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(ViewError);
		expect((thrown as ViewError).code).toBe("unknown_entry");
	}
});

test("a window of a file with branches follows one path: the leaf asked for, the end of the file, or the newest entry under the entry", () => {
	const d = dir();
	const trunk = turns(2, { prefix: "t" });
	const a = turns(3, { prefix: "A", parent: "tf1", at: 100 });
	const b = turns(2, { prefix: "B", parent: "tf1", at: 200 });
	// B is written last: the file's head is on it.
	const file = writeSession(d, "branches", [...trunk, ...a, ...b]);
	const cache = new IndexCache();
	const head = ask(cache, file, [file], { kind: "tail" });
	expect(head.ids).toEqual(pathTo([...trunk, ...a, ...b], "Bf1"));
	expect(head.doc.view?.head).toBe("Bf1");
	// A leaf on the other branch.
	const other = ask(cache, file, [file], { kind: "tail", leaf: "Af2" });
	expect(other.ids).toEqual(pathTo([...trunk, ...a, ...b], "Af2"));
	expect(other.doc.view?.leaf).toBe("Af2");
	expect(other.doc.view?.head).toBe("Bf1");
	// Around an entry on the path to the head: the head. Around one that is not: the newest entry under it.
	expect(ask(cache, file, [file], { kind: "around", at: "tu1", limit: 20 }).doc.view?.leaf).toBe("Bf1");
	const onA = ask(cache, file, [file], { kind: "around", at: "Au1", limit: 20 });
	expect(onA.doc.view?.leaf).toBe("Af2");
	expect(onA.ids).toContain("Au1");
	expect(onA.ids).not.toContain("Bu0");
	// A leaf that is not under the entry is not the leaf of the window: the default is.
	expect(ask(cache, file, [file], { kind: "around", at: "Au1", leaf: "Bf1", limit: 20 }).doc.view?.leaf).toBe("Af2");
	// A leaf under it is.
	expect(ask(cache, file, [file], { kind: "around", at: "Au0", leaf: "Af1", limit: 20 }).doc.view?.leaf).toBe("Af1");
	// After an entry, towards a leaf on one branch or the other.
	expect(ask(cache, file, [file], { kind: "after", at: "tf1", leaf: "Af2", limit: 4 }).ids[0]).toBe("Au0");
	expect(ask(cache, file, [file], { kind: "after", at: "tf1", limit: 4 }).ids[0]).toBe("Bu0");
	// An entry that is not above the leaf has nothing after it on the way there.
	expect(ask(cache, file, [file], { kind: "after", at: "Au1", leaf: "Bf1" }).ids).toEqual([]);
});

test("a malformed line in a path is left out of the window, as the whole file's answer leaves it out", () => {
	const d = dir();
	const entries = turns(2);
	const good = entries.map((e) => JSON.stringify(e));
	// Ends like an entry, is not one: the index takes it for an entry, the window finds out.
	const bad = `{"type":"message","id":"a1_0","parentId":"u1","timestamp":"2026-01-20T10:00:00.000Z","message":{"role":"assistant","content":[}`;
	const lines = [...good.slice(0, 5), bad, ...good.slice(6)];
	const file = writeSession(d, "malformed", lines);
	const cache = new IndexCache();
	const window = ask(cache, file, [file], { kind: "tail" });
	expect(window.ids).toEqual(entries.map((e) => e.id).filter((id) => id !== "a1_0"));
	expect(window.own.entries).toEqual(parseSessionText(readFileSync(file, "utf8")).entries);
});

test("a file rewritten while a window is made is read again, not answered from the lines that moved", () => {
	const d = dir();
	const entries = turns(3);
	const file = writeSession(d, "rewrite", entries);
	class Rewriting extends IndexCache {
		rewritten = false;
		override get(path: string): FileIndex {
			const index = super.get(path);
			if (!this.rewritten) {
				this.rewritten = true;
				// Another process puts a long entry first: every line the index placed is somewhere else now.
				const before = readFileSync(path, "utf8");
				writeFileSync(
					path,
					before.replace(
						'"type":"message"',
						`"type":"label","id":"pad","parentId":null,"pad":"${"x".repeat(900)}"}\n{"type":"message"`,
					),
				);
			}
			return index;
		}
	}
	const cache = new Rewriting();
	const answered = ask(cache, file, [file], { kind: "tail" });
	expect(answered.ids.at(-1)).toBe("f2");
	// The entries as the file has them now, however the lines moved.
	expect(answered.ids).toEqual(entries.map((e) => e.id));
	expect(answered.own.entries).toEqual(JSON.parse(JSON.stringify(entries)));
});

// ------------------------------------------------------------------ the family: members, versions

test("every member of the family has what a list needs, and only the viewed one has entries", () => {
	const d = dir();
	const f = seedFixtures(d);
	const cache = new IndexCache();
	const a = ask(cache, f.alpha, [f.alpha, f.beta], { kind: "tail" });
	expect(a.doc.file).toBe(f.alpha);
	expect(a.doc.members.map((m) => m.file)).toEqual([f.alpha, f.beta]);
	const [alpha, beta] = a.doc.members;
	expect(alpha).toMatchObject({
		head: "f0000007",
		total: 7,
		lastPrompt: "And what about quokka mode?",
		tag: "t",
		subagents: [],
		advisors: [],
	});
	expect(beta).toMatchObject({ head: "f0000015", total: 5, lastPrompt: "And what about wombat routing?", entries: [] });
	expect(a.doc.members.map((m) => (m as SessionFileData).header)).toMatchObject([
		{ type: "session", title: FIXTURE.alphaTitle },
		{ parentSession: f.alpha, title: FIXTURE.betaTitle },
	]);
	expect(a.ids).toEqual(["f0000001", "f0000002", "f0000003", "f0000004", "f0000005", "f0000006", "f0000007"]);
	// The same view of the fork: its own path, and the conversation it was made from has none of it.
	const b = ask(cache, f.beta, [f.alpha, f.beta], { kind: "tail" });
	expect(b.ids).toEqual(["f0000001", "f0000002", "f0000003", "f0000014", "f0000015"]);
	expect(b.doc.members[0]).toMatchObject({ entries: [], head: "f0000007" });
	// A file with no prompt has none to show; and the last prompt is cut where a list would cut it.
	const e = writeSession(d, "no-prompt", [assistant("x", null, 0, { text: "alone" })]);
	expect(ask(cache, e, [e], { kind: "tail" }).own.lastPrompt).toBe("");
	const long = writeSession(d, "long-prompt", [user("p", null, 0, `${"é".repeat(399)}😀 and more`)]);
	const lastPrompt = ask(cache, long, [long], { kind: "tail" }).own.lastPrompt as string;
	expect(lastPrompt.length).toBeLessThanOrEqual(400);
	expect(lastPrompt).toBe("é".repeat(399));
});

test("the other versions of the entries of a window are those that share a parent with them in any file of the family", () => {
	const d = dir();
	const f = seedFixtures(d);
	const cache = new IndexCache();
	const a = ask(cache, f.alpha, [f.alpha, f.beta], { kind: "tail" });
	// Alpha goes on from f0000003 with f0000004, the fork with f0000014.
	expect(a.doc.view?.versions).toHaveLength(1);
	const [group] = a.doc.view?.versions ?? [];
	expect(group?.parent).toBe("f0000003");
	expect(group?.entries.map((e) => e.id)).toEqual(["f0000014"]);
	expect(group?.entries[0]).toEqual(
		JSON.parse(
			readFileSync(f.beta, "utf8")
				.split("\n")
				.find((l) => l.includes('"f0000014"') && l.includes("message")) as string,
		),
	);
	expect(group?.leads).toEqual({
		f0000004: { leaf: "f0000007", files: [f.alpha] },
		f0000014: { leaf: "f0000015", files: [f.beta] },
	});
	// From the fork it is the other way round.
	const b = ask(cache, f.beta, [f.alpha, f.beta], { kind: "tail" });
	expect(b.doc.view?.versions[0]?.entries.map((e) => e.id)).toEqual(["f0000004"]);
	expect(Object.keys(b.doc.view?.versions[0]?.leads ?? {}).sort()).toEqual(["f0000004", "f0000014"]);
	// Asked of the conversation alone, there is nothing to choose between.
	expect(ask(cache, f.alpha, [f.alpha], { kind: "tail" }).doc.view?.versions).toEqual([]);
});

test("the roots of a file that holds two are versions of each other, and the entries of a path that is on its own have none", () => {
	const d = dir();
	const f = seedFixtures(d);
	const cache = new IndexCache();
	const gamma = ask(cache, f.gamma, [f.gamma], { kind: "tail" });
	expect(gamma.ids[0]).toBe("f0000021");
	expect(gamma.doc.view?.versions).toHaveLength(1);
	expect(gamma.doc.view?.versions[0]?.parent).toBeNull();
	expect(gamma.doc.view?.versions[0]?.entries.map((e) => e.id)).toEqual(["f0000027"]);
	expect(gamma.doc.view?.versions[0]?.leads).toEqual({
		f0000027: { leaf: "f0000028", files: [f.gamma] },
		f0000021: { leaf: "f0000025", files: [f.gamma] },
	});
	// A window that holds neither of them has no group of that parent.
	expect(ask(cache, f.gamma, [f.gamma], { kind: "after", at: "f0000021" }).doc.view?.versions).toEqual([]);
});

test("a version leads to the newest entry under it, the one written last among equals, and the files that hold that entry", () => {
	const d = dir();
	const stamp = "2026-01-20T10:00:00.000Z";
	const e = (id: string, parent: string | null, t = stamp): SessionEntry =>
		({ type: "label", id, parentId: parent, timestamp: t }) as SessionEntry;
	// root → x; x → y1 → z1 and x → y2 → z2 (z1 and z2 at one time: z2 was written after).
	const base = [
		e("root", null),
		e("x", "root"),
		e("y1", "x"),
		e("z1", "y1", "2026-01-20T10:05:00.000Z"),
		e("y2", "x"),
		e("z2", "y2", "2026-01-20T10:05:00.000Z"),
	];
	const one = writeSession(d, "one", base);
	// A fork copies the path and adds an entry under y1 that is newer than every other.
	const two = writeSession(
		d,
		"two",
		[e("root", null), e("x", "root"), e("y1", "x"), e("w1", "y1", "2026-01-20T10:09:00.000Z")],
		{ parentSession: one },
	);
	const cache = new IndexCache();
	const answered = ask(cache, one, [one, two], { kind: "tail", leaf: "y1" });
	const group = answered.doc.view?.versions.find((g) => g.parent === "x");
	expect(group?.entries.map((x) => x.id)).toEqual(["y2"]);
	// y1: under it in the first file is z1, in the fork w1, which is newer; y2: z2.
	expect(group?.leads).toEqual({ y1: { leaf: "w1", files: [two] }, y2: { leaf: "z2", files: [one] } });
	// Under equal timestamps, the one written last (the later in the file; the later file between files) is the newest.
	const tie = writeSession(d, "tie", [e("r", null), e("m", "r"), e("n1", "m"), e("n2", "m")]);
	const t = ask(cache, tie, [tie], { kind: "tail", leaf: "n1" });
	expect(t.doc.view?.versions[0]?.leads).toEqual({
		n1: { leaf: "n1", files: [tie] },
		n2: { leaf: "n2", files: [tie] },
	});
	// An entry that several files hold is led to in each of them.
	const copy = writeSession(d, "copy", [e("r", null), e("m", "r"), e("n1", "m"), e("n3", "m")], { parentSession: tie });
	const shared = ask(cache, tie, [tie, copy], { kind: "tail", leaf: "n1" });
	expect(shared.doc.view?.versions[0]?.leads.n1).toEqual({ leaf: "n1", files: [tie, copy] });
	expect(shared.doc.view?.versions[0]?.entries.map((x) => x.id)).toEqual(["n2", "n3"]);

	// Two files that lead on from one entry to entries of one time: the file written later is where it leads.
	const t0 = "2026-01-20T10:03:00.000Z";
	const first = writeSession(d, "lead-first", [e("r", null), e("c", "r"), e("x", "c", t0), e("c2", "r")]);
	const second = writeSession(d, "lead-second", [e("r", null), e("c", "r"), e("y", "c", t0)], { parentSession: first });
	const parting = ask(cache, first, [first, second], { kind: "tail", leaf: "c" });
	expect(parting.doc.view?.versions[0]?.leads.c).toEqual({ leaf: "y", files: [second] });
	// In one file, the entry written last among equals is the newest under its parent.
	const twins = writeSession(d, "lead-twins", [
		e("r", null),
		e("c", "r"),
		e("x1", "c", t0),
		e("x2", "c", t0),
		e("c2", "r"),
	]);
	expect(ask(cache, twins, [twins], { kind: "tail", leaf: "c" }).doc.view?.versions[0]?.leads.c).toEqual({
		leaf: "x2",
		files: [twins],
	});
});

test("a group lists at most fifty versions, the one of the window among them, and a window at most five hundred groups", () => {
	const d = dir();
	const stamp = "2026-01-20T10:00:00.000Z";
	const e = (id: string, parent: string | null): SessionEntry =>
		({ type: "label", id, parentId: parent, timestamp: stamp }) as SessionEntry;
	const many = [e("root", null)];
	for (let i = 0; i < 80; i++) many.push(e(`c${String(i).padStart(2, "0")}`, "root"));
	const file = writeSession(d, "many", many);
	const cache = new IndexCache();
	const early = ask(cache, file, [file], { kind: "tail", leaf: "c03" });
	expect(Object.keys(early.doc.view?.versions[0]?.leads ?? {})).toHaveLength(50);
	expect(early.doc.view?.versions[0]?.entries).toHaveLength(49);
	// Written late among eighty: the window's own is among the fifty.
	const late = ask(cache, file, [file], { kind: "tail", leaf: "c79" });
	expect(Object.keys(late.doc.view?.versions[0]?.leads ?? {})).toContain("c79");
	expect(Object.keys(late.doc.view?.versions[0]?.leads ?? {})).toHaveLength(50);

	// A path in which every entry has a sibling: 700 entries, a group for each of the first five hundred.
	const path: SessionEntry[] = [];
	let parent: string | null = null;
	for (let i = 0; i < 700; i++) {
		path.push(e(`p${i}`, parent), e(`q${i}`, parent));
		parent = `p${i}`;
	}
	const comb = writeSession(d, "comb", path);
	const groups = ask(cache, comb, [comb], { kind: "tail", leaf: "p699", limit: 200 });
	expect(groups.ids.length).toBeLessThanOrEqual(200);
	expect(groups.doc.view?.versions.length).toBe(groups.ids.length);
	expect(groups.doc.view?.versions.length).toBeLessThanOrEqual(500);
});

// ------------------------------------------------------------------ what the path above a window leaves

test("the path above a window leaves the last mode, thinking level and default model it was set to, oldest first", () => {
	const d = dir();
	const stamp = (n: number) => `2026-01-20T10:00:${String(n).padStart(2, "0")}.000Z`;
	const meta = (type: string, id: string, parent: string | null, n: number, extra: object) =>
		({ type, id, parentId: parent, timestamp: stamp(n), ...extra }) as SessionEntry;
	const lead: SessionEntry[] = [
		meta("model_change", "m1", null, 0, { model: "anthropic/old" }),
		meta("mode_change", "d1", "m1", 1, { mode: "plan" }),
		meta("thinking_level_change", "t1", "d1", 2, { thinkingLevel: "low" }),
		meta("mode_change", "d2", "t1", 3, { mode: "act" }),
		meta("model_change", "m2", "d2", 4, { model: "anthropic/new" }),
		// Not the default role, and a default one without a model: neither is what the conversation resumes with.
		meta("model_change", "m3", "m2", 5, { model: "openai/other", role: "smol" }),
		meta("model_change", "m4", "m3", 6, { role: "default" }),
		meta("thinking_level_change", "t2", "m4", 7, { thinkingLevel: "high" }),
	];
	const entries = [...lead, ...turns(3, { parent: "t2", at: 10 })];
	const file = writeSession(d, "carry", entries);
	const cache = new IndexCache();
	const window = ask(cache, file, [file], { kind: "tail", limit: 4 });
	expect(window.ids[0]).toBe("u2");
	expect(window.doc.view?.above?.carry.map((e) => e.id)).toEqual(["d2", "m2", "t2"]);
	expect(window.doc.view?.above?.carry[1]).toEqual(lead[4]);
	// With the whole path in the window there is nothing above it.
	expect(ask(cache, file, [file], { kind: "tail" }).doc.view?.above?.carry).toEqual([]);
	// `after` windows do not carry what is above.
	expect(ask(cache, file, [file], { kind: "after", at: "u0", limit: 4 }).doc.view?.above).toBeUndefined();
});

test("with no default model set above the window, the model is the last assistant message's, as a stub", () => {
	const d = dir();
	// The last assistant message above the window has no provider or model: the one before it speaks.
	const noModel = assistant("nm", "u1", 3, { text: "no model recorded" });
	noModel.message = { role: "assistant", content: [] };
	const lead = [
		user("u0", null, 0, "ask"),
		assistant("a0", "u0", 1, { text: "answer" }),
		user("u1", "a0", 2, "again"),
		noModel,
	];
	const file = writeSession(d, "stub", [...lead, ...turns(1, { prefix: "k", parent: "nm", at: 50 })]);
	const cache = new IndexCache();
	const window = ask(cache, file, [file], { kind: "tail", limit: 4 });
	expect(window.ids).toEqual(["ku0", "ka0_0", "kr0_0", "kf0"]);
	const stub = window.doc.view?.above?.carry.at(-1) as SessionEntry & { message: Record<string, unknown> };
	expect(window.doc.view?.above?.carry).toHaveLength(1);
	expect(stub).toMatchObject({
		type: "message",
		message: { role: "assistant", provider: "anthropic", model: "claude-haiku-5-5" },
	});
	expect(stub.id).toBe("a0");
	expect(stub.parentId).toBe("u0");
	expect(Object.keys(stub.message).sort()).toEqual(["model", "provider", "role"]);
	// A default model above makes the stub unnecessary.
	const withModel = writeSession(d, "stub-model", [
		{
			type: "model_change",
			id: "mm",
			parentId: null,
			timestamp: "2026-01-20T10:00:00.000Z",
			model: "anthropic/x",
		} as SessionEntry,
		...turns(3, { parent: "mm" }),
	]);
	const m = ask(cache, withModel, [withModel], { kind: "tail", limit: 4 });
	expect(m.doc.view?.above?.carry.map((c) => c.id)).toEqual(["mm"]);
});

test("a window of the end of a path or around an entry says what the whole path to its leaf leaves, which the windows below it do not", () => {
	const d = dir();
	const stamp = (n: number) => `2026-01-20T10:00:${String(n).padStart(2, "0")}.000Z`;
	const meta = (type: string, id: string, parent: string | null, n: number, extra: object) =>
		({ type, id, parentId: parent, timestamp: stamp(n), ...extra }) as SessionEntry;
	const lead: SessionEntry[] = [
		meta("model_change", "m1", null, 0, { model: "anthropic/old" }),
		meta("thinking_level_change", "t1", "m1", 1, { thinkingLevel: "low" }),
		meta("mode_change", "d1", "t1", 2, { mode: "goal" }),
	];
	// The model and the thinking level change late in the conversation, after a hundred entries the windows below do not reach.
	const body = turns(4, { parent: "d1", at: 10 });
	const last = body.at(-1) as SessionEntry;
	const late: SessionEntry[] = [
		meta("model_change", "m2", last.id, 80, { model: "anthropic/late" }),
		meta("thinking_level_change", "t2", "m2", 81, { thinkingLevel: "high" }),
	];
	const file = writeSession(d, "end", [...lead, ...body, ...late]);
	const cache = new IndexCache();
	const carryOf = (req: Parameters<typeof ask>[3]) =>
		ask(cache, file, [file], req).doc.view?.end?.carry.map((e) => e.id);
	// The end of the path, a window that is nowhere near it, and a window of a file's branch asked for by its leaf.
	expect(carryOf({ kind: "tail", limit: 4 })).toEqual(["d1", "m2", "t2"]);
	expect(carryOf({ kind: "around", at: "u0", limit: 8 })).toEqual(["d1", "m2", "t2"]);
	expect(ask(cache, file, [file], { kind: "around", at: "u0", limit: 8 }).doc.view?.later).toBe(true);
	expect(carryOf({ kind: "tail", leaf: last.id, limit: 4 })).toEqual(["m1", "t1", "d1"]);
	// A branch that is not the file's last entry also says what the file's last entry leaves, which is what omp resumes with.
	const headEndOf = (req: Parameters<typeof ask>[3]) =>
		ask(cache, file, [file], req).doc.view?.headEnd?.carry.map((e) => e.id);
	expect(headEndOf({ kind: "tail", leaf: last.id, limit: 4 })).toEqual(["d1", "m2", "t2"]);
	expect(headEndOf({ kind: "around", at: "u0", leaf: last.id, limit: 8 })).toEqual(["d1", "m2", "t2"]);
	// The path to the file's last entry has nothing to add to what it says.
	expect(headEndOf({ kind: "tail", limit: 4 })).toBeUndefined();
	expect(headEndOf({ kind: "around", at: "u0", limit: 8 })).toBeUndefined();
	// Nothing is set along the path: the model of its last assistant message speaks, as it does for the path above a window.
	const plain = writeSession(d, "end-plain", turns(2));
	const stub = ask(cache, plain, [plain], { kind: "tail", limit: 4 }).doc.view?.end?.carry ?? [];
	expect(stub).toHaveLength(1);
	expect(stub[0]).toMatchObject({
		type: "message",
		message: { role: "assistant", provider: "anthropic", model: "claude-haiku-5-5" },
	});
	// A window below another or above it is the page's to join: what the path leaves is not asked of it.
	expect(ask(cache, file, [file], { kind: "after", at: "u0", limit: 4 }).doc.view?.end).toBeUndefined();
	expect(ask(cache, file, [file], { kind: "before", at: last.id, limit: 4 }).doc.view?.end).toBeUndefined();
});

test("the prompts above a window are those the page recalls: the user's and their commands, a repeat in a row once, the newest hundred", () => {
	const d = dir();
	const stampOf = (n: number) =>
		`2026-01-20T10:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z`;
	const path: SessionEntry[] = [];
	let parent: string | null = null;
	const push = (e: SessionEntry) => {
		path.push(e);
		parent = e.id;
	};
	let n = 0;
	const say = (id: string, text: string, extra: object = {}) =>
		push({
			...entry(id, parent, n++, { role: "user", content: [{ type: "text", text }], attribution: "user", ...extra }),
			timestamp: stampOf(n),
		});
	const reply = (id: string) => push({ ...assistant(id, parent, n++, { text: "ok" }), timestamp: stampOf(n) });
	// Prompts, a repeat in a row, an empty one, the agent's own reminder, a command, a prompt of text in several blocks, and more than a hundred.
	say("p0", "first");
	reply("r0");
	say("p1", "first");
	reply("r1");
	say("p2", "   ");
	say("p3", "reminder", { attribution: "agent" });
	push({
		...entry("b0", parent, n++, { role: "bashExecution", command: "ls -la", output: "x", exitCode: 0 }),
		timestamp: stampOf(n),
	});
	say("p4", "  padded  ");
	push({
		...entry("p5", parent, n++, {
			role: "user",
			content: [
				{ type: "text", text: "one" },
				{ type: "image", data: "abc", mimeType: "image/png" },
				{ type: "thinking", thinking: "narrated", narration: true },
				{ type: "thinking", thinking: "private" },
				{ type: "text", text: 5 },
			],
			attribution: "user",
		}),
		timestamp: stampOf(n),
	});
	for (let i = 0; i < 130; i++) {
		say(`q${i}`, `question ${i}`);
		reply(`s${i}`);
	}
	const file = writeSession(d, "prompts", path);
	const cache = new IndexCache();
	const window = ask(cache, file, [file], { kind: "tail", limit: 6 });
	expect(window.ids[0]).toMatch(/^q12\d$/);
	const above = window.doc.view?.above?.prompts ?? [];
	const first = path.findIndex((e) => e.id === window.ids[0]);
	expect(above).toEqual(promptsOf(path.slice(0, first)).slice(-100));
	expect(above).toHaveLength(100);
	expect(above.at(-1)).toBe(`question ${Number(window.ids[0]?.slice(1)) - 1}`);

	// Where the path above is short, all of it: the repeat counts once, and the rest is as the page reads it.
	const short = ask(cache, file, [file], { kind: "before", at: "q0", limit: 20 });
	expect(short.doc.view?.above?.prompts).toEqual(
		promptsOf(
			path.slice(
				0,
				path.findIndex((e) => e.id === short.ids[0]),
			),
		),
	);
	const everything = ask(cache, file, [file], { kind: "before", at: "q30", limit: 200 });
	expect(everything.ids).toContain("p0");
	expect(everything.doc.view?.above?.prompts).toEqual([]);
	const upToBash = ask(cache, file, [file], { kind: "before", at: "p4" });
	expect(upToBash.doc.view?.above?.prompts).toEqual([]);
	// What the page recalls of everything above a window that begins after the unusual ones: a repeat in a row once, the
	// empty and the agent's own left out, a command with its `!`, the words of the blocks the page reads.
	const afterThem = ask(cache, file, [file], { kind: "tail", leaf: "s0", limit: 2 });
	expect(afterThem.ids).toEqual(["q0", "s0"]);
	expect(afterThem.doc.view?.above?.prompts).toEqual(["first", "!ls -la", "padded", "one\nnarrated"]);
	expect(afterThem.doc.view?.above?.prompts).toEqual(
		promptsOf(
			path.slice(
				0,
				path.findIndex((e) => e.id === "q0"),
			),
		),
	);
});

// ------------------------------------------------------------------ the figures of the whole file

/** A conversation that has everything the figures are made of, and what they must not be made of. */
function figuresEntries(): SessionEntry[] {
	const at = (min: number, s = 0) => new Date(Date.UTC(2026, 0, 20, 10, min, s)).toISOString();
	const usage = (o: Record<string, unknown>) => o;
	const out: SessionEntry[] = [];
	let parent: string | null = null;
	const push = (e: SessionEntry) => {
		out.push(e);
		parent = e.id;
	};
	const msg = (id: string, ts: string, message: Record<string, unknown>) =>
		push({ type: "message", id, parentId: parent, timestamp: ts, message } as SessionEntry);
	msg("u0", at(0), { role: "user", content: "hello", attribution: "user", timestamp: Date.parse(at(0, 1)) });
	msg("a0", at(1), {
		role: "assistant",
		provider: "anthropic",
		model: "m1",
		content: [],
		usage: usage({ input: 10, output: 20, cacheRead: 5, cacheWrite: 1, totalTokens: 36, cost: { total: 0.01 } }),
	});
	// A turn that is no prompt's: the agent reminds itself.
	msg("r0", at(2), { role: "user", content: "remind", attribution: "agent", timestamp: Date.parse(at(2)) });
	msg("a1", at(3), {
		role: "assistant",
		provider: "anthropic",
		model: "m2",
		content: [],
		usage: usage({ input: 1, output: 2, cost: { total: 0.002 } }),
	});
	// A request omp made on the side (a judge): its model is in By model too (#687).
	push({
		type: "model_usage",
		id: "mu0",
		parentId: parent,
		timestamp: at(4),
		provider: "openai-codex",
		model: "judge",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { total: 0.5 } },
	} as SessionEntry);
	push({ type: "model_usage", id: "mu1", parentId: parent, timestamp: at(4, 5), usage: "garbage" } as SessionEntry);
	push({ type: "label", id: "l0", parentId: parent, timestamp: at(5) } as SessionEntry);
	// A command the user ran ends the turn and starts none.
	msg("b0", at(10), { role: "bashExecution", command: "ls", output: "x", exitCode: 0 });
	msg("a2", at(11), {
		role: "assistant",
		provider: "anthropic",
		model: "m1",
		content: [],
		usage: usage({ input: "7", output: Number.NaN, cacheRead: 3, totalTokens: 12, cost: { total: "free" } }),
	});
	// A prompt without a timestamp of its own takes the entry's; a developer's message counts as a prompt too.
	msg("u1", at(20), { role: "user", content: [{ type: "text", text: "again" }], attribution: "user" });
	msg("a3", at(21), {
		role: "assistant",
		content: [],
		usage: { input: 4, output: 4, totalTokens: 8, cost: { total: 0.004 } },
	});
	msg("t0", at(22), { role: "toolResult", toolCallId: "c", toolName: "bash", content: [], usage: { input: 999 } });
	// Written after a later one, with an earlier time: the turn lasts until the latest time in it, not the last.
	msg("a4", at(19, 30), { role: "assistant", provider: "anthropic", model: "m2", content: [], usage: [] });
	msg("d0", at(30), { role: "developer", content: "dev says", timestamp: Date.parse(at(30, 3)) });
	msg("a5", at(33), {
		role: "assistant",
		provider: "anthropic",
		model: "m3",
		content: [],
		usage: { input: 3, output: 3, cacheWrite: 2, cost: { total: 0.003 } },
	});
	// A prompt that starts the turn that is still open, which has seen later entries.
	msg("u2", at(40), { role: "user", content: "last", attribution: "user", timestamp: Date.parse(at(40, 10)) });
	msg("a6", at(41), {
		role: "assistant",
		provider: "anthropic",
		model: "m1",
		content: [],
		usage: { input: 2, output: 2, cost: { total: 0.002 } },
	});
	push({ type: "label", id: "l1", parentId: parent, timestamp: at(45) } as SessionEntry);
	return out;
}

/** What the page derives from the whole file's entries, in the form the server sends it. */
function whatThePageSums(text: string) {
	const entries = parseSessionText(text).entries;
	return {
		through: entries.at(-1)?.id ?? null,
		usage: sumEntries(entries),
		byModel: usageByModel(entries),
		activeMs: activeMs(entries),
	};
}

function figuresOf(stats: {
	usage: unknown;
	byModel: unknown;
	clock: { total: number; start: number | null; end: number };
	through: string | null;
}) {
	const { clock } = stats;
	return {
		through: stats.through,
		usage: stats.usage,
		byModel: stats.byModel,
		activeMs: clock.total + (clock.start !== null ? clock.end - clock.start : 0),
	};
}

test("the figures of a file are those the page adds up from its entries: usage, by model, and the time worked", () => {
	const d = dir();
	const file = writeSession(d, "figures", figuresEntries(), { title: "Figures" });
	const cache = new IndexCache();
	const stats = askStats(cache, file);
	expect(stats.file).toBe(file);
	const expected = whatThePageSums(readFileSync(file, "utf8"));
	expect(figuresOf(stats.stats)).toEqual(expected);
	expect(stats.stats.through).toBe("l1");
	// Not a figure of zero: the file does have all of it.
	expect(expected.usage.cost).toBeGreaterThan(0.5);
	expect(expected.byModel.length).toBeGreaterThanOrEqual(3);
	expect(expected.byModel.find(([m]) => m === "openai-codex/judge")?.[1]).toEqual({ tokens: 150, cost: 0.5, n: 1 });
	expect(expected.activeMs).toBeGreaterThan(0);
	// Asked again, from the figures kept.
	expect(figuresOf(askStats(cache, file).stats)).toEqual(expected);
});

test("the figures of a file that grows go on from the entry they stopped at, and equal the page's for the whole file", () => {
	const d = dir();
	const entries = figuresEntries();
	const file = writeSession(d, "figures-grow", entries.slice(0, 9));
	const cache = new IndexCache();
	const early = askStats(cache, file);
	expect(early.stats.through).toBe("a2");
	expect(figuresOf(early.stats)).toEqual(whatThePageSums(readFileSync(file, "utf8")));
	const index = cache.get(file);
	expect(index.stats?.folded).toBe(9);

	appendFileSync(
		file,
		`${entries
			.slice(9)
			.map((e) => JSON.stringify(e))
			.join("\n")}\n`,
	);
	const later = askStats(cache, file);
	expect(cache.get(file)).toBe(index);
	expect(index.stats?.folded).toBe(entries.length);
	expect(later.stats.through).toBe("l1");
	expect(figuresOf(later.stats)).toEqual(whatThePageSums(readFileSync(file, "utf8")));
});

test("the figures of a long conversation made of the turns the page shows are the page's, and an empty file has none", () => {
	const d = dir();
	const entries = turns(25, { steps: 2 });
	const file = writeSession(d, "figures-turns", entries);
	const cache = new IndexCache();
	expect(figuresOf(askStats(cache, file).stats)).toEqual(whatThePageSums(readFileSync(file, "utf8")));
	const empty = writeSession(d, "figures-empty", []);
	const none = askStats(cache, empty).stats;
	expect(none).toEqual({
		through: null,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		byModel: [],
		clock: { total: 0, start: null, end: 0 },
	});
	const window = ask(cache, empty, [empty], { kind: "tail" });
	expect(window.ids).toEqual([]);
	expect(window.doc.view).toMatchObject({ leaf: null, head: null, earlier: false, later: false, versions: [] });
});

// ------------------------------------------------------------------ the request

test("a request names a view, and the parts it needs; anything else is refused", () => {
	const parse = (q: string) => parseViewRequest(new URLSearchParams(q));
	expect(parse("file=x")).toEqual({ ok: true, view: undefined });
	expect(parse("view=tail")).toEqual({ ok: true, view: { kind: "tail" } });
	expect(parse("view=tail&leaf=abc&limit=7")).toEqual({ ok: true, view: { kind: "tail", leaf: "abc", limit: 7 } });
	expect(parse("view=before&at=e1")).toEqual({ ok: true, view: { kind: "before", at: "e1" } });
	expect(parse("view=after&at=e1&leaf=e9")).toEqual({ ok: true, view: { kind: "after", at: "e1", leaf: "e9" } });
	expect(parse("view=around&at=e1&limit=3.9")).toEqual({ ok: true, view: { kind: "around", at: "e1", limit: 3 } });
	expect(parse("view=stats&at=e1&limit=3")).toEqual({ ok: true, view: { kind: "stats" } });
	// A limit the server's own budget does not go beyond is none.
	expect(parse("view=tail&limit=500")).toEqual({ ok: true, view: { kind: "tail" } });
	expect(parse("view=tail&limit=0")).toEqual({ ok: true, view: { kind: "tail", limit: 1 } });
	expect(parse("view=nope")).toMatchObject({ ok: false });
	expect(parse("view=before")).toMatchObject({ ok: false });
	expect(parse("view=after&at=")).toMatchObject({ ok: false });
	expect(parse("view=around&leaf=e1")).toMatchObject({ ok: false });
	expect(parse("view=tail&limit=many")).toMatchObject({ ok: false });
});
