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
 *  - a Content-Security-Policy `<meta>` that allows only the file's own inline scripts (by hash), inline styles and
 *    `data:` images, and no connection, frame, form, base or anything else;
 *  - the script of `export-guard.ts`, which makes the HTML the page builds inert even where a policy cannot (it shows
 *    raw HTML as text, refuses unsafe link and image addresses, and sanitises what is parsed into the document).
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
	/** CSP sources of every inline script that runs (data blocks such as the session's JSON do not). */
	scripts: string[];
	charset: boolean;
	head: boolean;
}

/** Read the document as a browser tokenises it, so that each script's text is what the browser will hash. */
async function scan(html: string): Promise<Scan> {
	const found: Scan = { scripts: [], charset: false, head: false };
	let script: { text: string; runs: boolean } | null = null;
	await new HTMLRewriter()
		.on("script", {
			element(el) {
				const type = el.getAttribute("type");
				script = {
					text: "",
					runs: !el.hasAttribute("src") && (type === null || type.trim() === "" || RUNS.test(type.trim())),
				};
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

/** The policy of an export: the page's own inline scripts (`scripts`, by hash) and styles, inline images, nothing else. */
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

/** `html` with the policy and the guard script put first in its head; the page's own scripts are allowed by hash. */
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
