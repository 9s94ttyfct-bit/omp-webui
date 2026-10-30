import { describe, expect, test } from "bun:test";
import { missingTokens, offScaleSizes, offScaleStylesheet, SCALE } from "../../scripts/check-type-scale.ts";

/**
 * The type scale is three steps and no others: caption 12px (the floor), body 14px and title 15px. The gate that
 * keeps it that way (scripts/check-type-scale.ts) is checked here on the sizes it must let through and the ones it
 * must name.
 */

describe("the type scale", () => {
	test("is the caption, the body and the title", () => {
		expect(SCALE).toEqual({ caption: 12, body: 14, title: 15 });
	});

	test("the caption is the floor: nothing is drawn under 12px", () => {
		expect(SCALE.caption).toBe(12);
	});
});

describe("the gate on the page's own source", () => {
	test("a size that is not one of the scale's is named, with the line it is on", () => {
		const problems = offScaleSizes('const a = "text-[13px]";\nconst b = "text-[11px]";', "web/src/x.tsx");
		expect(problems).toHaveLength(2);
		expect(problems[0].at).toBe("web/src/x.tsx:1");
		expect(problems[0].what).toContain("text-[13px]");
		expect(problems[1].at).toBe("web/src/x.tsx:2");
	});

	test("the scale's own sizes pass", () => {
		expect(offScaleSizes('const a = "text-xs"; const b = "text-sm"; const c = "text-title";', "x.tsx")).toEqual([]);
	});

	test("a size the scale has, written out, is not an error", () => {
		// The named utility is the one to write, but `text-[12px]` is the same size and is not off the scale.
		expect(offScaleSizes('const a = "text-[12px]"; const b = "text-[14px]";', "x.tsx")).toEqual([]);
	});

	test("the message names the sizes to use, not the ones it rejected", () => {
		const [problem] = offScaleSizes('const a = "text-[11px]";', "x.tsx");
		expect(problem.what).toContain("text-xs (12px)");
		expect(problem.what).toContain("text-sm (14px)");
		expect(problem.what).toContain("text-title (15px)");
		expect(problem.what).not.toContain("is not one of the type scale");
	});

	test("the title's one-offs pass: 15px, and 16px for a touch screen", () => {
		expect(offScaleSizes('const a = "text-[15px]"; const b = "pointer-coarse:text-[16px]";', "x.tsx")).toEqual([]);
	});

	test("a size that is not a size at all is not named", () => {
		expect(offScaleSizes('const a = "text-[calc(1rem*2)]"; const b = "text-[--foo]";', "x.tsx")).toEqual([]);
	});

	test("a size handed to a library that draws the text itself is named too", () => {
		const problems = offScaleSizes("const tick = { fontSize: 11 };", "web/src/UsagePage.tsx");
		expect(problems).toHaveLength(1);
		expect(problems[0].what).toContain("fontSize: 11");
		expect(offScaleSizes("const tick = { fontSize: 12 };", "x.tsx")).toEqual([]);
	});
});

describe("the gate on the stylesheet", () => {
	test("a size that is not one of the scale's is named", () => {
		const problems = offScaleStylesheet(".a { font-size: 13px; }", "web/src/index.css");
		expect(problems).toHaveLength(1);
		expect(problems[0].what).toContain("13px");
	});

	test("the scale's own sizes pass, and so does the touch screen's 16px", () => {
		expect(
			offScaleStylesheet(".a { font-size: 12px; } .b { font-size: 14px; } .c { font-size: 15px; }", "x.css"),
		).toEqual([]);
		expect(offScaleStylesheet(".a { font-size: 16px; }", "x.css")).toEqual([]);
	});

	test("a size in em is relative to its parent and is not the gate's business", () => {
		expect(offScaleStylesheet(".a { font-size: 0.88em; }", "x.css")).toEqual([]);
	});
});

describe("the gate on the theme tokens", () => {
	test("a stylesheet that defines the three steps passes", () => {
		const css = "--text-xs: 12px;\n--text-sm: 14px;\n--text-title: 15px;";
		expect(missingTokens(css)).toEqual([]);
	});

	test("a step that is missing, or the wrong size, is named", () => {
		expect(missingTokens("--text-xs: 12px;\n--text-sm: 14px;")).toEqual([
			{ at: "web/src/index.css", what: "--text-title (the 15px step) is not defined" },
		]);
		expect(missingTokens("--text-xs: 12px;\n--text-sm: 16px;\n--text-title: 15px;")).toEqual([
			{ at: "web/src/index.css", what: "--text-sm is 16px, not the 14px of the type scale" },
		]);
	});
});
