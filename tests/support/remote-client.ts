import { type AccessKey, AUD, claims, EMAIL, HOSTNAME, sign } from "./access-jwt.ts";
import type { TestServer } from "./server.ts";

/**
 * A remote client: the requests and the socket of a page that comes in through the tunnel, with the public hostname as
 * its Host, the Access token in the header Cloudflare adds (or in the cookie it set), and the app's own access-token
 * cookie. The server under test is the one the test started; nothing here reaches Cloudflare.
 */

export interface Remote {
	/** The Access token; `null`: none. Absent: a valid one. */
	jwt?: string | null;
	/** Send the Access token as the CF_Authorization cookie instead of the header. */
	asCookie?: boolean;
	/** Send the app's own access-token cookie (default: yes). */
	token?: boolean;
	host?: string;
	/** Default: the page's own origin; `null`: none. */
	origin?: string | null;
	method?: string;
	headers?: Record<string, string>;
}

export interface RemoteClient {
	/** A valid Access token for `over` (the claims of one that is good now). */
	jwt(over?: Record<string, unknown>): Promise<string>;
	/** What Cloudflare's tunnel sends: the public hostname as Host, the Access token, the app's cookie. */
	headers(r?: Remote): Promise<Record<string, string>>;
	/** A request to the server as the remote page. */
	fetch(path: string, r?: Remote, body?: string): Promise<Response>;
	/** A WebSocket as a browser behind the tunnel opens it; null when the server refuses it. */
	socket(r?: Remote): Promise<WebSocket | null>;
}

export function remoteClient(s: TestServer, key: AccessKey): RemoteClient {
	const now = () => Math.floor(Date.now() / 1000);
	const jwt = (over: Record<string, unknown> = {}) => sign(key, claims(now(), over));
	const headers = async (r: Remote = {}): Promise<Record<string, string>> => {
		const token = r.jwt === undefined ? await jwt() : r.jwt;
		const cookies = r.token === false ? [] : [`ompw_token=${s.accessToken}`];
		const out: Record<string, string> = { host: r.host ?? HOSTNAME, ...r.headers };
		if (token) {
			if (r.asCookie) cookies.push(`CF_Authorization=${token}`);
			else out["cf-access-jwt-assertion"] = token;
		}
		if (cookies.length) out.cookie = cookies.join("; ");
		if (r.origin !== null) out.origin = r.origin ?? `https://${HOSTNAME}`;
		return out;
	};
	return {
		jwt,
		headers,
		fetch: async (path: string, r: Remote = {}, body?: string) =>
			fetch(`${s.url}${path}`, { method: r.method ?? "GET", headers: await headers(r), body, redirect: "manual" }),
		socket: async (r: Remote = {}) => {
			const ws = new WebSocket(`${s.url.replace("http", "ws")}/ws`, {
				headers: await headers(r),
			} as unknown as string[]);
			const opened = Promise.withResolvers<WebSocket | null>();
			ws.onopen = () => opened.resolve(ws);
			ws.onerror = () => opened.resolve(null);
			return opened.promise;
		},
	};
}

/** The settings of the remote access, as `remote.json` holds them. */
export function remoteSettings(over: Record<string, unknown> = {}): Record<string, unknown> {
	return { enabled: true, hostname: HOSTNAME, team: "acme", aud: AUD, emails: [EMAIL], ...over };
}
