import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "../../server/family.ts";
import { entryStart, memberPieces, PIECE_CHARS, rememberIds } from "../../server/family-document.ts";
import { parseSessionText } from "../../server/sessions/parse.ts";
import { writeBigSession } from "../support/big-session.ts";

/**
 * The JSON of one file of a family, as the pieces the worker writes to zlib: the same document `parseSessionText` reads
 * from the file, in pieces that stay small however long the conversation is.
 */

const STAMP = "2026-01-08T00:00:00.000Z";
const member: Job["members"][number] = { file: "/tmp/a.jsonl", tag: "a", subagents: [], advisors: [] };

/** What the pieces of one file add up to, as a page reads it. */
interface FileDocument {
	file: string;
	header: { id?: string } | null;
	entries: { id: string }[];
	order?: string[];
	tag?: string;
	subagents: unknown[];
	advisors: unknown[];
}

const line = (id: string, parentId: string | null, text: string) =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: STAMP,
		message: { role: "user", content: [{ type: "text", text }] },
	});
const header = JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: STAMP, cwd: "/work" });
const entryId = (i: number) => `e${String(i).padStart(6, "0")}`;

/** `count` entries of about `chars` characters each, with the session header first. */
function conversation(count: number, chars: number): string {
	const lines = [header];
	for (let i = 0; i < count; i++) lines.push(line(entryId(i), i === 0 ? null : entryId(i - 1), "x".repeat(chars)));
	return `${lines.join("\n")}\n`;
}

const pieces = (text: string, seen: Set<string> | null = null, tag: string | null = null) => [
	...memberPieces(member.file, text, seen, member, tag),
];
const document = (text: string, seen: Set<string> | null = null, tag: string | null = null): FileDocument => {
	const parsed: FileDocument = JSON.parse(pieces(text, seen, tag).join(""));
	return parsed;
};

test("the document of a file is the file's header and entries, with its subagents and advisors", () => {
	const text = conversation(5, 20);
	const parsed = parseSessionText(text);
	expect(document(text)).toEqual({
		file: member.file,
		header: parsed.header,
		entries: parsed.entries,
		subagents: [],
		advisors: [],
	});
});

test("the entries of a long file come in pieces of bounded size, not as one string", () => {
	// 4000 entries of about 1 KB: 4 MB of JSON, sixteen times a piece.
	const text = conversation(4000, 1000);
	const all = pieces(text);
	const biggestEntry = Math.max(...text.split("\n").map((l) => l.length));
	expect(all.length).toBeGreaterThan(10);
	for (const piece of all) expect(piece.length).toBeLessThanOrEqual(PIECE_CHARS + biggestEntry + 1);
	// And they are still the same document.
	expect(document(text).entries.length).toBe(4000);
});

test("an entry larger than a piece is a piece of its own, whole", () => {
	const text = conversation(3, PIECE_CHARS * 2);
	expect(document(text).entries.map((e) => e.id)).toEqual([entryId(0), entryId(1), entryId(2)]);
});

test("entries a file shares with an earlier one are left out and named in its order", () => {
	const text = conversation(6, 20);
	const seen = new Set([entryId(0), entryId(1), entryId(2)]);
	const doc = document(text, seen);
	expect(doc.entries.map((e) => e.id)).toEqual([entryId(3), entryId(4), entryId(5)]);
	expect(doc.order).toEqual([0, 1, 2, 3, 4, 5].map(entryId));
	// What the file sent is now known to the files after it.
	expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5].map(entryId));
});

test("a file that shares nothing has no order, and its entries are all there", () => {
	const doc = document(conversation(4, 20), new Set());
	expect(doc.order).toBeUndefined();
	expect(doc.entries.length).toBe(4);
});

test("the order of a file with very many shared entries is cut into pieces too", () => {
	// 60000 one-line entries: their ids alone are about 900 KB of JSON.
	const text = conversation(60_000, 0);
	const seen = new Set(Array.from({ length: 60_000 }, (_, i) => entryId(i)));
	const all = pieces(text, seen);
	for (const piece of all) expect(piece.length).toBeLessThanOrEqual(PIECE_CHARS + 20);
	expect(all.length).toBeGreaterThan(3);
	const doc: FileDocument = JSON.parse(all.join(""));
	expect(doc.entries).toEqual([]);
	expect(doc.order?.length).toBe(60_000);
});

test("the header is the first session line and the title slot the first one before it, wherever they are", () => {
	const title = JSON.stringify({ type: "title", title: "Named" });
	const late = JSON.stringify({ type: "session", version: 3, id: "late", timestamp: STAMP, cwd: "/work" });
	const text = [
		title,
		line("a", null, "one"),
		line("b", "a", "two"),
		late,
		"not json",
		JSON.stringify({ type: "note" }),
		"",
	].join("\n");
	const doc = document(text);
	expect(doc.header).toEqual(parseSessionText(text).header);
	expect(doc.header?.id).toBe("late");
	expect(doc.entries.map((e) => e.id)).toEqual(["a", "b"]);
});

test("a file with no header and no entries is a document with neither", () => {
	expect(document("")).toEqual({ file: member.file, header: null, entries: [], subagents: [], advisors: [] });
});

