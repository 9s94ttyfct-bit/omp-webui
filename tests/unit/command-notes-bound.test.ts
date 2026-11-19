import { expect, test } from "bun:test";
import { loadCommandNotes, MAX_TOTAL, type NoteStorage, saveCommandNotes } from "../../web/src/lib/command-notes.ts";
import type { CommandNote } from "../../web/src/lib/notices.ts";

/**
 * What commands printed is kept in the browser, which shares one small localStorage between it and the page's settings
 * (#242): the total kept is bounded by size, not only by counts, and the oldest files go first.
 */

const storage = (): NoteStorage & { size(): number } => {
	const map = new Map<string, string>();
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
		size: () => [...map.values()].reduce((n, v) => n + v.length, 0),
	};
};

const notes = (file: string, count: number, chars: number): CommandNote[] =>
	Array.from({ length: count }, (_, i) => ({
		kind: "command",
		seq: i + 1,
		at: i,
		after: null,
		file,
		text: `${file}#${i} ${"x".repeat(chars)}`,
	}));

test("notes of many conversations stay under the total, the oldest conversation going first", () => {
	const s = storage();
	for (let f = 0; f < 40; f++) saveCommandNotes(`/s/${f}.jsonl`, notes(`/s/${f}.jsonl`, 30, 5_000), s);
	expect(s.size()).toBeLessThanOrEqual(MAX_TOTAL);
	expect(loadCommandNotes("/s/0.jsonl", s)).toEqual([]);
	// The latest conversation keeps all it was given (30 × 5,000 is under the total).
	expect(loadCommandNotes("/s/39.jsonl", s)).toHaveLength(30);
});

test("one conversation's notes alone over the total lose their oldest, not the newest", () => {
	const s = storage();
	saveCommandNotes("/s/a.jsonl", notes("/s/a.jsonl", 30, 20_000), s);
	expect(s.size()).toBeLessThanOrEqual(MAX_TOTAL);
	const kept = loadCommandNotes("/s/a.jsonl", s);
	expect(kept.length).toBeGreaterThan(0);
	expect(kept.length).toBeLessThan(30);
	expect(kept.at(-1)?.text.startsWith("/s/a.jsonl#29 ")).toBe(true);
});
