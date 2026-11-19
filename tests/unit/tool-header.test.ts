import { expect, test } from "bun:test";
import { argsShownInHeader, headerPath } from "../../web/src/lib/tool-header.ts";

/** What a tool card's header says of its call, and what it leaves to the opened card (#333, #344). */

test("arguments of one line the header shows whole are not shown again, omp's intent beside it or not (#333)", () => {
	expect(argsShownInHeader({ command: "echo hi" }, "echo hi")).toBe(true);
	// omp 18 keeps the model's intent in the call's arguments as `i`.
	expect(argsShownInHeader({ command: "echo hi", i: "Saying hi" }, "echo hi")).toBe(true);
	expect(argsShownInHeader({ path: "red.png", i: "Reading image", intent: "Reading image" }, "red.png")).toBe(true);
});

test("arguments with anything else in them, or a line the header does not show, are still shown (#333)", () => {
	expect(argsShownInHeader({ command: "echo hi", timeout: 5, i: "Saying hi" }, "echo hi")).toBe(false);
	expect(argsShownInHeader({ command: "echo hi", i: "Saying hi" }, "something else")).toBe(false);
	expect(argsShownInHeader({ i: "Only the intent" }, "Only the intent")).toBe(false);
	expect(argsShownInHeader({ count: 3 }, "3")).toBe(false);
	expect(argsShownInHeader(undefined, "")).toBe(false);
});

test("a file inside the conversation's folder is named by the path in it, one outside as it is (#344)", () => {
	const cwd = "/work/proj";
	expect(headerPath("/work/proj/a.ts", undefined, cwd)).toBe("a.ts");
	expect(headerPath("/work/proj/sub/notes.md", undefined, `${cwd}/`)).toBe("sub/notes.md");
	expect(headerPath("/work/other/a.ts", undefined, cwd)).toBe("/work/other/a.ts");
	// A folder that only starts like the conversation's is not inside it.
	expect(headerPath("/work/project-two/a.ts", undefined, cwd)).toBe("/work/project-two/a.ts");
	// The call's own relative path wins for the first file.
	expect(headerPath("/work/proj/src/a.ts", { path: "src/a.ts" }, undefined)).toBe("src/a.ts");
});
