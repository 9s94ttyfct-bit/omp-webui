import { expect, test } from "bun:test";
import {
	diffCounts,
	hashlinePaths,
	listingRows,
	parseDiff,
	resultTexts,
	splitPath,
	splitWarnings,
	toolChanges,
} from "../../web/src/lib/diff.ts";

const DIFF =
	" 60|\tprivate exited = false;\n 61|x\n-62|\tprivate resolveReady!: () => void;\n+62|\tprivate resolveReady: () => void;\n 64|\n\n 42|\t};";

test("parseDiff reads sign, unpadded line numbers, tabs, empty text and hunk gaps", () => {
	expect(parseDiff(DIFF)).toEqual([
		{ kind: "ctx", line: 60, text: "\tprivate exited = false;" },
		{ kind: "ctx", line: 61, text: "x" },
		{ kind: "del", line: 62, text: "\tprivate resolveReady!: () => void;" },
		{ kind: "add", line: 62, text: "\tprivate resolveReady: () => void;" },
		{ kind: "ctx", line: 64, text: "" },
		{ kind: "gap" },
		{ kind: "ctx", line: 42, text: "\t};" },
	]);
	// Numbers of different widths in one diff, text that itself contains `|` and a sign.
	expect(parseDiff(" 1|a\n+209|b | c\n- 7|nope")).toEqual([
		{ kind: "ctx", line: 1, text: "a" },
		{ kind: "add", line: 209, text: "b | c" },
	]);
});

test("parseDiff survives junk, collapses gaps and trims them off the ends", () => {
	const rows = parseDiff("\n@@ -1,2 +1,2 @@\n\n \n 3|a\n\n\n   \n+4|b\n\n");
	expect(rows).toEqual([{ kind: "ctx", line: 3, text: "a" }, { kind: "gap" }, { kind: "add", line: 4, text: "b" }]);
	expect(parseDiff("")).toEqual([]);
	expect(parseDiff("just prose, no diff")).toEqual([]);
	expect(parseDiff("+3|a\r\n-4|b\r")).toEqual([
		{ kind: "add", line: 3, text: "a" },
		{ kind: "del", line: 4, text: "b" },
	]);
});

test("diffCounts counts added and removed lines only", () => {
	expect(diffCounts(parseDiff(DIFF))).toEqual({ added: 1, removed: 1 });
	expect(diffCounts([])).toEqual({ added: 0, removed: 0 });
});

test("hashlinePaths finds every file header of an edit input", () => {
	expect(hashlinePaths("[a/b.ts#658F]\nPUT 1.=2:\n+x")).toEqual(["a/b.ts"]);
	expect(hashlinePaths('["dir with space/c.ts#0a1B"]\nPUT 1:\n+x')).toEqual(["dir with space/c.ts"]);
	expect(hashlinePaths("[/abs/one.ts#1111]\nPUT 1:\n+[not/a/header#2222]\n[two.ts#2222]\nCUT 3")).toEqual([
		"/abs/one.ts",
		"two.ts",
	]);
	expect(hashlinePaths("*** Begin Patch\n[wrapped.ts#ABCD]\nPUT 1:\n+x\n*** End Patch")).toEqual(["wrapped.ts"]);
	expect(
		hashlinePaths(
			"*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/new.ts\n*** Delete File: old.ts\n*** End Patch",
		),
	).toEqual(["src/a.ts", "src/new.ts", "old.ts"]);
	expect(hashlinePaths("[a.ts#1234]\n[a.ts#1234]")).toEqual(["a.ts"]);
	expect(hashlinePaths("no headers here")).toEqual([]);
});

test("splitWarnings separates the Warnings section and further text blocks from the output", () => {
	expect(
		splitWarnings(["[a.ts#1]\n60:\tx\n\nWarnings:\nsyntax error at 3:1", "Warning: a.ts no longer parses"]),
	).toEqual({
		output: "[a.ts#1]\n60:\tx",
		warnings: ["syntax error at 3:1", "Warning: a.ts no longer parses"],
	});
	expect(splitWarnings(["Successfully wrote 4 bytes"])).toEqual({ output: "Successfully wrote 4 bytes", warnings: [] });
	expect(splitWarnings([])).toEqual({ output: "", warnings: [] });
});

