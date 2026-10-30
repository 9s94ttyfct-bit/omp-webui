import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type AccessKey,
	AUD,
	claims,
	EMAIL,
	HOSTNAME,
	type Jwks,
	makeKey,
	sign,
	startJwks,
	TEAM,
} from "../support/access-jwt.ts";
import { ACCESS_COOKIE, type AccessTunnel, startAccessTunnel } from "../support/access-tunnel.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { request } from "../support/ws.ts";

/**
 * A remote page's socket through Cloudflare. The edge closes a WebSocket that has carried nothing, in either direction,
 * for about 100 s: the server (Bun) sends its first ping after 104 s of silence, too late, and a page whose timers are
 * not running (a hidden tab, a locked iPad) says nothing either. So the server pings remote sockets on its own, well
 * inside the limit, and only remote ones. The edge is a stand-in (`access-tunnel.ts`) with its limit scaled down, and
 * the server's interval with it (`OMP_WEBUI_REMOTE_KEEPALIVE_MS`).
 */

const PING_MS = 250;
/** The edge's idle limit, scaled the way `PING_MS` is: a ping is due four times inside it. */
const EDGE_IDLE_MS = 1000;

const root = mkdtempSync(join(tmpdir(), "ompw-remote-keepalive-"));
let key: AccessKey;
let jwks: Jwks;
let s: TestServer;
let port: number;
let tunnel: AccessTunnel;

beforeAll(async () => {
	key = await makeKey("kid-1");
	jwks = await startJwks([key]);
	const dist = join(root, "dist");
	mkdirSync(join(dist, "assets"), { recursive: true });
	writeFileSync(
		join(dist, "index.html"),
		'<!doctype html>\n<html><head></head><body><div id="root"></div></body></html>\n',
	);
	const settingsFile = join(root, "remote.json");
	writeFileSync(
		settingsFile,
		JSON.stringify({ enabled: true, hostname: HOSTNAME, team: TEAM, aud: AUD, emails: [EMAIL] }),
	);
	s = await startTestServer(
		0,
		{
			OMP_WEBUI_REMOTE_CONFIG: settingsFile,
			OMP_WEBUI_ACCESS_CERTS_URL: jwks.url,
			OMP_WEBUI_DIST: dist,
			OMP_WEBUI_REMOTE_KEEPALIVE_MS: String(PING_MS),
		},
		{ login: false },
	);
	port = Number(new URL(s.url).port);
}, 60_000);

afterAll(async () => {
	await s?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

const now = () => Math.floor(Date.now() / 1000);
const token = (over: Record<string, unknown> = {}) => sign(key, claims(now(), { exp: now() + 3600, ...over }));

/** A browser behind the tunnel opens the socket: its Access session is the cookie, the app's own cookie rides along. */
async function open(jwt: string): Promise<WebSocket> {
	const ws = new WebSocket(`${tunnel.url.replace("http", "ws")}/ws`, {
		headers: { cookie: `${ACCESS_COOKIE}=${jwt}; ompw_token=${s.accessToken}`, origin: tunnel.url },
	} as unknown as string[]);
	const hello = Promise.withResolvers<void>();
	ws.addEventListener("message", () => hello.resolve(), { once: true });
	ws.addEventListener("error", () => hello.reject(new Error("the socket was refused")), { once: true });
	await hello.promise;
	return ws;
}

/**
 * The opcodes of the frames the server sends on a socket it is idle on, for `ms`, as a raw client sees them (a browser's
 * own network layer answers pings; scripts never see them). `headers`: what the request carries.
 */
async function opcodesOver(headers: Record<string, string>, ms: number): Promise<number[]> {
	const socket = netConnect(port, "127.0.0.1");
	const handshake = [
		"GET /ws HTTP/1.1",
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}`,
		"Sec-WebSocket-Version: 13",
		...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
		"",
		"",
	].join("\r\n");
	socket.write(handshake);
	let buffered = Buffer.alloc(0);
	let upgraded = false;
	const opcodes: number[] = [];
	socket.on("data", (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		if (!upgraded) {
			const end = buffered.indexOf("\r\n\r\n");
			if (end < 0) return;
			upgraded = true;
			buffered = buffered.subarray(end + 4);
		}
		// Server frames are unmasked; the ones of an idle socket are short (hello, ping).
		while (buffered.length >= 2) {
			const length = (buffered[1] ?? 0) & 0x7f;
			if (length > 125 || buffered.length < 2 + length) break;
			opcodes.push((buffered[0] ?? 0) & 0x0f);
			buffered = buffered.subarray(2 + length);
		}
	});
	await sleep(ms);
	socket.destroy();
	return opcodes;
}

const OPCODE_TEXT = 1;
const OPCODE_PING = 9;

describe("a remote page's socket, through an edge that cuts a silent connection", () => {
	test("is not cut however long the page says nothing: the server keeps it busy", async () => {
		tunnel = await startAccessTunnel(port, { hostname: HOSTNAME, idleMs: EDGE_IDLE_MS });
		try {
			const ws = await open(await token());
			await sleep(4 * EDGE_IDLE_MS);
			expect(tunnel.sockets.map((t) => t.end)).toEqual(["open"]);
			expect(ws.readyState).toBe(WebSocket.OPEN);
			// Nothing was lost on the way: the page still gets its answers.
			expect(Array.isArray(await request(ws, { t: "list_lives" }))).toBe(true);
			ws.close();
		} finally {
			await tunnel.stop();
		}
	}, 30_000);
});

describe("the pings", () => {
	test("go to a remote socket, inside the edge's limit, and not to a local one", async () => {
		const jwt = await token();
		const remote = await opcodesOver(
			{
				host: HOSTNAME,
				origin: `https://${HOSTNAME}`,
				cookie: `ompw_token=${s.accessToken}`,
				"cf-access-jwt-assertion": jwt,
			},
			6 * PING_MS,
		);
		expect(remote[0], "the server says hello first").toBe(OPCODE_TEXT);
		// A ping is due every PING_MS: some have come, none was held back past the edge's limit.
		expect(remote.filter((op) => op === OPCODE_PING).length).toBeGreaterThanOrEqual(4);

		const local = await opcodesOver(
			{ host: `127.0.0.1:${port}`, origin: s.url, cookie: `ompw_token=${s.accessToken}` },
			6 * PING_MS,
		);
		expect(local[0], "the server says hello first, to a local page too").toBe(OPCODE_TEXT);
		expect(local.filter((op) => op === OPCODE_PING)).toEqual([]);
	}, 30_000);

	test("do not keep an expired Access session alive: the server still ends the socket with 4401 (#548)", async () => {
		tunnel = await startAccessTunnel(port, { hostname: HOSTNAME, idleMs: EDGE_IDLE_MS });
		try {
			// 57 s past its exp is inside the 60 s of skew: it opens, and the server ends it 3 s later.
			const ws = await open(await token({ iat: now() - 3600, exp: now() - 57 }));
			const closed = Promise.withResolvers<CloseEvent>();
			ws.addEventListener("close", (ev) => closed.resolve(ev));
			const ev = await closed.promise;
			expect(ev.code).toBe(4401);
			expect(ev.reason).toContain("expired");
		} finally {
			await tunnel.stop();
		}
	}, 20_000);
});
