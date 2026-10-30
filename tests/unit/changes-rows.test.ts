import { describe, expect, test } from "bun:test";
import type { DiffHunk, DiffRow } from "../../shared/changes.ts";
import { linesOfHighlighted, sideIndex, sideText, splitRows } from "../../web/src/lib/changes-rows.ts";

const ctx = (text: string, old: number, now: number): DiffRow => ({ kind: "ctx", text, old, new: now });
const del = (text: string, old: number): DiffRow => ({ kind: "del", text, old });
const add = (text: string, now: number): DiffRow => ({ kind: "add", text, new: now });
const hunk = (rows: DiffRow[]): DiffHunk => ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, section: "", rows });

describe("a hunk's rows side by side", () => {
	test("a context line is on both sides; removed lines meet the added lines after them, one for one", () => {
		const rows = [ctx("a", 1, 1), del("b", 2), del("c", 3), add("B", 2), ctx("d", 4, 3)];
		expect(splitRows(rows)).toEqual([
			{ left: rows[0], right: rows[0] },
			{ left: rows[1], right: rows[3] },
			{ left: rows[2], right: undefined },
			{ left: rows[4], right: rows[4] },
		]);
	});

	test("more added lines than removed ones leave the left side empty for the rest, and a pure addition has no left", () => {
		const rows = [del("b", 1), add("B", 1), add("C", 2), add("D", 3)];
		expect(splitRows(rows).map((r) => [r.left?.text, r.right?.text])).toEqual([
			["b", "B"],
			[undefined, "C"],
			[undefined, "D"],
		]);
		expect(splitRows([add("x", 1)])).toEqual([{ left: undefined, right: { kind: "add", text: "x", new: 1 } }]);
	});

	test("nothing in, nothing out", () => {
		expect(splitRows([])).toEqual([]);
	});
});

describe("one side of a diff as text", () => {
	const hunks = [hunk([ctx("a", 1, 1), del("b", 2), add("B", 2)]), hunk([ctx("z", 9, 9), add("new", 10)])];

	test("the old file is the context and the removed lines; the new one, the context and the added", () => {
		expect(sideText(hunks, "old")).toBe("a\nb\nz");
		expect(sideText(hunks, "new")).toBe("a\nB\nz\nnew");
	});

	test("each row knows its line in that text, or -1 when it is not on that side", () => {
		expect(sideIndex(hunks, "old")).toEqual([0, 1, -1, 2, -1]);
		expect(sideIndex(hunks, "new")).toEqual([0, -1, 1, 2, 3]);
	});
});

describe("the lines of highlighted code", () => {
	test("each line's inner html, in order", () => {
		const html =
			'<pre class="shiki"><code><span class="line"><span style="c:1">const</span> a</span>\n<span class="line"></span></code></pre>';
		expect(linesOfHighlighted(html)).toEqual(['<span style="c:1">const</span> a', ""]);
	});

	test("anything that is not that shape is null", () => {
		expect(linesOfHighlighted("<pre>plain</pre>")).toBeNull();
		expect(linesOfHighlighted('<pre><code>no span\n<span class="line">x</span></code></pre>')).toBeNull();
	});
});
