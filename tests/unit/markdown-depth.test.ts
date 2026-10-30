import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MAX_NESTING, type Nesting, nestsTooDeep, scanNesting } from "../../web/src/lib/markdown-depth.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

// The page's modules read localStorage as they load; load them after the stubs are in place.
installGlobals();
const { Markdown } = await import("../../web/src/components/Markdown.tsx");

/**
 * Text that nests block quotes, lists or open link and image labels deeper than anyone writes is shown as it is written:
 * rendering it overflowed the stack (a Reload screen; in Chrome a renderer crash on every reload), and parsing nested
 * lists and labels takes time that grows with the square of their depth.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const deepest = (text: string) => scanNesting(text).deepest;
const tooDeep = (text: string) => nestsTooDeep(scanNesting(text));
const repeat = (s: string, n: number) => s.repeat(n);

describe("what counts as nesting", () => {
	test("ordinary documents are nowhere near it", () => {
		const doc = [
			"# Title",
			"",
			"Some *text* with a [link](https://example.com) and `code`.",
			"",
			"> a quote",
			"> > a quote in a quote",
			"",
			"- one",
			"  - two",
			"    - three",
			"      1. four",
			"",
			"| a | b |",
			"| - | - |",
			"| [x] | `[[[` |",
			"",
			"[^1]: the note",
		].join("\n");
		expect(deepest(doc)).toBeLessThan(10);
		expect(tooDeep(doc)).toBe(false);
	});

	test("the limit is on the depth: MAX_NESTING levels render, one more does not", () => {
		expect(MAX_NESTING).toBe(100);
		expect(deepest(`${repeat("> ", MAX_NESTING)}x`)).toBe(MAX_NESTING);
		expect(tooDeep(`${repeat("> ", MAX_NESTING)}x`)).toBe(false);
		expect(tooDeep(`${repeat("> ", MAX_NESTING + 1)}x`)).toBe(true);
	});

	test("quotes without spaces, bullets, numbers and nesting by indentation all count", () => {
		expect(tooDeep(`${repeat(">", 1800)}x`)).toBe(true);
		expect(tooDeep(`${repeat("- ", 1000)}x`)).toBe(true);
		expect(tooDeep(`${repeat("1. ", 1000)}x`)).toBe(true);
		expect(tooDeep(`${repeat("* ", 500)}x`)).toBe(true);
		expect(tooDeep(`${repeat("+ ", 500)}x`)).toBe(true);
		expect(tooDeep(`${repeat("1) ", 500)}x`)).toBe(true);
		expect(tooDeep(`${repeat("> - ", 500)}x`)).toBe(true);
		// Each level of a list nested by indentation is a line of its own, two columns further in.
		const indented = (levels: number) =>
			Array.from({ length: levels }, (_, i) => `${repeat(" ", i * 2)}- item`).join("\n");
		expect(tooDeep(indented(60))).toBe(false);
		expect(tooDeep(indented(400))).toBe(true);
		// A footnote definition holds blocks, and they can start on its line.
		expect(tooDeep(`[^1]: ${repeat("> ", 500)}x`)).toBe(true);
		// Windows line endings are line breaks too.
		expect(tooDeep(indented(400).replaceAll("\n", "\r\n"))).toBe(true);
	});

	test("lines that only look like markers do not count", () => {
		expect(deepest(repeat("-", 500))).toBe(0);
		expect(deepest(repeat("=", 500))).toBe(0);
		expect(deepest(repeat("*", 500))).toBe(0);
		expect(deepest(`${repeat(" ", 300)}just a paragraph, or a code line`)).toBe(0);
		expect(deepest(repeat("1986. ", 1))).toBeLessThan(3);
		expect(deepest("1.5 is not a list, nor is 2.x")).toBe(0);
		expect(deepest("-no space after the dash")).toBe(0);
		expect(deepest("**bold** and _em_ at the start")).toBe(0);
	});

	test("code fences hold code: nothing inside one nests", () => {
		const fenced = ["```text", repeat(">", 600), repeat("[", 600), repeat("- ", 600), "```", "after"].join("\n");
		expect(deepest(fenced)).toBe(0);
		// A longer fence is not ended by a shorter one; a tilde fence is a fence.
		expect(deepest(["````", "```", repeat(">", 600), "````"].join("\n"))).toBe(0);
		expect(deepest(["~~~", repeat(">", 600), "~~~"].join("\n"))).toBe(0);
		// An unclosed fence runs to the end of the text.
		expect(deepest(["```", repeat(">", 600)].join("\n"))).toBe(0);
		// Text after the fence nests as usual.
		expect(tooDeep(["```", "x", "```", repeat(">", 600)].join("\n"))).toBe(true);
	});

	test("link and image labels left open count, within a paragraph", () => {
		expect(tooDeep(`${repeat("![a ", 101)}x`)).toBe(true);
		expect(tooDeep(`${repeat("[a ", 101)}x`)).toBe(true);
		expect(tooDeep(`${repeat("![a ", 100)}x`)).toBe(false);
		// Opened and closed one after another they never nest.
		expect(deepest(repeat("[a](u) ", 5000))).toBe(1);
		expect(deepest(repeat("[x] ", 5000))).toBe(1);
		// A blank line ends the paragraph; so does a fence.
		expect(deepest(`${repeat("[", 60)}\n\n${repeat("[", 60)}`)).toBe(60);
		expect(deepest(`${repeat("[", 60)}\n\`\`\`\n\`\`\`\n${repeat("[", 60)}`)).toBe(60);
		// An escaped bracket opens nothing.
		expect(deepest(repeat("\\[", 500))).toBe(0);
		// Across lines of one paragraph they still add up.
		expect(tooDeep(Array.from({ length: 101 }, () => "[a").join("\n"))).toBe(true);
	});
});

describe("scanning text as it grows", () => {
	const sample = [
		"# Heading",
		"",
		"```js",
		"const nested = [[[[1]]]];",
		"```",
		"",
		"> quote",
		"> > deeper [a ![b",
		"",
		"- [ ] item 1. 2) 3.",
		"  - nested",
		"",
		"[^n]: > note",
		repeat("> ", 130),
		"tail [open",
	].join("\n");

	const same = (a: Nesting, b: Nesting) => expect({ ...a, text: a.text.length }).toEqual({ ...b, text: b.text.length });

	test("reading on from the last line gives what reading the whole text gives, at every length", () => {
		let kept: Nesting | undefined;
		for (let n = 0; n <= sample.length; n++) {
			const text = sample.slice(0, n);
			kept = scanNesting(text, kept);
			same(kept, scanNesting(text));
		}
		expect(kept?.deepest).toBeGreaterThan(MAX_NESTING);
	});

	test("the same text is not scanned again, and text that is not an extension starts over", () => {
		const first = scanNesting(sample);
		expect(scanNesting(sample, first)).toBe(first);
		same(scanNesting("a short, different text", first), scanNesting("a short, different text"));
		expect(scanNesting("a short, different text", first).deepest).toBe(0);
	});
});

describe("what the page does with it", () => {
	const html = (text: string) => renderToString(createElement(Markdown, { text }));

	test("deep text is shown as written, with a note; it is neither parsed nor converted", () => {
		const text = `${repeat("> ", 20_000)}x <b>raw</b> & more`;
		const out = html(text);
		expect(out).toContain('data-testid="markdown-plain"');
		expect(out).toContain("Nested too deeply to format");
		expect(out).toContain("x &lt;b&gt;raw&lt;/b&gt; &amp; more");
		expect(out).not.toContain("<blockquote");
		for (const deep of [`${repeat("- ", 5000)}x`, `${repeat("![a ", 5000)}x${repeat("](u)", 5000)}`]) {
			expect(html(deep)).toContain('data-testid="markdown-plain"');
		}
	});

	test("text within the limit renders as Markdown, as before", () => {
		const out = html(`${repeat("> ", 50)}quoted`);
		expect(out).not.toContain("markdown-plain");
		expect(out.match(/<blockquote/g)?.length).toBe(50);
		expect(html("# Title\n\n- a\n- b")).toContain("<h1>Title</h1>");
	});
});
