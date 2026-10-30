import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { linkTarget } from "../../web/src/lib/link-target.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

// The page's modules read localStorage as they load; load them after the stubs are in place.
installGlobals();
const { Markdown } = await import("../../web/src/components/Markdown.tsx");

/**
 * A link opens in a window of its own, so it must name somewhere else. A relative path, the empty address react-markdown
 * leaves for a scheme it refuses, and a `#` anchor name this page: a click opened a second copy of the app in a browser
 * (and nothing in the macOS app). Those are shown as text; a footnote reference scrolls within its message.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

describe("linkTarget", () => {
	test("web and mail addresses open elsewhere, written as the browser reads them", () => {
		expect(linkTarget("https://example.com/a?b=1#c")).toEqual({ kind: "open", href: "https://example.com/a?b=1#c" });
		expect(linkTarget("HTTP://Example.COM:80/a b")).toEqual({ kind: "open", href: "http://example.com/a%20b" });
		expect(linkTarget("mailto:a@example.com?subject=hi")).toEqual({
			kind: "open",
			href: "mailto:a@example.com?subject=hi",
		});
		// Another host, on the page's scheme: opened over https.
		expect(linkTarget("//example.com/p.png")).toEqual({ kind: "open", href: "https://example.com/p.png" });
	});

	test("footnote references and their way back stay on the page", () => {
		expect(linkTarget("#user-content-fn-1")).toEqual({ kind: "anchor", id: "user-content-fn-1" });
		expect(linkTarget("#user-content-fnref-1-2")).toEqual({ kind: "anchor", id: "user-content-fnref-1-2" });
		expect(linkTarget("#user-content-fn-%C3%A9")).toEqual({ kind: "anchor", id: "user-content-fn-é" });
		expect(linkTarget("#user-content-fn-%")).toEqual({ kind: "none" });
	});

	test("everything else has nowhere to go", () => {
		for (const href of [
			undefined,
			"",
			"docs/README.md",
			"./b.ts",
			"../up.ts",
			"/tmp/project/src/a.ts#L10",
			"src/a.ts#L10",
			"/\\evil.example/x",
			"#heading",
			"#",
			"C:/Users/me/a.txt",
			"docs/a:b.md",
			"javascript:alert(1)",
			"JaVaScRiPt:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"file:///etc/passwd",
			"ssh://evil.example",
			"irc://evil.example/chan",
			"xmpp:a@example.com",
			"tel:+15551234567",
			"vbscript:msgbox(1)",
		]) {
			expect({ href, target: linkTarget(href) }).toEqual({ href, target: { kind: "none" } });
		}
	});
});

describe("what the page renders", () => {
	const html = (text: string) => renderToString(createElement(Markdown, { text }));

	test("a web link is a link in a window of its own; nothing else is an anchor", () => {
		const out = html(
			[
				"[web](https://example.com/a)",
				"[mail](mailto:a@example.com)",
				"[readme](docs/README.md)",
				"[handler](/tmp/p/src/a.ts#L10)",
				"[script](javascript:alert(1))",
				"[phone](tel:+1555)",
				"[chat](irc://evil.example/c)",
				"[empty]()",
			].join(" "),
		);
		const anchors = [...out.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
		expect(anchors).toHaveLength(2);
		expect(anchors[0]).toContain('href="https://example.com/a"');
		expect(anchors[0]).toContain('target="_blank"');
		expect(anchors[0]).toContain('rel="noreferrer noopener"');
		expect(anchors[1]).toContain('href="mailto:a@example.com"');
		// The rest read as text; a path is kept as a hint.
		expect(out).toContain('<span class="md-ref" title="docs/README.md">readme</span>');
		expect(out).toContain('<span class="md-ref" title="/tmp/p/src/a.ts#L10">handler</span>');
		expect(out).toContain("<span>script</span>");
		expect(out).toContain("<span>phone</span>");
		expect(out).toContain('<span class="md-ref" title="irc://evil.example/c">chat</span>');
		expect(out).not.toContain('href=""');
		expect(out).not.toContain("javascript:");
	});

	test("footnotes are buttons that scroll within the message, not links", () => {
		const out = html("A claim[^1].\n\n[^1]: The source.");
		expect(out.match(/data-testid="md-anchor"/g)?.length).toBe(2);
		expect(out).toContain('id="user-content-fn-1"');
		expect(out).toContain('id="user-content-fnref-1"');
		expect(out).not.toContain("<a ");
	});

	test("an image that does not load is a link only to a web address", () => {
		const out = html(
			"![remote](https://example.com/a.png) ![scheme](//example.com/b.png) ![file](/favicon.png) ![script](javascript:alert(1))",
		);
		const anchors = [...out.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
		expect(anchors).toHaveLength(2);
		expect(anchors[0]).toContain('href="https://example.com/a.png"');
		expect(anchors[1]).toContain('href="https://example.com/b.png"');
		expect(out).toContain("<span>file</span>");
		expect(out).toContain("<span>script</span>");
		expect(out).not.toContain("<img");
	});
});
