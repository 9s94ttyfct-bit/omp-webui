import { expect, test } from "bun:test";
import { atEnd, outputTail, toolOpen } from "../../web/src/lib/tool-open.ts";

/** A tool card is open while its tool runs and folded after; what the reader chose by hand wins, whichever way. */

test("with no choice a card is open exactly while its tool runs", () => {
	expect(toolOpen(null, false)).toBe(false);
	expect(toolOpen(null, true)).toBe(true);
});

test("a hand-made choice holds while the tool runs and after it ends", () => {
	// Folded by hand while it runs: stays folded.
	expect(toolOpen(false, true)).toBe(false);
	expect(toolOpen(false, false)).toBe(false);
	// Opened by hand (before it ran, or after): stays open when it ends.
	expect(toolOpen(true, true)).toBe(true);
	expect(toolOpen(true, false)).toBe(true);
});

test("a running tool's output keeps its newest characters; a short one is whole", () => {
	expect(outputTail("abc", 10)).toBe("abc");
	expect(outputTail("0123456789", 10)).toBe("0123456789");
	const tail = outputTail("0123456789abcdef", 10);
	expect(tail).toBe("…\n6789abcdef");
});

test("a box scrolled to within a few pixels of its end is followed", () => {
	expect(atEnd({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
	expect(atEnd({ scrollHeight: 1000, scrollTop: 580, clientHeight: 400 })).toBe(true);
	expect(atEnd({ scrollHeight: 1000, scrollTop: 400, clientHeight: 400 })).toBe(false);
});
