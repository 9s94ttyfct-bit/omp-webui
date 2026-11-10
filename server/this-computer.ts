import type { RemoteIdentity } from "./remote-auth.ts";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/** What a proxy adds to a request it carries on (`cf-*` is Cloudflare's, the rest is every other reverse proxy's). */
const isProxyHeader = (name: string) =>
	name.startsWith("cf-") ||
	name.startsWith("x-forwarded-") ||
	name === "cdn-loop" ||
	name === "forwarded" ||
	name === "via" ||
	name === "x-real-ip";

/**
 * Whether `peer`, the address a connection is from (`Server.requestIP`), is this computer's own: `127.0.0.0/8`, `::1`,
 * or an IPv4 loopback address in its IPv6 form. The address of the socket, not what the request says: a client names
 * the server by any Host it likes, but cannot choose where its packets come from. A connection from this computer's own
 * network address (a browser opened on `http://192.168.1.5:7878` here) is from that address, not from the loopback.
 */
export function isLoopbackPeer(peer: string | undefined): boolean {
	if (peer === undefined) return false;
	if (peer === "::1") return true;
	return LOOPBACK_V4.test(peer.startsWith("::ffff:") ? peer.slice("::ffff:".length) : peer);
}

/**
 * Whether `req` comes from a page on this computer: it names the server by a loopback name, its connection is a loopback
 * one (`peer`: the address the socket is from), and nothing of what a proxy adds to a request it carries is on it
 * (Cloudflare's `cf-*`, `x-forwarded-*`, `forwarded`, `via`). Any one of these missing is a request from elsewhere (the
 * tunnel, a proxy on this machine that rewrote the Host, or a network address the server was made to listen on: whatever
 * `OMP_WEBUI_HOST` says, a server's own address is not a way in for the person at this computer), and none of those may
 * open a file on this computer, change what guards it or how it is reached, move it to another computer, or is shown
 * what is hidden or secret (a `guarded` page).
 *
 * A server bound to a network address also listens on `127.0.0.1` (`loopback-listener.ts`), so that its owner has a page
 * here: this rule is the only thing that makes a page of that listener this computer's, as it is on every listener.
 *
 * Asked of every request, so it lives apart from the Files tab's routes (`folder-routes.ts`), which are loaded only
 * when a page uses that tab (`folder-lazy.ts`).
 */
export function isThisComputer(req: Request, peer: string | undefined): boolean {
	const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
	if (!LOOPBACK_HOSTS.includes(host) || !isLoopbackPeer(peer)) return false;
	for (const [name] of req.headers) if (isProxyHeader(name)) return false;
	return true;
}

/**
 * Whether a page is the person's own: on this computer, or signed in as the person through Cloudflare Access (`remote`, the
 * identity `RemoteAuth.verify` checked; null for any other request). Such a page may do everything this computer's page
 * may: the owner's routes (`isOwnerRoute`), the built-in browser's management, the guidance, the Files tab's whole reach
 * and file transfer whatever Settings › Remote access says. A page holding only the server's token (one on the network, or
 * any page with auth off) may use the conversations and look at these, not change them. Decided from the request's or
 * socket's own authentication, never from what the page says.
 */
export function isOwnerPage(remote: RemoteIdentity | null, local: boolean): boolean {
	return remote !== null || local;
}

const OWNER_ONLY = [
	"/api/remote",
	"/api/macs",
	"/api/guard",
	"/api/update",
	"/api/migrate",
	"/api/memory",
	"/api/shell",
	"/api/settings-help",
	"/api/login-start",
	"/api/shutdown",
];

/**
 * The routes that are the person's, and nobody else's (`isOwnerPage`: this computer's page, and one signed in through
 * Access): the tunnel's settings (`/api/remote*`), the list of saved Macs (`/api/macs*`), the guard's settings, what it
 * decided and how strict it is (`/api/guard*`), the app's own updates (`/api/update*`), moving to another computer
 * (`/api/migrate/*`), what omp remembers (`/api/memory*`: what is written to it is put into the prompt of every later
 * conversation), what the macOS app is told (`/api/shell/*`), Ask agent for help (`/api/settings-help*`), what starts at
 * this user's login (`/api/login-start`) and stopping the server (`/api/shutdown`). A page that holds only the token (one on
 * the network, or behind a proxy without Access) is refused them by `route` in `main.ts`: the token lets a page use the
 * conversations, not reconfigure, replace or carry away the computer they run on. A route under one of these prefixes
 * added later is the owner's too. The stream the app of another Mac reads (`/api/notify/events`, #656) is not listed:
 * `route` lets it in only for a request that came through Access (or from this computer).
 */
export function isOwnerRoute(pathname: string): boolean {
	return OWNER_ONLY.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
