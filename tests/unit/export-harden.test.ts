import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { exportPolicy, hardenExport } from "../../server/export-harden.ts";

/**
 * What an exported conversation carries before it is opened: a policy that allows only its own inline scripts, and the
 * guard script first. That the HTML it builds is inert is proved in a browser (tests/e2e/export-inert.spec.ts).
 */

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
const THEME = "try{localStorage.getItem('t')}catch{}";
const APP = "(function(){\r\n  'use strict';\r\n  const a = 1;\r\n})();";
const MARKED = "/* marked */ !function(){window.marked={}}();";

/** The shape of omp's export: charset first, a few metas, inline scripts, the session as a JSON data block. */
const EXPORT = [
	"<!DOCTYPE html>",
	'<html lang="en">',
	"<head>",
	'<meta charset="UTF-8">',
	'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
	`<script>${THEME}</script>`,
	'<script id="session-data" type="application/json">eyJoZWFkZXIiOnt9fQ==</script>',
	`<script>${MARKED}</script>`,
	'<script src="https://cdn.example/x.js"></script>',
	"</head>",
	`<body><script>${APP}</script></body>`,
	"</html>",
].join("\n");

const policyOf = (html: string) => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? "";
const directive = (policy: string, name: string) => policy.split("; ").find((d) => d.startsWith(`${name} `));

test("the policy and the guard come right after the charset, before every other script", async () => {
	const out = await hardenExport(EXPORT);
	const charset = out.indexOf('<meta charset="UTF-8">');
	const policy = out.indexOf('http-equiv="Content-Security-Policy"');
	const guard = out.indexOf("<script>(function exportGuard()");
	expect(charset).toBeGreaterThan(-1);
	expect(charset).toBeLessThan(1024);
	expect(policy).toBeGreaterThan(charset);
	expect(guard).toBeGreaterThan(policy);
	// Nothing runs, and nothing is read from the network, before they are in force.
	expect(out.indexOf(`<script>${THEME}</script>`)).toBeGreaterThan(guard);
	expect(out.indexOf('<script id="session-data"')).toBeGreaterThan(guard);
	// The rest of the file is untouched.
	expect(out.replace(/<meta http-equiv="Content-Security-Policy"[^>]*><script>[\s\S]*?<\/script>/, "")).toBe(EXPORT);
});

test("scripts are allowed by hash, as the browser hashes them; data blocks and external scripts are not", async () => {
	const out = await hardenExport(EXPORT);
	const policy = policyOf(out);
	const guard = /<meta http-equiv="Content-Security-Policy"[^>]*><script>([\s\S]*?)<\/script>/.exec(out)?.[1] ?? "";
	expect(guard).toContain("exportGuard");

	const sources = directive(policy, "script-src")?.split(" ").slice(1);
	// Line breaks become LF before hashing, whatever the file has.
	expect(sources).toEqual([sha256(THEME), sha256(MARKED), sha256(APP.replaceAll("\r\n", "\n")), sha256(guard)]);
	expect(sources).not.toContain(sha256("eyJoZWFkZXIiOnt9fQ=="));
	expect(policy).not.toContain("cdn.example");
});

test("everything but the page's own inline scripts and styles and inline images is refused", async () => {
	const policy = policyOf(await hardenExport(EXPORT));
	expect(directive(policy, "default-src")).toBe("default-src 'none'");
	expect(directive(policy, "style-src")).toBe("style-src 'unsafe-inline'");
	expect(directive(policy, "img-src")).toBe("img-src data:");
	expect(directive(policy, "base-uri")).toBe("base-uri 'none'");
	expect(directive(policy, "form-action")).toBe("form-action 'none'");
	// No script source but the hashes: no 'self', no 'unsafe-inline', no eval.
	expect(directive(policy, "script-src")).not.toMatch(/'self'|'unsafe-|https?:|data:/);
	expect(directive(policy, "connect-src")).toBeUndefined();
	expect(exportPolicy([])).toContain("script-src 'none'");
});

test("the guard is plain JavaScript that cannot end its own script element", async () => {
	const out = await hardenExport(EXPORT);
	const guard = /<meta http-equiv="Content-Security-Policy"[^>]*><script>([\s\S]*?)<\/script>/.exec(out)?.[1] ?? "";
	// It parses as a script (no TypeScript left in it), and nothing in it ends or double-escapes a script element.
	expect(() => new Function(guard)).not.toThrow();
	expect(guard).not.toMatch(/<\/script/i);
	expect(guard).not.toContain("<!--");
	expect(guard.trim().endsWith(")();")).toBe(true);
});

test("a file without a charset still gets the policy first in its head; one without a head at the very start", async () => {
	const noCharset = await hardenExport("<html><head><title>t</title><script>a()</script></head><body></body></html>");
	expect(noCharset.indexOf("<head><meta http-equiv")).toBeGreaterThan(-1);
	expect(directive(policyOf(noCharset), "script-src")).toContain(sha256("a()"));

	const bare = await hardenExport("<p>just a paragraph</p><script>b()</script>");
	expect(bare.startsWith("<head><meta http-equiv")).toBe(true);
	expect(directive(policyOf(bare), "script-src")).toContain(sha256("b()"));
});

test("where a script ends is decided as the browser's tokeniser decides, not by the first end tag", async () => {
	// After `<!--<script>` the first `</script>` only leaves the double-escaped state: the element runs to the second one.
	const text = "var s = '<!--<script>'; </script> still_script();";
	const out = await hardenExport(
		`<html><head><meta charset="utf-8"><script>${text}</script><p>after</p></head></html>`,
	);
	const sources = directive(policyOf(out), "script-src")?.split(" ").slice(1);
	expect(sources).toContain(sha256(text));
	expect(sources).not.toContain(sha256("var s = '<!--<script>'; "));
});
