import { expect, test } from "bun:test";
import {
	contentText,
	foldEntry,
	newAcc,
	parseSessionText,
	searchableText,
	summarize,
	transcriptUsage,
} from "../../server/sessions/parse.ts";
import { conversation, SHAPES } from "../support/malformed-content.ts";

/**
 * What the server makes of a session file for the sidebar and for search (the preview, the counts, the text that is
 * indexed) reads around content that omp never wrote: it never throws, and it indexes only text that is text, not `5`
 * or `[object Object]` where a text block had something else.
 */

const header = {
	type: "session",
	version: 3,
	id: "01a00000-0000-7000-8000-00000000aaaa",
	timestamp: "2026-01-17T10:00:00Z",
	cwd: "/x",
};
const fileText = (shape: (typeof SHAPES)[string]) =>
	[header, ...conversation(shape)].map((line) => JSON.stringify(line)).join("\n");

for (const [name, shape] of Object.entries(SHAPES)) {
	test(`${name}: the summary, the usage and the searchable text read around it`, () => {
		const text = fileText(shape);
		const parsed = parseSessionText(text);
		expect(parsed.entries).toHaveLength(conversation(shape).length);
		const summary = summarize("/x/f.jsonl", parsed, { mtimeMs: 1, size: text.length }, 0);
		expect(summary?.messageCount).toBeGreaterThan(0);
		expect(typeof summary?.preview).toBe("string");
		expect(() => transcriptUsage(text)).not.toThrow();
		// Folded one entry at a time, as a transcript that grows is, it is the same.
		const acc = newAcc();
		for (const e of parsed.entries) foldEntry(acc, e);
		expect(acc.messageCount).toBe(summary?.messageCount ?? -1);
		for (const e of parsed.entries) {
			const found = searchableText(e);
			if (found) {
				expect(found.text).not.toContain("[object Object]");
				expect(found.text).not.toMatch(/(^|\n)(5|true|null|undefined)(\n|$)/);
			}
		}
	});
}

test("only a text block with text in it is text", () => {
	expect(
		contentText([
			null,
			{ type: "text", text: "kept" },
			5,
			{ type: "text", text: 5 },
			{ type: "text", text: null },
			{ type: "text", text: {} },
			{ type: "text", text: ["x"] },
			{ type: "text" },
		]),
	).toBe("kept");
	expect(
		contentText([
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		]),
	).toBe("a\nb");
	for (const content of [null, 5, {}, true, undefined]) expect(contentText(content)).toBe("");
	expect(contentText("plain")).toBe("plain");
});

test("a reply whose text blocks are not text is indexed as the text it has", () => {
	const reply = conversation(SHAPES["text that is not text"]).find((e) => e.id === "a1");
	expect(reply && searchableText(reply)).toEqual({ role: "assistant", text: "visible text" });
});
