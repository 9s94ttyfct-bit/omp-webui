import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inlineTouchIcon } from "../../server/touch-icon.ts";

/**
 * A page that came through the tunnel carries its Apple touch icon as a `data:` URL: Safari fetches a Home Screen app's
 * icon without cookies, and Cloudflare Access turns that request away. Held against the real `index.html`, so a change to
 * its link that the server no longer finds fails here rather than on a phone.
 */

const WEB = join(import.meta.dirname, "../../web");
const html = readFileSync(join(WEB, "index.html"), "utf8");
const icon = readFileSync(join(WEB, "public", "apple-touch-icon.png"));

describe("inlineTouchIcon", () => {
	test("the page's touch icon becomes the icon's own bytes, and nothing else changes", () => {
		const out = inlineTouchIcon(html, join(WEB, "public"));
		const href = /<link\b[^>]*\brel="apple-touch-icon"[^>]*\bhref="data:image\/png;base64,([^"]+)"/.exec(out)?.[1];
		expect(href).toBeDefined();
		expect(Buffer.from(href as string, "base64").equals(icon)).toBe(true);
		expect(out.replace(/data:image\/png;base64,[^"]+/, "/apple-touch-icon.png")).toBe(html);
	});

	test("a build without the icon keeps the page as it is", () => {
		expect(inlineTouchIcon(html, join(WEB, "no-such-dir"))).toBe(html);
	});
});