test("the tag is in the document of a family's file, and only there", () => {
	expect(document(conversation(1, 5), new Set(), "T1").tag).toBe("T1");
	expect("tag" in document(conversation(1, 5), null, null)).toBe(false);
});

test("rememberIds reads the id of every entry, of any shape, and of neither the header nor the title slot", () => {
	const seen = new Set<string>();
	rememberIds(
		[
			JSON.stringify({ type: "title", title: "T" }),
			header,
			line("a", null, "one"),
			JSON.stringify({ id: "b", type: "message", parentId: "a" }),
			JSON.stringify({ type: "session", id: "late" }),
			"not json",
			JSON.stringify({ type: "note" }),
		].join("\n"),
		seen,
	);
	expect([...seen].sort()).toEqual(["a", "b"]);
});

/** What `entryStart` was, before it was written out: its answers are the answers of this. */
const FORMER_ENTRY_START = /^\{"type":"([^"\\]*)","id":"([^"\\]*)"/;

test("entryStart answers as the regular expression it replaced did, for every shape of line", () => {
	const lines = [
		line("a1b2c3d4", null, "hello"),
		header,
		JSON.stringify({ type: "title", title: "T" }),
		'{"type":"message","id":"abc"}',
		// An id or a type with an escape in it: no match, as before.
		'{"type":"mess\\u0061ge","id":"abc"}',
		'{"type":"message","id":"ab\\u0063"}',
		// Cut off where omp was still writing: no entry, as before.
		'{"type":"message","id":"ab',
		'{"type":"message","id":"',
		'{"type":"message","id"',
		'{"type":"message"',
		'{"type":"',
		'{"type":"mess',
		// Not the way omp writes an entry: another key first, a space, another order.
		'{"id":"abc","type":"message"}',
		'{"type": "message","id":"abc"}',
		'{ "type":"message","id":"abc"}',
		'{"type":"message", "id":"abc"}',
		' {"type":"message","id":"abc"}',
		'{"type":"a""b","id":"abc"}',
		'{"type":"","id":""}',
		// What a file written on Windows or by an editor adds: a carriage return at the end of a line (a file is cut at
		// "\n"), and a byte order mark at the start of the first.
		'{"type":"message","id":"abc"}\r',
		'{"type":"message","id":"abc"\r',
		'{"type":"message","id":"abc\r',
		"\r",
		`\uFEFF${line("a1b2c3d4", null, "hello")}`,
		`\uFEFF${header}`,
		// The expression read code units (it had no `u` flag): a character outside the BMP is two of them, a lone surrogate
		// is one, and U+2028 is a character like any other.
		'{"type":"mess😀ge","id":"a😀b"}',
		'{"type":"message","id":"a\uD800b"}',
		'{"type":"\uDC00","id":"\uD83D"}',
		'{"type":"message","id":"a\uD83D"}',
		'{"type":"message","id":"\u2028"}',
		"",
		"not json",
	];
	for (const text of lines) {
		const former = FORMER_ENTRY_START.exec(text);
		expect(entryStart(text)).toEqual(former ? { type: former[1] as string, id: former[2] as string } : null);
	}
});

/**
 * What a worker thread that read a long conversation's entries still holds above what it held before, and the file's size.
 * `longIds`: the ids are 36 characters, not the 8 omp writes. JavaScriptCore copies a substring of up to 8 Latin-1
 * characters and shares the memory of a longer one, so only a long id can keep the text it was read from alive.
 */
async function heldAfterScan(holdIds: boolean, longIds = false): Promise<{ held: number[]; size: number }> {
	const root = mkdtempSync(join(tmpdir(), "ompw-family-retention-"));
	const worker = new Worker(new URL("../support/family-retention-worker.ts", import.meta.url));
	try {
		let file = realpathSync(writeBigSession(root, 22 * 1024 * 1024));
		if (longIds) {
			const long = join(root, "long-ids.jsonl");
			writeFileSync(
				long,
				readFileSync(file, "utf8").replace(/"id":"(\w{8})"/g, '"id":"$1-7c1f-4e0a-9d2b-3f5a6b7c8d9e"'),
			);
			file = long;
		}
		const reply = Promise.withResolvers<{ held: number[] }>();
		worker.onmessage = (event: MessageEvent<{ held: number[] }>) => reply.resolve(event.data);
		worker.onerror = (event) => reply.reject(new Error(event.message));
		worker.postMessage({ file, holdIds });
		return { held: (await reply.promise).held, size: statSync(file).size };
	} finally {
		worker.terminate();
		rmSync(root, { recursive: true, force: true });
	}
}

test("a worker that has read a long conversation's entries does not keep its text", async () => {
	const { held, size } = await heldAfterScan(false);
	// Not once, in none of the turns after the scan: an idle thread holds what it held when it went idle.
	expect(Math.max(...held)).toBeLessThan(size / 4);
}, 60_000);

test("nor does one that still holds the ids it read of a file the client has (an id is a copy, not a piece of the text)", async () => {
	const { held, size } = await heldAfterScan(true, true);
	expect(Math.max(...held)).toBeLessThan(size / 4);
}, 60_000);
