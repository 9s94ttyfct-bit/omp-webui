import { createHash } from "node:crypto";
import { exportGuard } from "./export-guard.ts";

/**
 * An exported conversation is a file the user opens from disk, mails or attaches to an issue, and it holds the whole
 * transcript, unredacted. `omp --export` writes it with raw HTML left in the model's Markdown and no Content-Security-
 * Policy, so a reply carrying `<img onerror=…>` ran script when the file was opened (and could send the transcript
 * anywhere), `![x](https://…)` fetched on open, and `<meta http-equiv=refresh>` navigated away.
 *
 * `hardenExport` puts two things first in the file's `<head>`, right after its charset declaration (which has to stay
 * within the first 1024 bytes):
 *  - a Content-Security-Policy `<meta>` that allows only the file's own inline scripts (by hash), the external scripts it
 *    pins with Subresource Integrity (by their exact address and that hash), inline styles and `data:` images, and no
 *    connection, frame, form, base or anything else;
 *  - the script of `export-guard.ts`, which makes the HTML the page builds inert even where a policy cannot (it shows
 *    raw HTML as text, refuses unsafe link and image addresses, and sanitises what is parsed into the document).
 *
 * A released omp (18.14 and later) does not inline its viewer: the file loads it, `marked` and `highlight.js` from
 * `build.stencil.so` and `stencil.so` when it is opened, each `<script src>` pinned by an `integrity` hash. Those, and only
 * those, are allowed: an external script without such a pin, or whose address is not a plain `https:` one the policy can
 * name exactly, stays refused, and so does any other request.
 */

const GUARD = `(${exportGuard.toString()})();`;

/** `script` types the browser runs: no `type`, an empty one, a JavaScript MIME type or `module`. */
const RUNS = /^(?:module|(?:text|application)\/(?:x-)?(?:javascript|ecmascript))$/i;

/** The CSP source of an inline script, as the browser hashes its text (line breaks become LF first). */
function sourceOf(text: string): string {
	return `'sha256-${createHash("sha256").update(text.replace(/\r\n?/g, "\n")).digest("base64")}'`;
}

/** What the page contains that the policy and the placement depend on. */
interface Scan {
	/**
	 * CSP sources of every script that runs: inline ones by hash (data blocks such as the session's JSON do not run),
	 * external ones pinned by Subresource Integrity by their exact address and their pinned hash.
	 */
	scripts: string[];
	charset: boolean;
	head: boolean;
}

/** An address the policy can allow exactly: `https:`, a host, a path, no query or fragment (CSP ignores those). */
const EXACT_URL = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/[\w.~%/-]*$/i;
/** One Subresource Integrity hash, as a CSP hash source spells it. */
const PIN = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

/** The CSP sources of an external script: its exact address and its pin, or none when it is not pinned exactly. */
function pinnedSources(src: string | null, integrity: string | null): string[] {
	const url = src?.trim() ?? "";
	const pin = integrity?.trim() ?? "";
	if (!EXACT_URL.test(url) || !PIN.test(pin)) return [];
	return [url, `'${pin}'`];
}

/** Read the document as a browser tokenises it, so that each script's text is what the browser will hash. */
async function scan(html: string): Promise<Scan> {
	const found: Scan = { scripts: [], charset: false, head: false };
	let script: { text: string; runs: boolean } | null = null;
	await new HTMLRewriter()
		.on("script", {
			element(el) {
				const type = el.getAttribute("type");
				const runs = type === null || type.trim() === "" || RUNS.test(type.trim());
				if (el.hasAttribute("src")) {
					if (runs) found.scripts.push(...pinnedSources(el.getAttribute("src"), el.getAttribute("integrity")));
					script = null;
					return;
				}
				script = { text: "", runs };
				el.onEndTag(() => {
					if (script?.runs) found.scripts.push(sourceOf(script.text));
					script = null;
				});
			},
			text(chunk) {
				if (script) script.text += chunk.text;
			},
		})
		.on("meta", {
			element(el) {
				if (el.hasAttribute("charset")) found.charset = true;
			},
		})
		.on("head", {
			element() {
				found.head = true;
			},
		})
		.transform(new Response(html))
		.text();
	return found;
}

/**
 * The policy of an export: the page's own scripts (`scripts`: inline ones by hash, pinned external ones by address and
 * hash) and styles, inline images, nothing else.
 */
export function exportPolicy(scripts: readonly string[]): string {
	return [
		"default-src 'none'",
		`script-src ${scripts.length > 0 ? scripts.join(" ") : "'none'"}`,
		"style-src 'unsafe-inline'",
		"img-src data:",
		"font-src data:",
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ");
}

/** `html` with the policy and the guard script put first in its head; the page's own scripts are allowed as `scan` found them. */
export async function hardenExport(html: string): Promise<string> {
	const { scripts, charset, head } = await scan(html);
	const policy = exportPolicy([...scripts, sourceOf(GUARD)]);
	const inject = `<meta http-equiv="Content-Security-Policy" content="${policy}"><script>${GUARD}</script>`;
	if (charset) {
		let done = false;
		return new HTMLRewriter()
			.on("meta", {
				element(el) {
					if (done || !el.hasAttribute("charset")) return;
					done = true;
					el.after(inject, { html: true });
				},
			})
			.transform(new Response(html))
			.text();
	}
	if (head) {
		return new HTMLRewriter()
			.on("head", {
				element(el) {
					el.prepend(inject, { html: true });
				},
			})
			.transform(new Response(html))
			.text();
	}
	return `<head>${inject}</head>${html}`;
}
