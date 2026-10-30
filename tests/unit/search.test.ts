import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../server/sessions/store.ts";

const root = mkdtempSync(join(tmpdir(), "ompw-search-"));
const bucket = join(root, "sessions", "-tmp-search");
let store: SessionStore;
let busy: string;
let quiet: string;
let three: string;

/** A conversation of one user message per entry of `texts`. */
function writeSession(n: number, texts: string[]): string {
	const id = `01a00000-0000-7000-8000-00000000${n.toString(16).padStart(4, "0")}`;
	const file = join(bucket, `2026-01-07T00-00-00-000Z_${id}.jsonl`);
	const stamp = new Date(Date.UTC(2026, 0, 7, 0, n)).toISOString();
	const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: stamp, cwd: "/tmp/search" }];
	texts.forEach((text, i) => {
		lines.push({
			type: "message",
			id: `m${n}-${i}`,
			parentId: i ? `m${n}-${i - 1}` : null,
			timestamp: stamp,
			message: { role: "user", content: [{ type: "text", text }] },
		});
	});
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return file;
}

beforeAll(async () => {
	mkdirSync(bucket, { recursive: true });
	busy = writeSession(
		1,
		Array.from({ length: 120 }, (_, i) => `kumquat ${i} zz`),
	);
	quiet = writeSession(2, ["Summarize the orchard plan: irrigation, pruning and the kumquat harvest schedule."]);
	three = writeSession(3, ["kumquat one", "kumquat two", "kumquat three"]);
	store = new SessionStore(join(root, "sessions"), join(root, "index.db"));
	await store.indexed();
});
afterAll(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

const files = (hits: { file: string }[]) => [...new Set(hits.map((h) => h.file))];

for (const [label, word] of [
	["trigram query", "kumquat"],
	["2-character query", "ku"],
] as const) {
	test(`${label}: a busy conversation cannot hide a quiet one`, async () => {
		const hits = await store.search(word);
		const inBusy = hits.filter((h) => h.file === busy);
		expect(inBusy).toHaveLength(3);
		expect(inBusy.at(-1)?.more).toBe(117);
		expect(inBusy.slice(0, -1).every((h) => h.more === undefined)).toBe(true);
		const inQuiet = hits.filter((h) => h.file === quiet);
		expect(inQuiet).toHaveLength(1);
		expect(inQuiet[0]?.more).toBeUndefined();
		// Exactly three hits is not "more".
		const inThree = hits.filter((h) => h.file === three);
		expect(inThree).toHaveLength(3);
		expect(inThree.some((h) => h.more !== undefined)).toBe(false);
		expect(hits).toHaveLength(7);
	});

	test(`${label}: hits of one conversation are contiguous`, async () => {
		const hits = await store.search(word);
		const order = hits.map((h) => h.file);
		for (const f of files(hits)) {
			const first = order.indexOf(f);
			const last = order.lastIndexOf(f);
			expect(order.slice(first, last + 1).every((x) => x === f)).toBe(true);
		}
	});
}

test("conversations are ordered by their best hit", async () => {
	// The quiet conversation's text is far longer around the match, so the busy and three-hit ones rank first.
	const hits = await store.search("kumquat");
	expect(hits[0]?.file).not.toBe(quiet);
	expect(files(hits).at(-1)).toBe(quiet);
});

test("the file parameter returns that conversation uncapped, up to the limit", async () => {
	const all = await store.search("kumquat", 200, busy);
	expect(all).toHaveLength(120);
	expect(new Set(all.map((h) => h.file))).toEqual(new Set([busy]));
	expect(all.some((h) => h.more !== undefined)).toBe(false);
	expect(new Set(all.map((h) => h.entryId)).size).toBe(120);

	const some = await store.search("kumquat", 10, busy);
	expect(some).toHaveLength(10);
	expect(some.at(-1)?.more).toBe(110);
	expect(await store.search("ku", 200, busy)).toHaveLength(120);
});

test("the overall limit applies after the cap, and more counts what the limit cut", async () => {
	const hits = await store.search("kumquat", 5);
	expect(hits).toHaveLength(5);
	// The busy conversation ranks first with 3 hits; the second conversation is cut to 2 of its matches.
	const lastFile = hits.at(-1)?.file as string;
	const inLast = hits.filter((h) => h.file === lastFile);
	const total = lastFile === busy ? 120 : lastFile === three ? 3 : 1;
	expect(inLast.at(-1)?.more).toBe(total - inLast.length > 0 ? total - inLast.length : undefined);

	expect(await store.search("kumquat", 1)).toHaveLength(1);
});

test("limit is clamped to something sane", async () => {
	expect((await store.search("kumquat", Number.NaN)).length).toBe(7);
	expect((await store.search("kumquat", -4)).length).toBe(1);
	expect((await store.search("kumquat", 0)).length).toBe(1);
	expect((await store.search("kumquat", 1e9, busy)).length).toBe(120);
});
