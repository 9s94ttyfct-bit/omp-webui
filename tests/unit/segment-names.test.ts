import { expect, test } from "bun:test";
import type { SessionEntry } from "../../shared/protocol.ts";
import { indexTree } from "../../web/src/lib/tree.ts";
import { Segmenter } from "../../web/src/lib/turns.ts";

/**
 * A conversation's history comes in a page at a time from its end, and a turn that runs longer than a page is cut by one: the
 * page above joins it at its head. It is the same turn, longer, so the segment keeps its name, and what is told by the name
 * (the messages shown from it, the cuts of the pages, the element that draws it) stays where it was.
 */

const msg = (id: string, parentId: string | null, message: Record<string, unknown>) =>
	({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message }) as unknown as SessionEntry;

const prompt = (id: string, parent: string | null) => msg(id, parent, { role: "user", content: "go" });
const step = (id: string, parent: string) => msg(id, parent, { role: "assistant", content: [] });

/** The path of `ids`' entries, each the child of the one before. */
function chain(spec: [kind: "prompt" | "step", id: string][]): SessionEntry[] {
	let parent: string | null = null;
	return spec.map(([kind, id]) => {
		const e = kind === "prompt" ? prompt(id, parent) : step(id, parent as string);
		parent = id;
		return e;
	});
}

function show(segmenter: Segmenter, rows: SessionEntry[]) {
	// The page's path is the rows held, whatever their parents say of what is above (the first one's parent is not in it).
	segmenter.update(rows, indexTree(rows), [], []);
	return { keys: [...segmenter.keys], positions: new Map(segmenter.positions) };
}

const all = chain([
	["prompt", "p0"],
	["step", "a1"],
	["step", "a2"],
	["step", "a3"],
	["step", "a4"],
	["step", "a5"],
	["step", "a6"],
	["prompt", "p1"],
	["step", "b1"],
]);

test("a segment that rows come in above, into the same turn, keeps the name it had", () => {
	const segmenter = new Segmenter();
	// The page holds the end: the turn is held from its fourth step on.
	const first = show(segmenter, all.slice(4));
	expect(first.keys).toEqual(["a4", "p1", "b1"]);
	// The page above joins it at its head.
	const second = show(segmenter, all.slice(2));
	expect(second.keys).toEqual(["a4", "p1", "b1"]);
	expect(segmenter.segments[0]?.kind === "turn" && segmenter.segments[0].turn.rows.map((r) => r.id)).toEqual([
		"a2",
		"a3",
		"a4",
		"a5",
		"a6",
	]);
	// What was named by it is still found, at the same place.
	expect(second.positions.get("a4")).toBe(0);
	// And again: the name is the one the segment had when it was first shown.
	const third = show(segmenter, all.slice(1));
	expect(third.keys).toEqual(["a4", "p1", "b1"]);
});

test("a page that brings whole segments above puts them before the segments held, which keep their names", () => {
	const segmenter = new Segmenter();
	const before = show(segmenter, all.slice(7));
	expect(before.keys).toEqual(["p1", "b1"]);
	const after = show(segmenter, all);
	expect(after.keys).toEqual(["p0", "a1", "p1", "b1"]);
	expect(after.positions.get("p1")).toBe(2);
});

test("a turn joined at its head and then grown at its end keeps one name", () => {
	const segmenter = new Segmenter();
	show(segmenter, all.slice(4, 8));
	const joined = show(segmenter, all.slice(2, 8));
	expect(joined.keys).toEqual(["a4", "p1"]);
	// A step is written after it (a live turn): the segments are made on from where they were.
	const longer = [...all.slice(2, 9)];
	expect(show(segmenter, longer).keys).toEqual(["a4", "p1", "b1"]);
});

test("another path (the first row of the old first segment is not in it) is not the same turn", () => {
	const segmenter = new Segmenter();
	show(segmenter, all.slice(4));
	const other = chain([
		["prompt", "q0"],
		["step", "c1"],
	]);
	expect(show(segmenter, other).keys).toEqual(["q0", "c1"]);
});
