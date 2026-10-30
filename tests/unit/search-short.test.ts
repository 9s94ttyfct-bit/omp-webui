import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../server/sessions/store.ts";

/**
 * The search palette marks what matched in each hit, and does it for a query of any length. Trigram full-text search
 * needs 3 characters, so a 1-2 character query (the usual Chinese word, `斑马`, or `ze`) is a substring scan, whose
 * snippets used to carry no markers and no `…` where the text was cut (#299).
 */

const OPEN = "\u0002";
const CLOSE = "\u0003";
const root = mkdtempSync(join(tmpdir(), "ompw-search-short-"));
const bucket = join(root, "sessions", "-tmp-short");
let store: SessionStore;

function writeSession(n: number, messages: [role: string, text: string][]): void {
	const id = `01a00000-0000-7000-8000-00000000${n.toString(16).padStart(4, "0")}`;
	const stamp = new Date(Date.UTC(2026, 0, 7, 0, n)).toISOString();
	const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: stamp, cwd: "/tmp/short" }];
	messages.forEach(([role, text], i) => {
		lines.push({
			type: "message",
			id: `m${n}-${i}`,
			parentId: i ? `m${n}-${i - 1}` : null,
			timestamp: stamp,
			message: { role, content: [{ type: "text", text }] },
		});
	});
	writeFileSync(
		join(bucket, `2026-01-07T00-00-00-000Z_${id}.jsonl`),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
}

const LONG_TAIL = "字".repeat(300);

beforeAll(async () => {
	mkdirSync(bucket, { recursive: true });
	writeSession(1, [
		["user", "请解释斑马协议的数据包结构，并给出示例。"],
		["assistant", `斑马协议使用条纹数据包。${LONG_TAIL}示例：斑马协议的头部包含标志位。`],
	]);
	writeSession(2, [
		["user", "Explain the Zebra protocol, zebra stripes and ZEBRA crossings"],
		["assistant", `${"x".repeat(200)} the zebra protocol ${"y".repeat(200)}`],
	]);
	store = new SessionStore(join(root, "sessions"), join(root, "index.db"));
	await store.indexed();
});
afterAll(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

/** The pieces of a snippet inside markers, and what is left with the markers taken out. */
function parts(snippet: string): { marked: string[]; plain: string } {
	const marked = [...snippet.matchAll(new RegExp(`${OPEN}([^${CLOSE}]*)${CLOSE}`, "g"))].map((m) => m[1] ?? "");
	return { marked, plain: snippet.replaceAll(OPEN, "").replaceAll(CLOSE, "") };
}

// Chinese, one and two characters: what the issue measured, and a longer word as the reference.
for (const query of ["斑", "斑马", "示例", "协议", "斑马协议"]) {
	test(`${query}: every hit marks the match`, async () => {
		const hits = await store.search(query);
		expect(hits.length).toBeGreaterThan(0);
		for (const h of hits) {
			const { marked } = parts(h.snippet);
			expect(marked.length, JSON.stringify(h.snippet)).toBeGreaterThan(0);
			for (const m of marked) expect(m, JSON.stringify(h.snippet)).toBe(query);
		}
	});
}

for (const query of ["z", "ze", "ZE", "zebra"]) {
	test(`${query}: every hit marks each match in the snippet in the case it is written, whatever the query's case`, async () => {
		const hits = await store.search(query);
		expect(hits.length).toBeGreaterThan(0);
		for (const h of hits) {
			const { marked } = parts(h.snippet);
			expect(marked.length, JSON.stringify(h.snippet)).toBeGreaterThan(0);
			for (const m of marked) expect(m.toLowerCase(), JSON.stringify(h.snippet)).toBe(query.toLowerCase());
		}
	});
}

test("a short query's snippet shows … where the text is cut, as a longer query's does", async () => {
	const [cut] = (await store.search("示例")).filter((h) => h.role === "assistant");
	expect(cut?.snippet.startsWith("…")).toBe(true);
	// The match is near the end of the message, so nothing follows it to cut.
	expect(cut?.snippet.endsWith("…")).toBe(false);
	const [front] = (await store.search("条纹")).filter((h) => h.role === "assistant");
	expect(front?.snippet.startsWith("…")).toBe(false);
	const [short] = (await store.search("斑马")).filter((h) => h.role === "user");
	expect(parts(short?.snippet ?? "").plain).toBe("请解释斑马协议的数据包结构，并给出示例。");
	// A match in the middle of a long text is cut on both sides.
	const [middle] = (await store.search("ro")).filter((h) => h.role === "assistant");
	expect(middle?.snippet.startsWith("…") && middle.snippet.endsWith("…")).toBe(true);
	expect(parts(middle?.snippet ?? "").marked).toEqual(["ro"]);
});

test("a short query's hits are the same conversations and messages a longer one finds", async () => {
	const entries = async (q: string) => (await store.search(q)).map((h) => `${h.file}#${h.entryId}`).sort();
	expect(await entries("斑马")).toEqual(await entries("斑马协议"));
	expect(await entries("ze")).toEqual(await entries("zebra"));
});
