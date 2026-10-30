import { afterAll, beforeAll, expect, test } from "bun:test";
import type { IBufferRange } from "@xterm/xterm";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

// The page's modules read localStorage as they load; load them after the stubs are in place.
installGlobals();
const { terminalLinkHandler } = await import("../../web/src/lib/terminal-links.ts");

/**
 * A hyperlink in the terminal's output (OSC 8) is opened by address, after asking: xterm's own handler opens a blank
 * window and sets its location, which the macOS app drops (it hands a new window to the system's browser by the address
 * it is opened with). Only web addresses ever open.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const RANGE: IBufferRange = { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } };
const EVENT = new Event("click") as MouseEvent;

function click(text: string, answer: boolean) {
	const asked: string[] = [];
	const opened: string[] = [];
	const handler = terminalLinkHandler({
		ask: (message) => {
			asked.push(message);
			return answer;
		},
		open: (url) => void opened.push(url),
	});
	handler.activate(EVENT, text, RANGE);
	return { asked, opened, handler };
}

test("an agreed link is opened by its address, and the question names the address", () => {
	const { asked, opened } = click("https://example.com/docs?q=1#top", true);
	expect(opened).toEqual(["https://example.com/docs?q=1#top"]);
	expect(asked).toHaveLength(1);
	expect(asked[0]).toContain("https://example.com/docs?q=1#top");
	expect(asked[0]).toContain("Open this link in your browser?");
});

test("the address is shown as the browser reads it, not as the program wrote it", () => {
	const { asked, opened } = click("HTTP://Example.COM:80/a b", true);
	expect(opened).toEqual(["http://example.com/a%20b"]);
	expect(asked[0]).toContain("http://example.com/a%20b");
});

test("a declined link opens nothing", () => {
	const { asked, opened } = click("https://example.com/", false);
	expect(asked).toHaveLength(1);
	expect(opened).toEqual([]);
});

test("nothing but a web address is asked about or opened", () => {
	for (const text of [
		"javascript:alert(1)",
		"JaVaScRiPt:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"file:///etc/passwd",
		"ssh://evil.example",
		"mailto:a@b.example",
		"vbscript:msgbox(1)",
		"//evil.example/x",
		"/relative/path",
		"not a url",
		"",
	]) {
		const { asked, opened } = click(text, true);
		expect({ text, asked, opened }).toEqual({ text, asked: [], opened: [] });
	}
});

test("xterm is told to pass web addresses only", () => {
	expect(click("https://example.com/", true).handler.allowNonHttpProtocols).toBe(false);
});
