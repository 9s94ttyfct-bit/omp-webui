import { describe, expect, test } from "bun:test";
import { signInLink, webUrl } from "../../web/src/lib/web-url.ts";

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
});

/** The sign-in link of Accounts, from omp's `open_url` (the authorization address, and a short loopback one that leads to it). */
describe("signInLink", () => {
	const codex = {
		url: "https://auth.openai.com/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s",
		launchUrl: "http://localhost:1455/launch",
	};

	test("on the computer omp runs on, the short launch address, and the browser's callback reaches omp by itself", () => {
		for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
			expect(signInLink(codex, host)).toEqual({ href: "http://localhost:1455/launch", pasteBack: false });
		}
	});

	test("from another device or a window onto another Mac, the authorization address, and the callback is pasted back", () => {
		// The launch address is the loopback of the computer omp runs on: from here it is this device's own, where nothing
		// listens (and a window onto another Mac refuses it), and so is the callback the provider sends the browser to.
		for (const host of ["omp.example.com", "192.168.1.5", "studio.local"]) {
			expect(signInLink(codex, host)).toEqual({ href: codex.url, pasteBack: true });
		}
	});

	test("a provider whose callback is a web page of its own needs nothing pasted back from anywhere", () => {
		const own = {
			url: "https://claude.ai/oauth/authorize?redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback",
			launchUrl: "http://localhost:54545/launch",
		};
		expect(signInLink(own, "omp.example.com")).toEqual({ href: own.url, pasteBack: false });
		expect(signInLink(own, "localhost")).toEqual({ href: own.launchUrl, pasteBack: false });
	});

	test("an address that is not a web address is never the link", () => {
		expect(signInLink({ url: "https://b.example/plain", launchUrl: "javascript:alert(1)" }, "localhost").href).toBe(
			"https://b.example/plain",
		);
		expect(signInLink({ url: "https://b.example/plain" }, "omp.example.com").href).toBe("https://b.example/plain");
		expect(signInLink({ url: "data:text/html,x", launchUrl: "javascript:alert(1)" }, "localhost").href).toBeNull();
		// A launch address that is a web page of its own works from anywhere.
		expect(
			signInLink({ url: "https://b.example/plain", launchUrl: "https://a.example/launch" }, "omp.example.com"),
		).toEqual({ href: "https://a.example/launch", pasteBack: false });
	});
});
