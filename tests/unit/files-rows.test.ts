import { expect, test } from "bun:test";
import type { FolderEntry } from "../../shared/folder.ts";
import { appendPiece, insertIntoComposer, offerComposer } from "../../web/src/lib/composer-bridge.ts";
import {
	type DirSlot,
	type EntryRow,
	fmtBytes,
	kindOf,
	languageOf,
	moveFor,
	parentOf,
	splitMatch,
	visibleOpen,
	visibleRows,
} from "../../web/src/lib/files-rows.ts";

/** The Files tab's tree on its own: which rows are on screen, where each key goes, and what a file is called. */

const dir = (name: string): FolderEntry => ({ name, kind: "dir" });
const file = (name: string): FolderEntry => ({ name, kind: "file" });
const slot = (entries: FolderEntry[], extra: { hiddenCount?: number; truncated?: boolean } = {}): DirSlot => ({
	listing: {
		entries,
		hiddenCount: extra.hiddenCount ?? 0,
		truncated: extra.truncated ?? false,
		git: false,
		guarded: false,
		local: false,
	},
});

/** root: a/ (a/x.ts, a/deep/), b.txt, c/ */
const slots: Record<string, DirSlot> = {
	"": slot([dir("a"), dir("c"), file("b.txt")]),
	a: slot([dir("deep"), file("x.ts")]),
	"a/deep": slot([file("y.ts")]),
};
const names = (rows: ReturnType<typeof visibleRows>) =>
	rows.map((r) => (r.kind === "entry" ? r.path : `${r.kind}:${r.path}`));

test("nothing is open: the root's entries are the rows", () => {
	expect(names(visibleRows(slots, []))).toEqual(["a", "c", "b.txt"]);
});

test("an open folder's entries come below it, to as many levels as are open", () => {
	expect(names(visibleRows(slots, ["a", "a/deep"]))).toEqual(["a", "a/deep", "a/deep/y.ts", "a/x.ts", "c", "b.txt"]);
	const rows = visibleRows(slots, ["a"]);
	expect(rows.map((r) => (r.kind === "entry" ? [r.depth, r.open] : null))).toEqual([
		[0, true],
		[1, false],
		[1, false],
		[0, false],
		[0, false],
	]);
});

test("a row knows its place among its siblings", () => {
	const rows = visibleRows(slots, ["a"]).filter((r): r is EntryRow => r.kind === "entry");
	expect(rows.map((r) => [r.path, r.index + 1, r.count])).toEqual([
		["a", 1, 3],
		["a/deep", 1, 2],
		["a/x.ts", 2, 2],
		["c", 2, 3],
		["b.txt", 3, 3],
	]);
});

test("a folder that is open and not read yet, one that failed, an empty one and a cut list say so", () => {
	expect(names(visibleRows({ "": slots[""] }, ["c"]))).toEqual(["a", "c", "loading:c", "b.txt"]);
	const failed = visibleRows({ "": slots[""], c: { error: "denied" } }, ["c"]);
	expect(failed.find((r) => r.kind === "error")).toMatchObject({ path: "c", message: "denied", depth: 1 });
	const empty = visibleRows({ "": slots[""], c: slot([], { hiddenCount: 3 }) }, ["c"]);
	expect(empty.find((r) => r.kind === "empty")).toMatchObject({ path: "c", n: 3 });
	const cut = visibleRows({ "": slot([file("a"), file("b")], { truncated: true }) }, []);
	expect(cut.at(-1)).toMatchObject({ kind: "cut", n: 2 });
});

test("a file is never open, even if its name is in the list", () => {
	expect(visibleRows(slots, ["b.txt"]).find((r) => r.kind === "entry" && r.path === "b.txt")).toMatchObject({
		open: false,
	});
});

test("a folder whose parent is closed is open but not to be seen: it is not read or watched", () => {
	expect(visibleOpen(["a/deep", "a"])).toEqual(["a/deep", "a"]);
	expect(visibleOpen(["a/deep"])).toEqual([]);
	expect(visibleOpen(["a", "x/y", "a/deep/more"])).toEqual(["a"]);
	expect(parentOf("a/b/c")).toBe("a/b");
	expect(parentOf("a")).toBe("");
});

const rows = visibleRows(slots, ["a", "a/deep"]);
// a, a/deep, a/deep/y.ts, a/x.ts, c, b.txt

test("Down and Up move by a row and stop at the ends; Home and End go to the first and last", () => {
	expect(moveFor("ArrowDown", rows, "a")).toEqual({ to: "a/deep" });
	expect(moveFor("ArrowDown", rows, "b.txt")).toEqual({ to: "b.txt" });
	expect(moveFor("ArrowUp", rows, "a/deep")).toEqual({ to: "a" });
	expect(moveFor("ArrowUp", rows, "a")).toEqual({ to: "a" });
	expect(moveFor("Home", rows, "c")).toEqual({ to: "a" });
	expect(moveFor("End", rows, "a")).toEqual({ to: "b.txt" });
	// Nothing focused yet: Down goes to the first row.
	expect(moveFor("ArrowDown", rows, null)).toEqual({ to: "a" });
});

