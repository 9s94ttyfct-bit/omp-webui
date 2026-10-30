import { describe, expect, test } from "bun:test";
import { isAfter, LAST_UNILINGUAL, problemsIn, versionOf } from "../../scripts/check-release-notes.ts";

const both = "## English\n\n### Fix\n\n- Fixed the thing.\n\n## 中文\n\n### 修复\n\n- 修复了一个问题。\n";

describe("release notes are bilingual", () => {
	test("both sections, each in its language, pass", () => {
		expect(problemsIn(both)).toEqual([]);
		// Order does not matter.
		expect(problemsIn("## 中文\n\n- 修复。\n\n## English\n\n- Fix.\n")).toEqual([]);
	});

	test("a missing section is named", () => {
		expect(problemsIn("## English\n\n- Fix.\n")).toEqual(["no `## 中文` section"]);
		expect(problemsIn("## 中文\n\n- 修复。\n")).toEqual(["no `## English` section"]);
		expect(problemsIn("")).toHaveLength(2);
	});

	test("an empty section, or the same text under both headings, fails", () => {
		expect(problemsIn("## English\n\n## 中文\n\n- 修复。\n")).toEqual(["the `## English` section is empty"]);
		expect(problemsIn("## English\n\n- Fix.\n\n## 中文\n\n- Fix.\n")).toEqual([
			"the `## 中文` section has no Chinese text",
		]);
		expect(problemsIn("## English\n\n- 修复。\n\n## 中文\n\n- 修复。\n")).toEqual([
			"the `## English` section contains Chinese text",
		]);
	});

	test("### headings inside a section do not end it", () => {
		expect(problemsIn("## English\n\n### A\n\ntext\n\n### B\n\ntext\n\n## 中文\n\n### 甲\n\n文\n")).toEqual([]);
	});

	test("the rule starts after v0.9.1", () => {
		expect(versionOf("v0.9.2")).toEqual([0, 9, 2]);
		expect(versionOf("0.9.2")).toBeNull();
		expect(isAfter([0, 9, 1], LAST_UNILINGUAL)).toBe(false);
		expect(isAfter([0, 8, 9], LAST_UNILINGUAL)).toBe(false);
		expect(isAfter([0, 9, 2], LAST_UNILINGUAL)).toBe(true);
		expect(isAfter([0, 10, 0], LAST_UNILINGUAL)).toBe(true);
		expect(isAfter([1, 0, 0], LAST_UNILINGUAL)).toBe(true);
	});
});
