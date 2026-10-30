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

const LOCAL_ONLY = [
	"/api/remote",
	"/api/macs",
	"/api/guard",
	"/api/update",
	"/api/migrate",
	"/api/memory",
	"/api/shell",
];

/**
 * The routes that are the person's at this computer, and nobody else's: the tunnel's settings (`/api/remote*`), the list of
 * saved Macs (`/api/macs*`: every route of it changes the list, which pages read in `/api/meta`), what
 * guards the agent and what it decided (`/api/guard*`), the app's own updates (`/api/update*`), moving to another
 * computer (`/api/migrate/*`), what omp remembers (`/api/memory*`: the folders of the projects and excerpts of
 * conversations, and what is written to it is put into the prompt of every later conversation, which a page that is not
 * on this computer must not be able to do) and what the macOS app is told on its own (`/api/shell/*`: which
 * conversations work and wait, and the titles of the ones that need somebody, for the app's notifications). A page that
 * is not on this computer (see `isThisComputer`) is refused them, whether it
 * came through the tunnel or over the network, and whatever token it holds: the token lets a page use the conversations,
 * not reconfigure, replace or carry away the computer they run on. A route added here is refused to such a page by
 * `route` in `main.ts`; one that is for this computer and is not listed is open to every page that has the token. The stream
 * the app of another Mac reads (`/api/notify/events`, #656) is deliberately not listed: it is how a window onto this Mac is
 * told what needs the person, and `route` lets it in only for a request that came through Access (or from this computer).
 */
export function isLocalOnlyRoute(pathname: string): boolean {
	return LOCAL_ONLY.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
