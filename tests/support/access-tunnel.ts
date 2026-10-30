import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { type AddressInfo, connect as netConnect, type Socket } from "node:net";

/**
 * Cloudflare in front of the app, locally: what the edge and `cloudflared` do with a browser's requests, for tests that
 * need the way in to misbehave (`remote-flow.spec.ts` keeps its own, plainer one). Plain `node:http` and `node:net`, so
 * it runs under Node (Playwright) and Bun alike. Nothing here reaches Cloudflare.
 *
 *  - Access: a request that carries no `CF_Authorization` cookie is not let through; it is redirected to the sign-in on
 *    another origin (the team's own host), whether it is a page, a `fetch` or a WebSocket upgrade. One that carries it
 *    reaches the app with the token also in `Cf-Access-Jwt-Assertion`, `Host` and `Origin` as the public hostname's.
 *  - The tunnel speaks http to the browser, so the `Secure` the app puts on its cookie is dropped (a browser would not
 *    keep it from an http page).
 *  - A WebSocket that has carried nothing, in either direction, for `idleMs` is cut without a word, as the edge does at
 *    about 100 s (a test scales the time down).
 *  - `drop()` is the network going away under the open sockets; `holdUpgrades` keeps new ones from being made.
 */

export const ACCESS_COOKIE = "CF_Authorization";

export interface TunnelSocket {
	/** Why it ended; "open" while it has not. */
	end: "open" | "idle" | "dropped" | "browser" | "origin";
	/** Bytes the origin sent through it, and the browser. */
	toBrowser: number;
	toOrigin: number;
}

export interface AccessTunnel {
	/** Where a browser reaches the public hostname. */
	readonly url: string;
	/** The sign-in a request without a session is sent to (another origin: the team's own host). */
	readonly loginUrl: string;
	/** A WebSocket idle this long is cut (ms); 0: never. */
	idleMs: number;
	/** While true a WebSocket upgrade is cut as it arrives (the network is out). */
	holdUpgrades: boolean;
	/** Every WebSocket the tunnel carried, in the order they were made. */
	readonly sockets: TunnelSocket[];
	/** How many upgrades reached the app, and with which Access token ("none": it was sent to sign in). */
	readonly upgrades: { token: string | "none" }[];
	/** The network goes away under every open WebSocket. */
	drop(): void;
	stop(): Promise<void>;
}

