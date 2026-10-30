import { expect, test } from "bun:test";
import { stripAnsi } from "../../web/src/lib/ansi.ts";

/** Output of omp's local commands (`/context`) is written for a terminal; the page shows it as text. */

test("colour and style sequences are removed and the text between them is kept", () => {
	const raw =
		"Context window: 100000 tokens (11% used)\n" +
		"  System prompt    [\u001b[38;2;107;114;128m█░░░\u001b[39m\u001b[1m\u001b[38;2;0;180;255m░░\u001b[22m\u001b[39m] 4%  4081 tokens";
	expect(stripAnsi(raw)).toBe("Context window: 100000 tokens (11% used)\n  System prompt    [█░░░░░] 4%  4081 tokens");
});

test("cursor movement and erase sequences go too", () => {
	expect(stripAnsi("\u001b[2K\u001b[1Gdone\u001b[0m")).toBe("done");
});

test("hyperlink and title sequences are removed, whichever way they end", () => {
	expect(stripAnsi("\u001b]8;;https://example.com\u0007docs\u001b]8;;\u0007")).toBe("docs");
	expect(stripAnsi("\u001b]0;title\u001b\\after")).toBe("after");
});

test("text without escape sequences comes back as it was", () => {
	const text = "line one\n\tindented ✓ 日本語 [not a sequence] 50% {x}\r\n";
	expect(stripAnsi(text)).toBe(text);
});
