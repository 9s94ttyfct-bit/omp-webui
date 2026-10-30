import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LineCursor, SessionFile } from "../../server/sessions/lines.ts";

/** Reading a transcript from a byte offset: the offsets are what an index resumes from. */

const root = mkdtempSync(join(tmpdir(), "ompw-lines-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const write = (content: string): string => {
	const file = join(root, `f${n++}.jsonl`);
	writeFileSync(file, content);
	return file;
};

/** The lines of `file` between two offsets, read from one open file. */
async function linesOf(file: string, from: number, to: number, chunk?: number) {
	const open = SessionFile.open(file);
	if (!open) return [];
	try {
		return await readAll(open.lines(from, to, chunk));
	} finally {
		open.close();
	}
}

async function readAll(cursor: LineCursor) {
	const out = [];
	for (let line = await cursor.next(); line; line = await cursor.next()) out.push(line);
	return out;
}

test("lines come out whole, with the offset the next one starts at, however small the chunks are", async () => {
	const content = 'alpha\n{"é":"日本語 😀"}\n\nlast line\n';
	const file = write(content);
	const bytes = Buffer.from(content);
	for (const chunk of [1, 2, 3, 7, 4096]) {
		const lines = await linesOf(file, 0, bytes.length, chunk);
		expect(lines.map((l) => l.text)).toEqual(["alpha", '{"é":"日本語 😀"}', "", "last line"]);
		expect(lines.every((l) => l.terminated)).toBe(true);
		let at = 0;
		for (const l of lines) {
			at += Buffer.byteLength(l.text) + 1;
			expect(l.end).toBe(at);
		}
		expect(at).toBe(bytes.length);
	}
});

test("a range starts at its offset and stops at its end, even in the middle of a line", async () => {
	const file = write("one\ntwo\nthree\nfour\n");
	const lines = await linesOf(file, 4, 11, 3);
	expect(lines.map((l) => [l.text, l.terminated, l.end])).toEqual([
		["two", true, 8],
		["thr", false, 11],
	]);
});

test("a line the writer has not finished is the last one and is not terminated", async () => {
	const file = write('{"a":1}\n{"b":');
	const lines = await linesOf(file, 0, 13, 4);
	expect(lines.map((l) => [l.text, l.terminated])).toEqual([
		['{"a":1}', true],
		['{"b":', false],
	]);
	expect(lines[1]?.end).toBe(13);
});

test("a line longer than a chunk is not cut", async () => {
	const long = "x".repeat(10_000);
	const file = write(`${long}\nshort\n`);
	const lines = await linesOf(file, 0, 10_006, 64);
	expect(lines.map((l) => l.text.length)).toEqual([10_000, 5]);
});

test("a file that is shorter than it was when listed gives what is there", async () => {
	const file = write("one\ntwo\n");
	const lines = await linesOf(file, 0, 1000, 5);
	expect(lines.map((l) => l.text)).toEqual(["one", "two"]);
	expect(await linesOf(join(root, "missing.jsonl"), 0, 100)).toEqual([]);
	expect(SessionFile.open(join(root, "missing.jsonl"))).toBeNull();
});

test("the hash of the bytes before an offset changes when they do and not when what follows does", () => {
	const hashAt = (file: string, end: number) => {
		const open = SessionFile.open(file) as SessionFile;
		try {
			return open.windowHash(end);
		} finally {
			open.close();
		}
	};
	const file = write("0123456789\nabcdefghij\n");
	const before = hashAt(file, 11);
	appendFileSync(file, "more\n");
	expect(hashAt(file, 11)).toBe(before);
	writeFileSync(file, "0123456780\nabcdefghij\nmore\n");
	expect(hashAt(file, 11)).not.toBe(before);
	// Short files: the window is whatever there is.
	expect(hashAt(file, 0)).toBe(hashAt(file, 0));
});

test("a file replaced while it is read is read to the end as it was opened, and its size, time and hash are its own", async () => {
	const old = Array.from({ length: 50 }, (_, i) => `old line ${i}`).join("\n");
	const file = write(`${old}\n`);
	const open = SessionFile.open(file) as SessionFile;
	const size = open.size;
	try {
		// 16-byte chunks: the file is read in many pieces, and it is replaced between them.
		const cursor = open.lines(0, size, 16);
		const got: string[] = [];
		for (let line = await cursor.next(); line; line = await cursor.next()) {
			got.push(line.text);
			if (got.length === 10) {
				writeFileSync(`${file}.new`, `${Array.from({ length: 80 }, (_, i) => `NEW line ${i} (longer)`).join("\n")}\n`);
				renameSync(`${file}.new`, file);
			}
		}
		expect(got).toEqual(Array.from({ length: 50 }, (_, i) => `old line ${i}`));
		// What is recorded of the read is of the file that was read, not of what the path names now.
		expect(open.size).toBe(size);
		const hash = open.windowHash(size);
		const again = SessionFile.open(file) as SessionFile;
		try {
			expect(again.size).not.toBe(size);
			expect(again.windowHash(size)).not.toBe(hash);
		} finally {
			again.close();
		}
	} finally {
		open.close();
	}
});

test("closing a file with a read in flight lets the read finish; after that nothing is read from it", async () => {
	const file = write("one\ntwo\nthree\n");
	const open = SessionFile.open(file) as SessionFile;
	const cursor = open.lines(0, open.size, 4);
	const first = await cursor.next();
	const second = cursor.next();
	open.close();
	expect((await second)?.text).toBe("two");
	expect(open.isOpen).toBe(false);
	// The range is cut short where the closed file gives nothing more, as for a file that was removed.
	expect(await cursor.next()).toBeNull();
	expect(first?.text).toBe("one");
	expect(open.read(0, 3).length).toBe(0);
});
