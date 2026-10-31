import { describe, expect, test } from "bun:test";
import { findSection, Slugger, sectionIds, slug } from "../../web/src/lib/slug.ts";

/**
 * The ids the Markdown editor's preview gives headings (audit A-012): GitHub's, so that a table of contents and a link into
 * another file's section written for GitHub find their heading here too. The cases are github-slugger's own fixtures
 * (the slugger GitHub's rendering follows) and what GitHub shows for the same headings.
 */

describe("slug", () => {
	test("lowercased, punctuation and symbols out, each space a hyphen (github-slugger's fixtures)", () => {
		const cases: [string, string][] = [
			["Hello World", "hello-world"],
			["Install", "install"],
			["Getting Started!", "getting-started"],
			["foo  bar", "foo--bar"],
			["  leading and trailing  ", "--leading-and-trailing--"],
			["Snake_case and kebab-case", "snake_case-and-kebab-case"],
			["What's new in v0.14.0?", "whats-new-in-v0140"],
			["C++ & C#", "c--c"],
			["`code` in a heading", "code-in-a-heading"],
			["Ünïcödé", "ünïcödé"],
			["中文标题", "中文标题"],
			["Привет мир", "привет-мир"],
			["😄 emoji", "-emoji"],
			["a/b.c:d", "abcd"],
			["", ""],
		];
		for (const [text, want] of cases) expect({ text, slug: slug(text) }).toEqual({ text, slug: want });
	});

	test("a repeated heading is numbered, and never takes a slug a heading already has", () => {
		const s = new Slugger();
		expect(["foo", "foo", "foo-1", "foo", "Foo", "bar"].map((t) => s.slug(t))).toEqual([
			"foo",
			"foo-1",
			"foo-1-1",
			"foo-2",
			"foo-3",
			"bar",
		]);
		// Each text starts its own count.
		expect(new Slugger().slug("foo")).toBe("foo");
	});
});

describe("finding the heading a link names", () => {
	test("GitHub's prefixed id first, then the fragment as written, each also lowercased", () => {
		expect(sectionIds("install")).toEqual(["user-content-install", "install"]);
		expect(sectionIds("Install")).toEqual(["user-content-Install", "Install", "user-content-install", "install"]);
	});

	test("the first element with one of those ids", () => {
		const els = [{ id: "user-content-install" }, { id: "intro" }, { id: "user-content-install" }];
		const root = { querySelectorAll: () => els } as unknown as ParentNode;
		expect(findSection(root, "install")).toBe(els[0] as unknown as HTMLElement);
		expect(findSection(root, "Install")).toBe(els[0] as unknown as HTMLElement);
		expect(findSection(root, "intro")).toBe(els[1] as unknown as HTMLElement);
		expect(findSection(root, "missing")).toBeNull();
	});
});
