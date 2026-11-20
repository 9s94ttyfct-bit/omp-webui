import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The Apple touch icon, written into the page itself for a page that came through the tunnel. Safari (iPhone, iPad and
 * Add to Dock on a Mac) fetches the icon of a Home Screen app without the page's cookies, so through the tunnel that
 * request has no `CF_Authorization` and Cloudflare Access answers it with its sign-in page before it reaches this
 * server: the app was saved with a letter for an icon. A `data:` URL needs no request at all (the page's
 * Content-Security-Policy allows `data:` images, `server/csp.ts`). The manifest's icons need nothing of the kind:
 * Chromium fetches them with the page's cookies.
 */

const LINK = /<link\b[^>]*\brel=["']apple-touch-icon["'][^>]*>/i;

let cached: { file: string; mtimeMs: number; url: string } | null = null;

/** `html` with its apple-touch-icon link pointing at `apple-touch-icon.png` of `distDir` as a `data:` URL. */
export function inlineTouchIcon(html: string, distDir: string): string {
	const file = join(distDir, "apple-touch-icon.png");
	try {
		const { mtimeMs } = statSync(file);
		if (cached?.file !== file || cached.mtimeMs !== mtimeMs) {
			cached = { file, mtimeMs, url: `data:image/png;base64,${readFileSync(file).toString("base64")}` };
		}
	} catch {
		return html; // no icon in the build: the link stays as it is
	}
	const url = cached.url;
	// A function, so that nothing in the URL is read as a replacement pattern.
	return html.replace(LINK, (link) => link.replace(/\bhref=["'][^"']*["']/i, () => `href="${url}"`));
}
