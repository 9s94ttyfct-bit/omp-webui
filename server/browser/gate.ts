import type { RemoteIdentity } from "../remote-auth.ts";

/**
 * Whether a page may install, update and clear the built-in browser: it is on this computer, or signed in as the person
 * through Cloudflare Access. A page holding only the server's token (or nothing, with auth off) may view and use the
 * browser, not manage it. Decided from the request's or socket's own authentication, never from what the page says.
 */
export function canManageBrowser(remote: RemoteIdentity | null, local: boolean): boolean {
	return remote !== null || local;
}
