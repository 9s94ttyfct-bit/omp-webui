import { expect, test } from "bun:test";
import { SNIPPET_CLOSE, SNIPPET_OPEN, shortSnippet } from "../../server/search-snippet.ts";

/** The snippet of a hit of a 1-2 character query (#299): every match marked, `…` where the text goes on. */

const mark = (s: string) => `${SNIPPET_OPEN}${s}${SNIPPET_CLOSE}`;

test("every match in the window is marked, in the case the text has it", () => {
	expect(shortSnippet("Zebra, zebra and ZEBRA", "ze", 1, 22)).toBe(
		`${mark("Ze")}bra, ${mark("ze")}bra and ${mark("ZE")}BRA`,
	);
	expect(shortSnippet("斑马协议和斑马线", "斑马", 1, 8)).toBe(`${mark("斑马")}协议和${mark("斑马")}线`);
});

test("matches that touch are marked one after the other, and a text without a match is left alone", () => {
	expect(shortSnippet("aaaa", "aa", 1, 4)).toBe(`${mark("aa")}${mark("aa")}`);
	expect(shortSnippet("plain text", "zz", 1, 10)).toBe("plain text");
});

test("… stands where the text goes on past the window, at either end", () => {
	// `start` is where the window begins in the text (1-based); `total` is how long the text is.
	expect(shortSnippet("xx ab yy", "ab", 1, 8)).toBe(`xx ${mark("ab")} yy`);
	expect(shortSnippet("xx ab yy", "ab", 11, 8 + 10)).toBe(`…xx ${mark("ab")} yy`);
	expect(shortSnippet("xx ab yy", "ab", 1, 100)).toBe(`xx ${mark("ab")} yy…`);
	expect(shortSnippet("xx ab yy", "ab", 41, 100)).toBe(`…xx ${mark("ab")} yy…`);
	// The window ends exactly where the text does: nothing is cut.
	expect(shortSnippet("xx ab yy", "ab", 3, 10)).toBe(`…xx ${mark("ab")} yy`);
});

test("a text's own marker characters cannot make a mark of their own, and astral characters count as one", () => {
	expect(shortSnippet(`x${SNIPPET_OPEN}y${SNIPPET_CLOSE}z ab`, "ab", 1, 8)).toBe(`xyz ${mark("ab")}`);
	// "𠮷" is one character in SQLite's `length`, two UTF-16 units in the window: the window reaches the text's end.
	expect(shortSnippet("𠮷a", "a", 1, 2)).toBe(`𠮷${mark("a")}`);
});

test("only A-Z fold, as in SQLite's lower(): the scan chose its rows with it", () => {
	expect(shortSnippet("Éa éa", "éa", 1, 5)).toBe(`Éa ${mark("éa")}`);
});