/** The value of cookie `name` in a Cookie header. */
function cookieOf(header: string | undefined, name: string): string | null {
	for (const part of (header ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=");
	}
	return null;
}

/** The headers a request has once Cloudflare and `cloudflared` have carried it to the origin. */
function toOrigin(headers: IncomingHttpHeaders, hostname: string, token: string): [string, string][] {
	const out: Record<string, string | string[] | undefined> = {
		...headers,
		host: hostname,
		...(headers.origin === undefined ? {} : { origin: `https://${hostname}` }),
		"cf-visitor": '{"scheme":"https"}',
		"cf-ray": "8f0000000000aaaa-SJC",
		"cf-connecting-ip": "203.0.113.7",
		"cdn-loop": "cloudflare; loops=1",
		"cf-access-jwt-assertion": token,
	};
	return Object.entries(out).flatMap(([name, value]) =>
		value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((v): [string, string] => [name, v]),
	);
}

async function listen(server: Server): Promise<number> {
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	return (server.address() as AddressInfo).port;
}

/** A tunnel to the app on `port`, whose public hostname is `hostname`. */
export async function startAccessTunnel(
	port: number,
	options: { hostname?: string; idleMs?: number } = {},
): Promise<AccessTunnel> {
	const hostname = options.hostname ?? "omp.example.com";
	const login = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html;charset=utf-8" });
		res.end("<!doctype html><title>Sign in</title><h1>Sign in to my-team</h1>");
	});
	const loginUrl = `http://127.0.0.1:${await listen(login)}/cdn-cgi/access/login/${hostname}`;
	const redirect = `HTTP/1.1 302 Found\r\nlocation: ${loginUrl}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`;

	const open = new Set<Socket>();
	const sockets: TunnelSocket[] = [];
	const upgrades: { token: string }[] = [];
	const live = new Map<TunnelSocket, { client: Socket; origin: Socket; last: number }>();
	const end = (record: TunnelSocket, how: TunnelSocket["end"]) => {
		const pair = live.get(record);
		if (!pair) return;
		live.delete(record);
		record.end = how;
		pair.client.destroy();
		pair.origin.destroy();
	};

	const server: Server = createServer((req, res) => {
		const token = cookieOf(req.headers.cookie, ACCESS_COOKIE);
		if (!token) {
			res.writeHead(302, { location: loginUrl, "content-length": "0" });
			res.end();
			return;
		}
		const up = httpRequest(
			{
				host: "127.0.0.1",
				port,
				method: req.method,
				path: req.url,
				headers: Object.fromEntries(toOrigin(req.headers, hostname, token)),
			},
			(answer) => {
				const headers = { ...answer.headers };
				if (headers["set-cookie"])
					headers["set-cookie"] = headers["set-cookie"].map((cookie) => cookie.replace(/;\s*Secure\b/i, ""));
				res.writeHead(answer.statusCode ?? 502, headers);
				answer.pipe(res);
			},
		);
		up.on("error", () => res.destroy());
		req.pipe(up);
	});
	server.on("connection", (socket) => {
		open.add(socket);
		socket.on("close", () => open.delete(socket));
	});
	server.on("upgrade", (req, client: Socket, head) => {
		const token = cookieOf(req.headers.cookie, ACCESS_COOKIE);
		client.on("error", () => {});
		if (tunnel.holdUpgrades) {
			client.destroy();
			return;
		}
		upgrades.push({ token: token ?? "none" });
		if (!token) {
			client.end(redirect);
			return;
		}
		const record: TunnelSocket = { end: "open", toBrowser: 0, toOrigin: 0 };
		const origin = netConnect(port, "127.0.0.1", () => {
			const lines = toOrigin(req.headers, hostname, token).map(([name, value]) => `${name}: ${value}`);
			origin.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
			if (head.length > 0) origin.write(head);
			client.pipe(origin);
			origin.pipe(client);
		});
		const pair = { client, origin, last: Date.now() };
		sockets.push(record);
		live.set(record, pair);
		client.on("data", (chunk: Buffer) => {
			record.toOrigin += chunk.length;
			pair.last = Date.now();
		});
		origin.on("data", (chunk: Buffer) => {
			record.toBrowser += chunk.length;
			pair.last = Date.now();
		});
		client.on("close", () => end(record, "browser"));
		origin.on("close", () => end(record, "origin"));
		origin.on("error", () => end(record, "origin"));
	});

	const tunnel: AccessTunnel = {
		url: "",
		loginUrl,
		idleMs: options.idleMs ?? 0,
		holdUpgrades: false,
		sockets,
		upgrades,
		drop: () => {
			for (const record of [...live.keys()]) end(record, "dropped");
		},
		stop: async () => {
			clearInterval(watch);
			for (const record of [...live.keys()]) end(record, "dropped");
			for (const socket of open) socket.destroy();
			await Promise.all(
				[server, login].map((s) => {
					const closed = Promise.withResolvers<void>();
					s.close(() => closed.resolve());
					return closed.promise;
				}),
			);
		},
	};
	// The edge's clock: looked at often enough for a test's scaled-down limit.
	const watch = setInterval(() => {
		if (tunnel.idleMs <= 0) return;
		for (const [record, pair] of [...live]) if (Date.now() - pair.last >= tunnel.idleMs) end(record, "idle");
	}, 25);
	watch.unref();
	Object.assign(tunnel, { url: `http://127.0.0.1:${await listen(server)}` });
	return tunnel;
}
