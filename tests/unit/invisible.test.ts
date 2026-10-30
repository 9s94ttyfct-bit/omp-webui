import { afterAll, beforeAll, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { codePoint, marker, pieces, revealed } from "../../web/src/lib/invisible.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

// The page's modules read localStorage as they load; load them after the stubs are in place.
installGlobals();
const { Revealed } = await import("../../web/src/components/Revealed.tsx");

/**
 * A tool approval is the one place a person decides on text they read. Characters that do not show, or that change how
 * text shows, are written out: `echo ok ;tnatropmi/~ fr- mr` under a right-to-left override reads `echo ok rm -rf ~/important;`.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const RLO = "\u202E";
const PDF = "\u202C";

test("bidi controls, zero-width characters, escapes and odd spaces become markers", () => {
	expect(revealed(`echo ok ${RLO};tnatropmi/~ fr- mr${PDF}`)).toBe(
		"echo ok ⟨U+202E RLO⟩;tnatropmi/~ fr- mr⟨U+202C PDF⟩",
	);
	expect(revealed("ba\u200Bsh")).toBe("ba⟨U+200B ZWSP⟩sh");
	expect(revealed("\u2066x\u2069")).toBe("⟨U+2066 LRI⟩x⟨U+2069 PDI⟩");
	expect(revealed("a\u200C\u200D\u200E\u200F\u2060\uFEFFb")).toBe(
		"a⟨U+200C ZWNJ⟩⟨U+200D ZWJ⟩⟨U+200E LRM⟩⟨U+200F RLM⟩⟨U+2060 WJ⟩⟨U+FEFF BOM⟩b",
	);
	expect(revealed("\u001b[2J rm")).toBe("⟨U+001B ESC⟩[2J rm");
	expect(revealed("a\rb")).toBe("a⟨U+000D CR⟩b");
	expect(revealed("ls\u00A0-la")).toBe("ls⟨U+00A0 NBSP⟩-la");
	expect(revealed("a\u3000b")).toBe("a⟨U+3000⟩b");
	expect(revealed("a\u2028b")).toBe("a⟨U+2028 LS⟩b");
	// Beyond the BMP: a tag character (invisible text) and a variation selector.
	expect(revealed("a\u{E0041}b")).toBe("a⟨U+E0041⟩b");
	expect(revealed("a\u{E0100}b")).toBe("a⟨U+E0100⟩b");
	expect(revealed("a\u0000b\u007Fc")).toBe("a⟨U+0000 NUL⟩b⟨U+007F DEL⟩c");
});

test("what shows stays text: letters of every script, symbols, emoji, spaces, tabs, line breaks", () => {
	const plain = "echo 'héllo wörld' | tr a-z A-Z\n\tls -la\n日本語のテキスト 😀 ✓ → €\n";
	expect(revealed(plain)).toBe(plain);
	expect(pieces(plain)).toEqual([plain]);
	expect(pieces("")).toEqual([]);
});

test("pieces keep the order of the text and name each character by its code point", () => {
	expect(pieces(`a${RLO}b\u200Bc`)).toEqual(["a", { code: 0x202e }, "b", { code: 0x200b }, "c"]);
	expect(pieces(`${RLO}${PDF}`)).toEqual([{ code: 0x202e }, { code: 0x202c }]);
	expect(codePoint(0xa0)).toBe("U+00A0");
	expect(codePoint(0xe0041)).toBe("U+E0041");
	expect(marker(0x1f)).toBe("⟨U+001F⟩");
});

test("the page shows each one as a marker of its own and no longer carries the character", () => {
	const out = renderToString(createElement(Revealed, { text: `echo ${RLO}x${PDF}` }));
	expect(out.match(/data-testid="invisible-char"/g)?.length).toBe(2);
	expect(out).toContain("⟨U+202E RLO⟩");
	expect(out).toContain("⟨U+202C PDF⟩");
	expect(out).toContain("A character that does not show: U+202E");
	expect(out).not.toContain(RLO);
	expect(out).not.toContain(PDF);
	expect(renderToString(createElement(Revealed, { text: "plain" }))).toBe("plain");
});