test("resultTexts takes the text blocks of a result in either shape", () => {
	expect(
		resultTexts({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }),
	).toEqual(["a", "b"]);
	expect(resultTexts({ content: "plain" })).toEqual(["plain"]);
	expect(resultTexts(undefined)).toEqual([]);
	expect(resultTexts({})).toEqual([]);
});

test("toolChanges: a single-file edit takes its path and diff from details", () => {
	const c = toolChanges(
		"edit",
		{ input: "[args/path.ts#1234]\nPUT 1:\n+x" },
		{ diff: DIFF, path: "/p/config.ts", op: "update" },
	);
	expect(c.files).toEqual([{ path: "/p/config.ts", diff: DIFF, op: "update" }]);
	expect(c.counts).toEqual({ added: 1, removed: 1 });
});

test("toolChanges: a multi-file edit renders each perFileResults entry, not the concatenated diff", () => {
	const c = toolChanges(
		"edit",
		{},
		{
			diff: "+1|a\n+1|b",
			perFileResults: [
				{ path: "/p/a.ts", diff: "+1|a", op: "create" },
				{ path: "/p/b.ts", diff: "-1|b\n+1|c", move: "/p/c.ts" },
				{ path: "/p/d.ts", op: "delete" },
			],
		},
	);
	expect(c.files.map((f) => f.path)).toEqual(["/p/a.ts", "/p/b.ts", "/p/d.ts"]);
	expect(c.files[1]?.move).toBe("/p/c.ts");
	expect(c.files[2]?.diff).toBeUndefined();
	expect(c.counts).toEqual({ added: 2, removed: 1 });
});

test("toolChanges: path falls back from details to hashline headers to the arguments", () => {
	expect(toolChanges("write", { path: "rel.json", content: "{}" }, { resolvedPath: "/abs/rel.json" }).files).toEqual([
		{ path: "/abs/rel.json" },
	]);
	// Still running: no details yet.
	expect(toolChanges("edit", { input: "[a/b.ts#658F]\nPUT 1:\n+x\n[c.ts#0000]\nCUT 1" }, undefined).files).toEqual([
		{ path: "a/b.ts" },
		{ path: "c.ts" },
	]);
	expect(toolChanges("edit", { path: "x.ts", old_string: "a", new_string: "b" }, {}).files).toEqual([{ path: "x.ts" }]);
	expect(toolChanges("edit", { file_path: "y.ts" }, {}).files).toEqual([{ path: "y.ts" }]);
	// Internal URLs and nonsense details never throw.
	expect(toolChanges("write", { path: "agent://Name", content: "hi" }, { weird: 1 }).files).toEqual([
		{ path: "agent://Name" },
	]);
	expect(toolChanges("write", {}, null).files).toEqual([]);
	expect(toolChanges("edit", "streaming…", [] as unknown).files).toEqual([]);
});

test("toolChanges: a write that carries a diff keeps it; diagnostics are read when present", () => {
	const c = toolChanges(
		"write",
		{ path: "a.ts", content: "x" },
		{ path: "/p/a.ts", diff: "+1|x", diagnostics: { summary: "1 error", messages: ["a.ts:1 bad", 7], errored: true } },
	);
	expect(c.files[0]?.diff).toBe("+1|x");
	expect(c.diagnostics).toEqual({ summary: "1 error", messages: ["a.ts:1 bad"], errored: true });
	expect(toolChanges("edit", {}, { diff: "+1|x" }).diagnostics).toBeUndefined();
});

test("listingRows numbers written content as neutral rows", () => {
	expect(listingRows("a\n\tb\n")).toEqual([
		{ kind: "ctx", line: 1, text: "a" },
		{ kind: "ctx", line: 2, text: "\tb" },
	]);
	expect(listingRows("")).toEqual([]);
	expect(listingRows("x\r\ny")).toEqual([
		{ kind: "ctx", line: 1, text: "x" },
		{ kind: "ctx", line: 2, text: "y" },
	]);
});

test("splitPath keeps the directory and the file name apart", () => {
	expect(splitPath("/Users/x/proj/server/config.ts")).toEqual({ dir: "/Users/x/proj/server/", name: "config.ts" });
	expect(splitPath("config.ts")).toEqual({ dir: "", name: "config.ts" });
	expect(splitPath("agent://Name")).toEqual({ dir: "agent://", name: "Name" });
	expect(splitPath("C:\\proj\\a.ts")).toEqual({ dir: "C:\\proj\\", name: "a.ts" });
});
