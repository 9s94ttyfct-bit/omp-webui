import { expect, test } from "bun:test";
import type { DiskRow } from "../../shared/disk-space.ts";
import { sortRows } from "../../web/src/lib/disk-space.ts";

/** The Disk space page's sort (docs/superpowers/specs/2026-11-26-disk-space-page-design.md, "The page"). */

const row = (name: string, over: Partial<DiskRow> = {}): DiskRow => ({
	folder: `/p/${name}`,
	real: `/p/${name}`,
	name,
	kind: "project",
	folderBytes: 0,
	folderState: "measured",
	measuredAt: 1,
	conversations: 0,
	conversationBytes: 0,
	lastUsed: 1,
	...over,
});

const names = (rows: DiskRow[]) => rows.map((r) => r.name);

test("total is folder plus conversations, an unmeasured folder counting as nothing; ties by name", () => {
	const rows = [
		row("b", { folderBytes: 100, conversationBytes: 50 }),
		row("a", { folderBytes: null, folderState: "unknown", conversationBytes: 150 }),
		row("c", { folderBytes: 400 }),
	];
	expect(names(sortRows(rows, { by: "total", desc: true }))).toEqual(["c", "a", "b"]);
	expect(names(sortRows(rows, { by: "total", desc: false }))).toEqual(["a", "b", "c"]);
});

test("each key sorts both ways", () => {
	const rows = [
		row("beta", { folder: "/z/beta", conversations: 3, lastUsed: 30 }),
		row("Alpha", { folder: "/y/Alpha", conversations: 1, lastUsed: 10 }),
		row("gamma", { folder: "/x/gamma", conversations: 2, lastUsed: 20 }),
	];
	expect(names(sortRows(rows, { by: "name", desc: false }))).toEqual(["Alpha", "beta", "gamma"]);
	expect(names(sortRows(rows, { by: "name", desc: true }))).toEqual(["gamma", "beta", "Alpha"]);
	expect(names(sortRows(rows, { by: "folder", desc: false }))).toEqual(["gamma", "Alpha", "beta"]);
	expect(names(sortRows(rows, { by: "conversations", desc: true }))).toEqual(["beta", "gamma", "Alpha"]);
	expect(names(sortRows(rows, { by: "lastUsed", desc: false }))).toEqual(["Alpha", "gamma", "beta"]);
});

test("a row never used comes last whichever way", () => {
	const rows = [row("never", { lastUsed: null }), row("old", { lastUsed: 1 }), row("new", { lastUsed: 9 })];
	expect(names(sortRows(rows, { by: "lastUsed", desc: true }))).toEqual(["new", "old", "never"]);
	expect(names(sortRows(rows, { by: "lastUsed", desc: false }))).toEqual(["old", "new", "never"]);
});
