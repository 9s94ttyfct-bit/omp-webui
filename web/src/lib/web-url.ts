import { classifyHost, classifyUrl } from "@shared/offline.ts";

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

/**
 * The link Accounts shows for omp's `open_url` (`url`, the provider's authorization address, and `launchUrl`, a short loopback
 * one that leads to it), from a page whose host is `pageHost`, and whether the person must paste the provider's callback back.
 *
 * A loopback address is the loopback of the computer omp runs on. From a page on that computer the launch address works, and so
 * does a callback to omp's own loopback listener. From any other device (remote access, a window onto another Mac in the app)
 * the launch address would be that device's own loopback, where nothing listens (a window onto another Mac refuses it outright),
 * so the link is the authorization address itself; and the provider's callback lands there too, on a page that does not load,
 * whose address is what omp asks for ("the authorization code or full redirect URL").
 */
export function signInLink(
	open: { url: string; launchUrl?: string },
	pageHost: string,
): { href: string | null; pasteBack: boolean } {
	const here = classifyHost(pageHost) === "loopback";
	const launch = webUrl(open.launchUrl);
	const href = launch && (here || classifyUrl(launch) !== "loopback") ? launch : (webUrl(open.url) ?? null);
	let callback: string | null = null;
	try {
		callback = new URL(open.url).searchParams.get("redirect_uri");
	} catch {
		// Not an address: there is no link, and nothing to say about a callback.
	}
	return { href, pasteBack: !here && callback !== null && classifyUrl(callback) === "loopback" };
}
