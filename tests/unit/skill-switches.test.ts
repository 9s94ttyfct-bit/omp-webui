import { describe, expect, test } from "bun:test";
import { mergeSkills, withDisabledList } from "../../server/omp/skill-switches.ts";
import { switched } from "../../server/omp/toggles.ts";

const listed = (name: string) => ({
	name,
	description: null,
	provider: "custom",
	level: "user",
	path: `/skills/${name}/SKILL.md`,
	hidden: false,
	registry: null,
});

describe("a project's disabledExtensions, edited in place", () => {
	test("a block list is replaced up to the next key; comments and the other keys stay", () => {
		const text = "# top\ndisabledExtensions:\n  - skill:a\n  - skill:b\nmodel: x # keep\n\n# end\n";
		expect(withDisabledList(text, ["skill:c"])).toBe(
			'# top\ndisabledExtensions:\n  - "skill:c"\nmodel: x # keep\n\n# end\n',
		);
	});

	test("a flow list is replaced; taking it out leaves the rest", () => {
		const text = "disabledExtensions: [skill:a]\ntheme: dark\n";
		expect(withDisabledList(text, [])).toBe("disabledExtensions: []\ntheme: dark\n");
		expect(withDisabledList(text, null)).toBe("theme: dark\n");
	});

	test("added to a file without a final newline, and to an empty one", () => {
		expect(withDisabledList("theme: dark", ["skill:a"])).toBe('theme: dark\ndisabledExtensions:\n  - "skill:a"\n');
		expect(withDisabledList("", [])).toBe("disabledExtensions: []\n");
	});

	test("what it cannot rewrite safely throws, leaving the decision to the caller", () => {
		// A file whose top level is not a mapping; an anchor whose removal would change what another key reads.
		expect(() => withDisabledList("- a\n", ["skill:a"])).toThrow();
		expect(() => withDisabledList("disabledExtensions: &x [skill:a]\nother: *x\n", [])).toThrow();
	});
});

test("switched: several names on or off, the list's order and other ids kept", () => {
	expect(switched(["plugin:p", "skill:a"], ["b", "a"], false)).toEqual(["plugin:p", "skill:a", "skill:b"]);
	expect(switched(["skill:a", "plugin:p", "skill:b"], ["a", "b"], true)).toEqual(["plugin:p"]);
});

test("mergeSkills: listed here first, then everywhere, then off and not found, each list's state", () => {
	const merged = mergeSkills([listed("a")], [listed("a"), listed("b")], ["skill:b", "skill:gone"], ["skill:a"]);
	expect(merged.map((s) => [s.name, s.offGlobally, s.offInProject, s.nameOnly])).toEqual([
		["a", false, true, false],
		["b", true, false, false],
		["gone", true, false, true],
	]);
});
