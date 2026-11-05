import { afterAll, beforeAll, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { mentionedFilesText } from "../../web/src/lib/messages.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

// The page's modules read localStorage as they load; load them after the stubs are in place.
installGlobals();
const { Markdown } = await import("../../web/src/components/Markdown.tsx");

/**
 * The "Read @file" note shows each mentioned file's text verbatim. A file with code fences of its own (most READMEs) must
 * not close the block it is shown in: the rest of it was rendered as Markdown, headings and links and all.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const rendered = (files: { path: string; content?: string }[]) =>
	renderToString(createElement(Markdown, { text: mentionedFilesText(files) }));

test("a file with code fences of its own is shown whole in one code block", () => {
	const html = rendered([{ path: "README.md", content: "# T\n```sh\nls\n```\nafter [link](https://example.com)" }]);
	expect(html.match(/<pre/g)?.length).toBe(1);
	expect(html).not.toContain("<h1");
	expect(html).not.toContain("<a ");
	expect(html).toContain("after [link](https://example.com)");
	expect(html).toContain("```sh");
});

test("a path with a backtick is shown whole as code", () => {
	const html = rendered([{ path: "odd`name.md", content: "text" }]);
	expect(html).toMatch(/<code[^>]*>odd`name\.md<\/code>/);
});
