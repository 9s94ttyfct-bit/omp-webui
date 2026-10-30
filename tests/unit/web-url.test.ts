import { describe, expect, test } from "bun:test";
import { webUrl } from "../../web/src/lib/web-url.ts";

/** An address omp or an extension sends (the sign-in page) is a link only when it is a web address. */

describe("webUrl", () => {
	test.each([
		[
			"https",
			"https://claude.ai/oauth/authorize?code=true&client_id=x",
			"https://claude.ai/oauth/authorize?code=true&client_id=x",
		],
		["http", "http://localhost:1455/auth/callback", "http://localhost:1455/auth/callback"],
		["scheme in capitals", "HTTPS://Example.COM/a b", "https://example.com/a%20b"],
		["surrounding whitespace", "  https://example.com/x \n", "https://example.com/x"],
	])("passes %s, written as the browser parses it", (_what, value, expected) => {
		expect(webUrl(value)).toBe(expected);
	});

	test.each([
		["javascript:", "javascript:alert(document.cookie)"],
		["javascript: in capitals", "JaVaScRiPt:alert(1)"],
		["javascript: after whitespace", " \tjavascript:alert(1)"],
		["javascript: with a tab inside (the URL parser drops it)", "java\tscript:alert(1)"],
		["javascript: behind a web-looking comment", "javascript://example.com/%0aalert(1)"],
		["data:", "data:text/html,<script>alert(1)</script>"],
		["vbscript:", "vbscript:msgbox(1)"],
		["file:", "file:///etc/passwd"],
		["blob:", "blob:https://example.com/0a1b"],
		["ftp:", "ftp://example.com/x"],
		["mailto:", "mailto:me@example.com"],
		["a custom scheme that opens another app", "x-apple.systempreferences:com.apple.preference.security"],
		["ssh:", "ssh://host/"],
		["a relative address", "/oauth/authorize"],
		["a protocol-relative address", "//example.com/x"],
		["text", "not a url"],
		["an empty string", ""],
		["only whitespace", "   "],
	])("refuses %s", (_what, value) => {
		expect(webUrl(value)).toBeNull();
	});

	test("refuses what is not there", () => {
		expect(webUrl(undefined)).toBeNull();
		expect(webUrl(null)).toBeNull();
	});

	test("the first of several addresses that passes is the one to use", () => {
		// What Accounts does: the launch address when it is a web address, else the plain one.
		const pick = (launch: string | undefined, plain: string | undefined) => webUrl(launch) ?? webUrl(plain);
		expect(pick("https://a.example/launch", "https://b.example/plain")).toBe("https://a.example/launch");
		expect(pick("javascript:alert(1)", "https://b.example/plain")).toBe("https://b.example/plain");
		expect(pick(undefined, "https://b.example/plain")).toBe("https://b.example/plain");
		expect(pick("javascript:alert(1)", "data:text/html,x")).toBeNull();
		expect(pick(undefined, undefined)).toBeNull();
	});
});
