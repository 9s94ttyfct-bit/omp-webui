import { afterAll, beforeAll, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

// The page's modules read localStorage as they load; load them after the stubs are in place.
installGlobals();
const { Kbd } = await import("../../web/src/components/ui.tsx");

/**
 * A key cap shows the letters of a key in the code face and the modifier symbols (⌘, ⇧, ↵) in the interface's own
 * face: in a monospace font the symbols are drawn at about half the height of the letters beside them, so a cap read
 * as a small sign next to a letter.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const html = (text: string) => renderToString(createElement(Kbd, null, text));

test("the modifier symbols are drawn in the interface's face", () => {
	const rendered = html("⌘⇧O");
	expect(rendered).toContain("font-sans");
	// The symbol itself is inside the span that has the face.
	expect(rendered).toMatch(/<span class="font-sans">⌘<\/span>/);
	expect(rendered).toMatch(/<span class="font-sans">⇧<\/span>/);
});

test("the letters stay in the code face", () => {
	const rendered = html("⌘⇧O");
	// The cap itself is the code face; only the symbols leave it.
	expect(rendered).toMatch(/<kbd class="[^"]*font-mono[^"]*"/);
	// The letter is in a span of its own, without the interface's face.
	expect(rendered).toMatch(/<span>O<\/span>/);
});

test("a cap without a modifier symbol is left alone", () => {
	const rendered = html("K");
	expect(rendered).not.toContain("font-sans");
	expect(rendered).toContain("K");
});

test("the whole cap is still one caption", () => {
	// The caption is the floor of the type scale; the cap is on it.
	expect(html("⌘K")).toContain("text-xs");
});