test("Right opens a closed folder, then goes into it; on a file it does nothing", () => {
	expect(moveFor("ArrowRight", rows, "c")).toEqual({ open: "c" });
	expect(moveFor("ArrowRight", rows, "a")).toEqual({ to: "a/deep" });
	expect(moveFor("ArrowRight", rows, "b.txt")).toBeNull();
	// An open folder with nothing under it has no row to go into.
	expect(moveFor("ArrowRight", visibleRows({ "": slot([dir("e")]), e: slot([]) }, ["e"]), "e")).toBeNull();
});

test("Left closes an open folder, then goes to the folder around it; at the top it does nothing", () => {
	expect(moveFor("ArrowLeft", rows, "a")).toEqual({ close: "a" });
	expect(moveFor("ArrowLeft", rows, "a/deep/y.ts")).toEqual({ to: "a/deep" });
	expect(moveFor("ArrowLeft", rows, "a/x.ts")).toEqual({ to: "a" });
	expect(moveFor("ArrowLeft", rows, "c")).toBeNull();
	expect(moveFor("ArrowLeft", rows, "b.txt")).toBeNull();
});

test("Enter and Space open or close a folder and open a file", () => {
	for (const key of ["Enter", " "]) {
		expect(moveFor(key, rows, "c")).toEqual({ toggle: "c" });
		expect(moveFor(key, rows, "a")).toEqual({ toggle: "a" });
		expect(moveFor(key, rows, "b.txt")).toEqual({ choose: "b.txt" });
		expect(moveFor(key, rows, null)).toBeNull();
	}
});

test("other keys, and a tree with no rows, move nothing", () => {
	expect(moveFor("a", rows, "a")).toBeNull();
	expect(moveFor("Tab", rows, "a")).toBeNull();
	expect(moveFor("ArrowDown", [], null)).toBeNull();
	// Notes are not rows to be on: a loading row is skipped.
	const withNote = visibleRows({ "": slots[""] }, ["c"]);
	expect(moveFor("ArrowDown", withNote, "c")).toEqual({ to: "b.txt" });
});

test("what a file looks like and what language it is", () => {
	expect(kindOf("logo.PNG")).toBe("image");
	expect(kindOf("notes.md")).toBe("text");
	expect(kindOf("package.json")).toBe("data");
	expect(kindOf("main.rs")).toBe("code");
	expect(kindOf("Makefile")).toBe("file");
	expect(kindOf(".env")).toBe("file");
	expect(languageOf("app.test.ts")).toBe("ts");
	expect(languageOf("Dockerfile")).toBe("dockerfile");
	expect(languageOf(".gitignore")).toBe(".gitignore");
});

test("sizes as people read them", () => {
	expect(fmtBytes(0)).toBe("0 B");
	expect(fmtBytes(999)).toBe("999 B");
	expect(fmtBytes(1000)).toBe("1 KB");
	expect(fmtBytes(3400)).toBe("3.4 KB");
	expect(fmtBytes(123_456)).toBe("123 KB");
	expect(fmtBytes(1_048_576)).toBe("1.0 MB");
	expect(fmtBytes(25_000_000)).toBe("25 MB");
});

test("the match of a filter is marked, whatever its case", () => {
	expect(splitMatch("src/App.tsx", "app")).toEqual(["src/", "App", ".tsx"]);
	expect(splitMatch("src/app.ts", "zzz")).toEqual(["src/app.ts", "", ""]);
	expect(splitMatch("abc", "")).toEqual(["abc", "", ""]);
	expect(splitMatch("abc", "  ")).toEqual(["abc", "", ""]);
});

test("a mention is put after what is typed, set off by a space, with a space after it", () => {
	expect(appendPiece("", "@a.ts")).toBe("@a.ts ");
	expect(appendPiece("look at", "@a.ts")).toBe("look at @a.ts ");
	expect(appendPiece("look at ", "@a.ts")).toBe("look at @a.ts ");
	expect(appendPiece("one\n", "@a.ts")).toBe("one\n@a.ts ");
});

test("the message box on screen is the one mentions go to, until it goes", () => {
	expect(insertIntoComposer("@x", true)).toBe(false);
	const got: [string, boolean][] = [];
	const first = offerComposer((text, focus) => got.push([text, focus]));
	expect(insertIntoComposer("@a", true)).toBe(true);
	const second = offerComposer(() => {});
	// The one that was withdrawn is not the one on screen any more: leaving it does not unseat the new one.
	first();
	expect(insertIntoComposer("@b", false)).toBe(true);
	expect(got).toEqual([["@a", true]]);
	second();
	expect(insertIntoComposer("@c", false)).toBe(false);
});
