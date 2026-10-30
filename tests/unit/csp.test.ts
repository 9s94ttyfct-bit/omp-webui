import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { contentSecurityPolicy, inlineScriptHashes } from "../../server/csp.ts";

/** The Content-Security-Policy: how the inline-script hashes are taken and what the Host header can add. */

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

test("inline scripts are hashed as the browser reads them; external scripts are not", () => {
	const theme = "const t = localStorage.getItem('theme');\ndocument.documentElement.dataset.theme = t;\n";
	const html = [
		'<script type="module" crossorigin src="/assets/index-abc.js"></script>',
		// A `>` inside an attribute value does not end the tag; the file may use CRLF line endings.
		`<script data-note="a>b">${theme.replaceAll("\n", "\r\n")}</script>`,
		'<script type="module">export {};</script>',
	].join("\n");

	expect(inlineScriptHashes(html)).toEqual([sha256(theme), sha256("export {};")]);
	expect(inlineScriptHashes("<html><body>no scripts</body></html>")).toEqual([]);
});

test("scripts are limited to the page and the hashes given; only a plain host is written into connect-src", () => {
	const csp = contentSecurityPolicy("127.0.0.1:7878", [sha256("a()")]);
	const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `));

	expect(directive("script-src")).toBe(`script-src 'self' ${sha256("a()")}`);
	// Nothing in the policy lets a script compile WebAssembly or evaluate a string.
	expect(csp).not.toContain("unsafe-eval");
	expect(directive("connect-src")).toBe("connect-src 'self' ws://127.0.0.1:7878 wss://127.0.0.1:7878");
	expect(directive("img-src")).toBe("img-src 'self' data: blob:");

	// Nothing from the Host header can add a source or a directive.
	for (const host of ["[::1]:7878", "evil.com; script-src *", "a b", "", null]) {
		const policy = contentSecurityPolicy(host, []);
		expect(policy).toContain("connect-src 'self'; ");
		expect(policy).not.toContain("script-src *");
	}
});
