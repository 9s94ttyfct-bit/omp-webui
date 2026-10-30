import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../server/sessions/store.ts";

/**
 * The sidebar's search by what was said (#717): every word of the query in one message, in any order, and one hit a
 * conversation so that `limit` counts conversations. The palette's phrase search stays as it was.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-search-words-"));
const bucket = join(root, "sessions", "-tmp-words");
let store: SessionStore;
const files = new Map<number, string>();

function writeSession(n: number, messages: [role: string, text: string][]): void {
	const id = `01a00000-0000-7000-8000-00000000${n.toString(16).padStart(4, "0")}`;
	const stamp = new Date(Date.UTC(2026, 0, 7, 0, n)).toISOString();
	const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: stamp, cwd: "/tmp/words" }];
	messages.forEach(([role, text], i) => {
		lines.push({
			type: "message",
			id: `m${n}-${i}`,
			parentId: i ? `m${n}-${i - 1}` : null,
			timestamp: stamp,
			message: { role, content: [{ type: "text", text }] },
		});
	});
	const file = join(bucket, `2026-01-07T00-00-00-000Z_${id}.jsonl`);
	files.set(n, file);
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

beforeAll(async () => {
	mkdirSync(bucket, { recursive: true });
	// Both words, the other way round from the query.
	writeSession(1, [
		["user", "hello"],
		["assistant", "the walrus sat on the harbour wall"],
	]);
	// Both words, but never in one message.
	writeSession(2, [
		["user", "a harbour at dawn"],
		["assistant", "no walrus was seen"],
	]);
	// Both words in two messages.
	writeSession(3, [
		["user", "harbour walrus census"],
		["assistant", "the walrus count in the harbour rose"],
	]);
	store = new SessionStore(join(root, "sessions"), join(root, "index.db"));
	await store.indexed();
});
afterAll(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

const filesOf = (hits: { file: string }[]) => new Set(hits.map((h) => h.file));
const f = (n: number): string => files.get(n) as string;

test("every word in one message, in any order", async () => {
	const { hits } = await store.searchResult("harbour walrus", 50, undefined, { words: true });
	expect(filesOf(hits)).toEqual(new Set([f(1), f(3)]));
});

test("a phrase search still wants the words together, in order", async () => {
	const { hits } = await store.searchResult("harbour walrus", 50);
	expect(filesOf(hits)).toEqual(new Set([f(3)]));
});

test("a word under three characters still needs every word in one message", async () => {
	const { hits } = await store.searchResult("walrus wa", 50, undefined, { words: true });
	// `wa` is in "walrus" and "wall": every message with "walrus" has it, so this is the walrus messages' conversations.
	expect(filesOf(hits)).toEqual(new Set([f(1), f(2), f(3)]));
	const both = await store.searchResult("harbour wa", 50, undefined, { words: true });
	expect(filesOf(both.hits)).toEqual(new Set([f(1), f(3)]));
});

test("one hit a conversation: the limit counts conversations, and the rest are counted in `more`", async () => {
	const { hits } = await store.searchResult("harbour walrus", 50, undefined, { words: true, perConversation: 1 });
	expect(hits).toHaveLength(2);
	expect(hits.find((h) => h.file === f(3))?.more).toBe(1);
	const one = await store.searchResult("harbour walrus", 1, undefined, { words: true, perConversation: 1 });
	expect(one.hits).toHaveLength(1);
});

test("the snippet marks both words, not only the first", async () => {
	const { hits } = await store.searchResult("harbour walrus", 50, undefined, { words: true });
	const snippet = hits.find((h) => h.file === f(1))?.snippet ?? "";
	expect(snippet).toContain("\u0002walrus\u0003");
	expect(snippet.split("\u0002")).toHaveLength(3);
});
