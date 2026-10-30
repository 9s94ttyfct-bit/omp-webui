/**
 * `value` as an address that is safe to put in a link or hand to the system's browser: an absolute `http:` or `https:` URL,
 * written out as the browser parses it. Null for anything else (`javascript:`, `data:`, `file:`, a custom scheme that opens
 * some other app, a relative address, nothing at all). The value may come from omp or an extension, which a page must not
 * trust: an `href` of `javascript:…` would run in this page, with the access token's cookie.
 */
export function webUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}
