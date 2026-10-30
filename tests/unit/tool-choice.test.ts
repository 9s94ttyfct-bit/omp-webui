import { expect, test } from "bun:test";
import { MAX_CHOICES, rememberToolChoice, toolChoice } from "../../web/src/lib/tool-choice.ts";

/** A card's hand-made open or fold outlives the card being drawn anew; the memory is bounded to the latest choices. */

test("a choice is kept either way, and a card never chosen has none", () => {
	rememberToolChoice("tc-open", true);
	rememberToolChoice("tc-fold", false);
	expect(toolChoice("tc-open")).toBe(true);
	expect(toolChoice("tc-fold")).toBe(false);
	expect(toolChoice("tc-never")).toBeNull();
	rememberToolChoice("tc-open", false);
	expect(toolChoice("tc-open")).toBe(false);
});

test("only the latest choices are kept; one made again counts as the newest", () => {
	rememberToolChoice("keep-fresh", true);
	for (let i = 0; i < MAX_CHOICES - 1; i++) rememberToolChoice(`fill-${i}`, true);
	rememberToolChoice("keep-fresh", true);
	for (let i = 0; i < 50; i++) rememberToolChoice(`more-${i}`, false);
	expect(toolChoice("keep-fresh")).toBe(true);
	expect(toolChoice("fill-0")).toBeNull();
	expect(toolChoice("more-49")).toBe(false);
});
