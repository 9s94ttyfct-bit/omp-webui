import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveAttached, LiveInfo } from "../../shared/protocol.ts";
import { partOf } from "../../shared/reply-parts.ts";
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
	withPayload,
} from "../support/access-jwt.ts";
import { messageWhere } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Remote access against the real server (and real omp, no model calls): the public hostname is served only behind a
 * valid Cloudflare Access token, a local request is served as it always was, the token cookie a remote page is given is
 * `Secure`, and a remote page acts on a conversation exactly like a local one (it changes nothing about its permission
 * mode). The Access keys are generated here and served by a local stand-in for the team's certs endpoint.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-remote-"));
const settingsFile = join(root, "remote.json");
const dist = join(root, "dist");
const GOOD = { enabled: true, hostname: HOSTNAME, team: TEAM, aud: AUD, emails: [EMAIL] };
let key: AccessKey;
let intruder: AccessKey;
let jwks: Jwks;
let s: TestServer;

const setSettings = (over: Record<string, unknown> = {}) =>
	writeFileSync(settingsFile, JSON.stringify({ ...GOOD, ...over }));
const now = () => Math.floor(Date.now() / 1000);
const goodJwt = (over: Record<string, unknown> = {}) => sign(key, claims(now(), over));

beforeAll(async () => {
	key = await makeKey("kid-1");
	intruder = await makeKey("kid-1");
	jwks = await startJwks([key]);
	mkdirSync(join(dist, "assets"), { recursive: true });
	writeFileSync(
		join(dist, "index.html"),
		'<!doctype html>\n<html><head></head><body><div id="root"></div></body></html>\n',
	);
	setSettings();
	s = await startTestServer(
		0,
		{
			OMP_WEBUI_REMOTE_CONFIG: settingsFile,
			OMP_WEBUI_ACCESS_CERTS_URL: jwks.url,
			OMP_WEBUI_DIST: dist,
		},
		{ login: false },
	);
}, 60_000);

afterAll(async () => {
	await s?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

interface Remote {
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

/** What Cloudflare's tunnel sends: the public hostname as Host, the Access token in a header (and the cookie it set). */
async function remoteHeaders(r: Remote): Promise<Record<string, string>> {
	const jwt = r.jwt === undefined ? await goodJwt() : r.jwt;
	const cookies = r.token === false ? [] : [`ompw_token=${s.accessToken}`];
	const headers: Record<string, string> = { host: r.host ?? HOSTNAME, ...r.headers };
	if (jwt) {
		if (r.asCookie) cookies.push(`CF_Authorization=${jwt}`);
		else headers["cf-access-jwt-assertion"] = jwt;
	}
	if (cookies.length) headers.cookie = cookies.join("; ");
	if (r.origin !== null) headers.origin = r.origin ?? `https://${HOSTNAME}`;
	return headers;
}

async function remote(path: string, r: Remote = {}, body?: string): Promise<Response> {
	return fetch(`${s.url}${path}`, {
		method: r.method ?? "GET",
		headers: await remoteHeaders(r),
		body,
		redirect: "manual",
	});
}

/** A WebSocket as a browser behind the tunnel opens it (`/ws`, or the Browser tab's `/ws/browser`); null when refused. */
async function remoteSocket(r: Remote = {}, path = "/ws"): Promise<WebSocket | null> {
	const ws = new WebSocket(`${s.url.replace("http", "ws")}${path}`, {
		headers: await remoteHeaders(r),
	} as unknown as string[]);
	const opened = Promise.withResolvers<WebSocket | null>();
	ws.onopen = () => opened.resolve(ws);
	ws.onerror = () => opened.resolve(null);
	return opened.promise;
}

const local = (path: string, headers: Record<string, string> = {}) =>
	fetch(`${s.url}${path}`, { headers: { "x-omp-webui-token": s.accessToken, ...headers }, redirect: "manual" });

describe("a local request", () => {
	test("is served as before: the token is needed, and the answer says the page is not remote", async () => {
		const meta = await local("/api/meta");
		expect(meta.status).toBe(200);
		expect((await meta.json()).remote).toBe(false);
		expect((await fetch(`${s.url}/api/meta`)).status).toBe(401);
		expect((await fetch(`${s.url}/api/meta`, { headers: { host: "evil.example.test" } })).status).toBe(403);
	});

	test("/?token= still gives the cookie, without Secure; through the tunnel's https it is Secure", async () => {
		const plain = await fetch(`${s.url}/?token=${s.accessToken}`, { redirect: "manual" });
		expect(plain.status).toBe(303);
		const cookie = plain.headers.get("set-cookie") ?? "";
		expect(cookie).toContain(`ompw_token=${s.accessToken}`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).not.toContain("Secure");

		const tunneled = await fetch(`${s.url}/?token=${s.accessToken}`, {
			redirect: "manual",
			headers: { "cf-visitor": '{"scheme":"https"}' },
		});
		expect(tunneled.headers.get("set-cookie")).toContain("; Secure; HttpOnly; SameSite=Strict; Path=/");
	});

	test("the public hostname is refused without an Access token, as any foreign Host is", async () => {
		const withToken = { host: HOSTNAME, "x-omp-webui-token": s.accessToken, cookie: `ompw_token=${s.accessToken}` };
		expect((await fetch(`${s.url}/api/meta`, { headers: withToken })).status).toBe(403);
		expect((await fetch(`${s.url}/`, { headers: { host: HOSTNAME } })).status).toBe(403);
	});
});

describe("a remote request with a valid Access token", () => {
	test("is given the page and the app's own cookie, which is Secure, HttpOnly, SameSite=Strict, for the whole site", async () => {
		const res = await remote("/", { token: false });
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('id="root"');
		const cookie = res.headers.get("set-cookie") ?? "";
		expect(cookie).toContain(`ompw_token=${encodeURIComponent(s.accessToken)}`);
		for (const attribute of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"]) expect(cookie).toContain(attribute);
		// The page stays confined to its own origin.
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain(`connect-src 'self' ws://${HOSTNAME} wss://${HOSTNAME}`);
		expect(csp).not.toContain("*");
	});

	test("is not given it again once it has it, nor on the API", async () => {
		expect((await remote("/")).headers.get("set-cookie")).toBeNull();
		const api = await remote("/api/meta", { token: false });
		expect(api.status).toBe(401);
		expect(api.headers.get("set-cookie")).toBeNull();
	});

	test("is served the API, which says the page is remote; the token can ride in the CF_Authorization cookie too", async () => {
		for (const asCookie of [false, true]) {
			const res = await remote("/api/meta", { asCookie });
			expect(res.status).toBe(200);
			expect((await res.json()).remote).toBe(true);
		}
	});

	test("with the page's own Origin, or none, is served; with anything else it is not", async () => {
		expect((await remote("/api/meta", { origin: `https://${HOSTNAME}` })).status).toBe(200);
		expect((await remote("/api/meta", { origin: null })).status).toBe(200);
		for (const origin of [
			`http://${HOSTNAME}`,
			`https://${HOSTNAME}:8443`,
			"https://evil.example.test",
			`https://${HOSTNAME}.evil.example.test`,
			"null",
			s.url,
		]) {
			expect((await remote("/api/meta", { origin })).status, origin).toBe(403);
			expect((await remote("/", { origin })).status, origin).toBe(403);
		}
	});

	test("to another Host is refused, with the same token", async () => {
		for (const host of [`${HOSTNAME}:443`, `${HOSTNAME}:7878`, `x.${HOSTNAME}`, "evil.example.test"]) {
			expect((await remote("/api/meta", { host })).status, host).toBe(403);
		}
	});

	test("from another site (Sec-Fetch-Site) is refused on the API, like a local one", async () => {
		const sec = (value: string) => ({ headers: { "sec-fetch-site": value } });
		expect((await remote("/api/meta", sec("same-origin"))).status).toBe(200);
		for (const site of ["cross-site", "same-site"])
			expect((await remote("/api/meta", sec(site))).status, site).toBe(403);
	});

	test("cannot use the token link, post a token, touch the tunnel's settings, or carry the data away or overwrite it", async () => {
		const link = await remote(`/?token=${s.accessToken}`, { token: false });
		expect(link.status).toBe(403);
		expect(link.headers.get("set-cookie")).toBeNull();
		const csrf = { "x-omp-webui": "1", "content-type": "application/json" };
		const post = await remote(
			"/api/auth",
			{ method: "POST", headers: csrf, token: false },
			JSON.stringify({ token: s.accessToken }),
		);
		expect(post.status).toBe(403);
		expect(post.headers.get("set-cookie")).toBeNull();
		expect((await remote("/api/remote")).status).toBe(403);
		expect((await remote("/api/remote/config", { method: "POST", headers: csrf }, "{}")).status).toBe(403);
		expect((await remote("/api/remote/start", { method: "POST", headers: csrf })).status).toBe(403);
		// The app's updates are the person's (`isOwnerRoute`, tested below); a route under them that is not named stays this
		// computer's.
		expect((await remote("/api/update/anything")).status).toBe(403);
		expect((await remote("/api/update/anything", { method: "POST", headers: csrf }, "{}")).status).toBe(403);
		// Moving to another computer: an archive holds every conversation, and an import rewrites the user's own files.
		expect((await remote("/api/migrate/plan")).status).toBe(403);
		expect((await remote("/api/migrate/state")).status).toBe(403);
		expect((await remote("/api/migrate/export/file")).status).toBe(403);
		// What the macOS app is told on its own (#627): the titles of the conversations that need somebody.
		expect((await remote("/api/shell/events")).status).toBe(403);
		expect((await remote("/api/shell/background", { method: "POST", headers: csrf }, "{}")).status).toBe(403);
		expect((await remote("/api/shell/background", { method: "DELETE", headers: csrf })).status).toBe(403);
		for (const path of [
			"export",
			"export/cancel",
			"import/begin",
			"import/chunk?offset=0",
			"import/verify",
			"import/apply",
			"import/restore",
		]) {
			expect((await remote(`/api/migrate/${path}`, { method: "POST", headers: csrf }, "{}")).status, path).toBe(403);
		}
		// Locally the link is checked against the token (this one is wrong), not refused outright.
		expect((await local("/?token=wrong")).status).toBe(401);
	});
});

describe("a remote request that is refused", () => {
	async function cases(): Promise<[string, Remote][]> {
		const good = await goodJwt();
		const t = now();
		return [
			["no Access token", { jwt: null }],
			["an Access token that is not one", { jwt: "junk" }],
			["a bad signature (another key, same kid)", { jwt: await sign(intruder, claims(t)) }],
			["a payload changed after signing", { jwt: withPayload(good, claims(t, { email: "other@example.test" })) }],
			["an expired token", { jwt: await goodJwt({ exp: t - 3600 }) }],
			["a token not valid yet", { jwt: await goodJwt({ nbf: t + 3600 }) }],
			["another application (wrong aud)", { jwt: await goodJwt({ aud: ["f".repeat(64)] }) }],
			["another team (wrong iss)", { jwt: await goodJwt({ iss: "https://evil.cloudflareaccess.com" }) }],
			["an email that is not allowed", { jwt: await goodJwt({ email: "intruder@example.test" }) }],
			["alg none", { jwt: `${Buffer.from('{"alg":"none"}').toString("base64url")}.${good.split(".")[1]}.` }],
			["only the app's token cookie", { jwt: null, token: true }],
		];
	}

	test("page and API both answer 403, and no cookie is given", async () => {
		for (const [name, r] of await cases()) {
			for (const path of ["/", "/api/meta", "/assets/app.js", "/api/notify/events"]) {
				const res = await remote(path, r);
				expect(res.status, `${name}: ${path}`).toBe(403);
				expect(res.headers.get("set-cookie"), `${name}: ${path}`).toBeNull();
				expect(await res.text(), `${name}: ${path}`).toBe("Forbidden");
			}
		}
	});

	test("the WebSocket is refused too", async () => {
		for (const [name, r] of await cases()) {
			const ws = await remoteSocket(r);
			expect(ws, name).toBeNull();
		}
	});
});

describe("the WebSocket", () => {
	test("opens for a remote page with a valid Access token and the app's cookie, and the server says hello", async () => {
		const ws = await remoteSocket();
		expect(ws).not.toBeNull();
		const hello = await messageWhere(ws as WebSocket, (m) => m.t === "hello");
		expect(hello.t).toBe("hello");
		(ws as WebSocket).close();
	});

	test("is refused without the app's own cookie, or from another Origin or Host", async () => {
		expect(await remoteSocket({ token: false })).toBeNull();
		expect(await remoteSocket({ origin: "https://evil.example.test" })).toBeNull();
		expect(await remoteSocket({ origin: s.url })).toBeNull();
		expect(await remoteSocket({ host: `${HOSTNAME}:443` })).toBeNull();
	});

	test("an open remote socket is closed by the server when its Access token expires (#548)", async () => {
		// 57 s past its exp is still inside the 60 s of skew: it opens, and the server ends it 3 s later. The token's expiry
		// is the wall clock's, so this one test really waits; revocation in Cloudflare's dashboard reaches a socket that is
		// already proxied only this way (Cloudflare checks at the edge, on new requests).
		const t = now();
		const jwt = await goodJwt({ iat: t - 3600, exp: t - 57 });
		const ws = (await remoteSocket({ jwt })) as WebSocket;
		expect(ws).not.toBeNull();
		const closed = Promise.withResolvers<CloseEvent>();
		ws.onclose = (ev) => closed.resolve(ev);
		expect(Array.isArray(await request(ws, { t: "list_lives" }))).toBe(true);

		const ev = await closed.promise;
		expect(ev.code).toBe(4401);
		expect(ev.reason).toContain("expired");
		// The token is no good for a new connection either, and a fresh one is: the page reconnects through Access.
		expect(await remoteSocket({ jwt })).toBeNull();
		const again = await remoteSocket();
		expect(again).not.toBeNull();
		again?.close();
	}, 20_000);

	test("a local page is not affected: it still opens with its own origin and cookie", async () => {
		const ws = await connect(s);
		expect(ws.readyState).toBe(WebSocket.OPEN);
		ws.close();
	});

	test("a remote Browser tab's socket whose Access token runs for a month stays open (#46)", async () => {
		// A delay past 2^31-1 ms fires at once: the socket must not be closed as expired right after it opens. The server's
		// answer to the tab's first watch (no browser is installed here: `unavailable`) comes after such a timer would have.
		const jwt = await goodJwt({ exp: now() + 30 * 24 * 3600 });
		const ws = (await remoteSocket({ jwt }, "/ws/browser")) as WebSocket;
		expect(ws).not.toBeNull();
		const outcome = Promise.withResolvers<string>();
		ws.onclose = (ev) => outcome.resolve(`closed ${ev.code}`);
		ws.onmessage = (ev) => outcome.resolve(`answered ${JSON.parse(String(ev.data)).t}`);
		ws.send(JSON.stringify({ t: "watch", owner: "nobody", targetId: null, panel: { w: 800, h: 600 } }));
		expect(await outcome.promise).toStartWith("answered");
		expect(ws.readyState).toBe(WebSocket.OPEN);
		ws.close();
	});
});

describe("remote access turned off", () => {
	test("refuses what it served a moment ago, closes the remote pages that are open, and serves again when turned on", async () => {
		const open = await remoteSocket();
		expect(open).not.toBeNull();
		const closed = new Promise<void>((resolve) => {
			(open as WebSocket).onclose = () => resolve();
		});
		expect((await remote("/api/meta")).status).toBe(200);

		setSettings({ enabled: false });
		expect((await remote("/api/meta")).status).toBe(403);
		expect((await remote("/")).status).toBe(403);
		expect(await remoteSocket()).toBeNull();
		await closed;
		// A local page does not notice.
		expect((await local("/api/meta")).status).toBe(200);

		setSettings();
		expect((await remote("/api/meta")).status).toBe(200);
		const again = await remoteSocket();
		expect(again).not.toBeNull();
		again?.close();
	}, 30_000);

	test("also while the settings are incomplete: no allowed email, no application tag", async () => {
		for (const over of [{ emails: [] }, { aud: "" }, { team: "" }, { hostname: "" }]) {
			setSettings(over);
			expect((await remote("/api/meta")).status, JSON.stringify(over)).toBe(403);
		}
		setSettings();
		expect((await remote("/api/meta")).status).toBe(200);
	});

	test("a switch that does not decide who comes in leaves the remote pages open; a change of the allow-list closes them", async () => {
		const open = (await remoteSocket()) as WebSocket;
		expect(open).not.toBeNull();
		const closed = Promise.withResolvers<void>();
		let wasClosed = false;
		open.onclose = () => {
			wasClosed = true;
			closed.resolve();
		};
		// Each remote request reads the settings again: a change it finds is acted on before it is answered.
		for (const over of [
			{ confirmRisky: true },
			{ confirmRisky: false },
			{ fileTransfer: "download" },
			{ remoteShell: false },
		]) {
			setSettings(over);
			expect((await remote("/api/meta")).status, JSON.stringify(over)).toBe(200);
			// The page's request on the socket is answered: the socket is the one it had.
			expect(Array.isArray(await request(open, { t: "list_lives" })), JSON.stringify(over)).toBe(true);
			expect(open.readyState, JSON.stringify(over)).toBe(WebSocket.OPEN);
		}
		expect(wasClosed).toBe(false);
		// Another allow-list (the page's own email is still on it): the page comes back through the Access check.
		setSettings({ emails: [EMAIL, "someone-else@example.test"] });
		expect((await remote("/api/meta")).status).toBe(200);
		await closed.promise;
		setSettings();
		const again = await remoteSocket();
		expect(again).not.toBeNull();
		again?.close();
	}, 30_000);

	test("a remote Browser tab's socket is closed too when the allow-list changes or remote access is turned off (#45)", async () => {
		for (const over of [{ emails: [EMAIL, "someone-else@example.test"] }, { enabled: false }]) {
			const open = (await remoteSocket({}, "/ws/browser")) as WebSocket;
			expect(open, JSON.stringify(over)).not.toBeNull();
			const closed = Promise.withResolvers<CloseEvent>();
			open.onclose = (ev) => closed.resolve(ev);
			setSettings(over);
			// A remote request reads the settings again, as the once-a-second look does.
			await remote("/api/meta");
			const ev = await closed.promise;
			expect(ev.code, JSON.stringify(over)).toBe(1008);
			setSettings();
			expect((await remote("/api/meta")).status).toBe(200);
		}
	}, 30_000);
});

describe("a remote page and a conversation's permission mode", () => {
	const approvalFile = () => join(s.root, "data", "approval.json");
	const storedChoices = () => (existsSync(approvalFile()) ? readFileSync(approvalFile(), "utf8") : "");

	/** The settings overlay omp reads for this process: the mode it is told to run in. */
	function overlayMode(liveId: string): string | null {
		for (const dir of readdirSync(s.tmpDir).filter((n) => n.startsWith("ompw-live-"))) {
			const file = join(s.tmpDir, dir, `${liveId}.yml`);
			if (existsSync(file)) return /approvalMode: (\S+)/.exec(readFileSync(file, "utf8"))?.[1] ?? null;
		}
		return null;
	}

	const openNew = (ws: WebSocket, approvalMode: string) =>
		request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work, approvalMode } });
	const infoOf = async (ws: WebSocket, liveId: string) =>
		(await request<LiveInfo[]>(ws, { t: "list_lives" })).find((l) => l.liveId === liveId) as LiveInfo;
	const healthy = async (ws: WebSocket, liveId: string) =>
		typeof (await request<unknown>(ws, { t: "rpc", liveId, command: { type: "get_state" } })) === "object";
	/** Every `live` frame this page is told of for the conversation, from now on. */
	function recordLives(ws: WebSocket, liveId: string): LiveInfo[] {
		const seen: LiveInfo[] = [];
		ws.addEventListener("message", (ev) => {
			if (partOf(String(ev.data)) !== null) return;
			const m = JSON.parse(String(ev.data));
			if (m.t === "live" && m.info.liveId === liveId) seen.push(m.info as LiveInfo);
		});
		return seen;
	}
	/** What a page is told of the mode: the user's own, and nothing that says a remote page changed it. */
	const expectMode = (info: LiveInfo, mode: LiveInfo["approvalMode"]) => {
		expect(info.approvalMode).toBe(mode);
		expect(info).not.toHaveProperty("approvalForcedByRemote");
	};

	test("attaching changes nothing: the mode, the overlay omp reads and what is kept stay as the user chose", async () => {
		setSettings();
		const page = await connect(s);
		const live = await openNew(page, "write");
		const choices = storedChoices();
		const seen = recordLives(page, live.liveId);
		expect(overlayMode(live.liveId)).toBe("write");

		const phone = (await remoteSocket()) as WebSocket;
		const attached = await request<LiveAttached>(phone, { t: "attach", liveId: live.liveId });
		expectMode(attached, "write");
		expect(overlayMode(live.liveId)).toBe("write");
		expectMode(await infoOf(phone, live.liveId), "write");
		expectMode(await infoOf(page, live.liveId), "write");
		expect(await healthy(phone, live.liveId)).toBe(true);
		expect(await healthy(page, live.liveId)).toBe(true);
		expect(storedChoices()).toBe(choices);
		// The page on this Mac was told of the new subscriber, and nothing in it is about a mode.
		await pollUntil(() => seen.length > 0, "the local page to be told of the attached remote page");
		for (const info of seen) expectMode(info, "write");

		// The remote page leaving changes nothing either, and takes no time to.
		phone.close();
		expect(await healthy(page, live.liveId)).toBe(true);
		expect(overlayMode(live.liveId)).toBe("write");
		expectMode(await infoOf(page, live.liveId), "write");
		for (const info of seen) expectMode(info, "write");

		await request(page, { t: "close", liveId: live.liveId });
		page.close();
	}, 120_000);

	test("a remote page that only sends commands to a conversation changes nothing either", async () => {
		setSettings();
		const page = await connect(s);
		const live = await openNew(page, "write");
		const seen = recordLives(page, live.liveId);
		const phone = (await remoteSocket()) as WebSocket;
		expect(await healthy(phone, live.liveId)).toBe(true);
		expect(overlayMode(live.liveId)).toBe("write");
		expectMode(await infoOf(page, live.liveId), "write");

		// A turn the remote page started goes on in the mode of the conversation after its socket drops.
		const command = request(phone, { t: "rpc", liveId: live.liveId, command: { type: "bash", command: "sleep 2" } });
		command.catch(() => undefined);
		phone.close();
		expect(overlayMode(live.liveId)).toBe("write");
		expect(await healthy(page, live.liveId)).toBe(true);
		expectMode(await infoOf(page, live.liveId), "write");
		for (const info of seen) expectMode(info, "write");

		await request(page, { t: "close", liveId: live.liveId });
		page.close();
	}, 120_000);

	for (const message of [
		{ t: "resume" },
		{ t: "retry_now" },
		{ t: "model_preset", name: "no-such-preset" },
		{ t: "pause" },
	]) {
		test(`a remote page that sends ${message.t} without attaching leaves the mode as it is`, async () => {
			setSettings();
			const page = await connect(s);
			const live = await openNew(page, "write");
			const phone = (await remoteSocket()) as WebSocket;
			// Whether the command itself succeeds is not the point (there is nothing to retry, no such preset): what it
			// changes is nothing about the conversation's mode.
			await request(phone, { ...message, liveId: live.liveId }).catch(() => undefined);
			expect(overlayMode(live.liveId)).toBe("write");
			expectMode(await infoOf(page, live.liveId), "write");
			expectMode(await infoOf(phone, live.liveId), "write");

			phone.close();
			await request(page, { t: "close", liveId: live.liveId });
			page.close();
		}, 90_000);
	}

	test("a mode change from a remote page is an ordinary one: the same on both pages, in the overlay, and kept like a local one", async () => {
		setSettings();
		const page = await connect(s);
		const live = await openNew(page, "write");
		const seen = recordLives(page, live.liveId);
		const phone = (await remoteSocket()) as WebSocket;
		await request(phone, { t: "attach", liveId: live.liveId });

		expectMode(await request<LiveInfo>(phone, { t: "approval_mode", liveId: live.liveId, mode: "yolo" }), "yolo");
		expect(overlayMode(live.liveId)).toBe("yolo");
		expectMode(await infoOf(page, live.liveId), "yolo");

		expectMode(
			await request<LiveInfo>(page, { t: "approval_mode", liveId: live.liveId, mode: "always-ask" }),
			"always-ask",
		);
		expect(overlayMode(live.liveId)).toBe("always-ask");
		expectMode(await infoOf(phone, live.liveId), "always-ask");

		// Leaving puts nothing back: the last choice made, from whichever page, is the one in force.
		phone.close();
		expect(await healthy(page, live.liveId)).toBe(true);
		expect(overlayMode(live.liveId)).toBe("always-ask");
		for (const info of seen) expect(info).not.toHaveProperty("approvalForcedByRemote");

		await request(page, { t: "close", liveId: live.liveId });
		page.close();
	}, 90_000);

	test("local_takeover is a message that no longer exists: from a remote or a local page it changes nothing", async () => {
		setSettings();
		const page = await connect(s);
		const live = await openNew(page, "yolo");
		const phone = (await remoteSocket()) as WebSocket;
		await request(phone, { t: "attach", liveId: live.liveId });

		// Unknown to the server, so nothing answers it: it is sent as it was, and what is checked is the conversation.
		for (const ws of [phone, page]) ws.send(JSON.stringify({ t: "local_takeover", liveId: live.liveId }));
		expect(await healthy(phone, live.liveId)).toBe(true);
		expect(await healthy(page, live.liveId)).toBe(true);
		expect(overlayMode(live.liveId)).toBe("yolo");
		expectMode(await infoOf(page, live.liveId), "yolo");
		expectMode(await infoOf(phone, live.liveId), "yolo");

		phone.close();
		await request(page, { t: "close", liveId: live.liveId });
		page.close();
	}, 90_000);

	test("remote access turned off ends the page's connection and leaves the conversation as it was", async () => {
		setSettings();
		const page = await connect(s);
		const live = await openNew(page, "write");
		const phone = (await remoteSocket()) as WebSocket;
		await request(phone, { t: "attach", liveId: live.liveId });
		expect(overlayMode(live.liveId)).toBe("write");

		setSettings({ enabled: false });
		await pollUntil(() => phone.readyState >= WebSocket.CLOSING, "the remote page's connection to end");
		expect(overlayMode(live.liveId)).toBe("write");
		expectMode(await infoOf(page, live.liveId), "write");

		setSettings();
		await request(page, { t: "close", liveId: live.liveId });
		page.close();
	}, 120_000);
});

describe("the stream of notices the app of another Mac reads (#656)", () => {
	/** The first line of the stream, which is the state: the response has started and says what it is. */
	async function firstLine(res: Response): Promise<string> {
		const body = res.body?.getReader();
		if (!body) throw new Error("no body");
		const decoder = new TextDecoder();
		let text = "";
		while (!text.includes("\n")) {
			const { value, done } = await body.read();
			if (done) break;
			text += decoder.decode(value);
		}
		await body.cancel();
		return text.split("\n")[0];
	}

	test("is given to a request that passed Access and holds the server's token, in the cookies the window's own sign-in left", async () => {
		for (const asCookie of [false, true]) {
			const res = await remote("/api/notify/events", { asCookie });
			expect(res.status, `jwt as ${asCookie ? "cookie" : "header"}`).toBe(200);
			expect(res.headers.get("content-type")).toBe("application/x-ndjson");
			expect(JSON.parse(await firstLine(res))).toMatchObject({ t: "state", working: expect.any(Number) });
		}
	});

	test("is refused without the server's token (401), without Access (403), and a method that changes is no way in", async () => {
		expect((await remote("/api/notify/events", { token: false })).status).toBe(401);
		expect((await remote("/api/notify/events", { jwt: null })).status).toBe(403);
		expect((await remote("/api/notify/events", { jwt: null, token: false })).status).toBe(403);
		const post = await remote("/api/notify/events", { method: "POST", headers: { "x-omp-webui": "1" } }, "{}");
		expect(post.status).not.toBe(200);
	});

	test("is not the local-only stream: that one is still refused to a request that came through the tunnel, token and Access both", async () => {
		expect((await remote("/api/shell/events")).status).toBe(403);
		const here = await local("/api/notify/events");
		expect(here.status).toBe(200);
		await firstLine(here);
	});
});

/**
 * A page signed in through Cloudflare Access counts as the person (`isOwnerPage`): it may change the guard's settings, a
 * conversation's own guard and the guidance, and update the app, as the page on this computer may. What the Guard page
 * shows and tunes, the
 * guidance conflict check (it reads what omp remembers) and the tunnel's own settings stay this computer's. A page on the
 * network that holds only the token is still refused all of it: `lan-local.test.ts`.
 */
describe("a page signed in through Access is the person's own", () => {
	const csrf = { "x-omp-webui": "1", "content-type": "application/json" };
	const post = (path: string, body: unknown) => remote(path, { method: "POST", headers: csrf }, JSON.stringify(body));
	const postHere = (path: string, body: unknown) =>
		fetch(`${s.url}${path}`, {
			method: "POST",
			headers: { "x-omp-webui-token": s.accessToken, ...csrf },
			body: JSON.stringify(body),
		});
	type GuardConfigAnswer = { config: { mode: string; askWhenDenied: boolean } };

	test("is told so by /api/meta, as the page on this computer is", async () => {
		setSettings();
		const meta = (await (await remote("/api/meta")).json()) as { remote: boolean; local: boolean; owner: boolean };
		expect(meta).toMatchObject({ remote: true, local: false, owner: true });
		expect(((await (await local("/api/meta")).json()) as { owner: boolean }).owner).toBe(true);
	});

	test("changes the guard's settings, and is told them over its socket without the rules", async () => {
		setSettings();
		const before = ((await (await local("/api/guard")).json()) as GuardConfigAnswer).config;
		expect((await remote("/api/guard")).status).toBe(200);
		const phone = (await remoteSocket()) as WebSocket;
		try {
			const said = messageWhere(phone, (m) => m.t === "guard_config");
			const res = await post("/api/guard", { mode: "ask", askWhenDenied: false });
			expect(res.status).toBe(200);
			expect(((await res.json()) as GuardConfigAnswer).config).toMatchObject({ mode: "ask", askWhenDenied: false });
			// What every gate and the page on this computer go by now.
			expect(((await (await local("/api/guard")).json()) as GuardConfigAnswer).config.mode).toBe("ask");
			const message = await said;
			expect((message.config as GuardConfigAnswer["config"]).mode).toBe("ask");
			// The reviewer's rules are the Guard page's, this computer's alone.
			expect(message).not.toHaveProperty("rules");
		} finally {
			phone.close();
			expect((await postHere("/api/guard", before)).status).toBe(200);
		}
	});

	test("updates the app as the page on this computer does, and is told the update state over its socket", async () => {
		setSettings();
		expect((await remote("/api/update")).status).toBe(200);
		// It reaches the updater: this server is no app to replace, so the install is refused for that, not for the page.
		const install = await post("/api/update/install", { tag: "v9.9.9", anyway: true });
		expect(install.status).toBe(409);
		expect(await install.json()).toMatchObject({ code: "blocked", params: { reason: "notApp" } });
		expect((await post("/api/update/cancel", {})).status).toBe(200);
		const phone = (await remoteSocket()) as WebSocket;
		try {
			const said = messageWhere(phone, (m) => m.t === "app_update");
			expect((await post("/api/update/dismiss", {})).status).toBe(200);
			expect((await said).state).toMatchObject({ failed: null, outcome: null });
		} finally {
			phone.close();
		}
	});

	test("changes a conversation's own guard and its guidance, and starts a new chat with both", async () => {
		setSettings();
		const TYPED = "ACCESS-GUIDANCE-MARKER: one subagent at a time.";
		const page = await connect(s);
		const phone = (await remoteSocket()) as WebSocket;
		const opened: string[] = [];
		try {
			const live = await request<LiveInfo>(page, { t: "open", target: { kind: "new", cwd: s.work } });
			opened.push(live.liveId);
			const guard = await post("/api/guard/live", { liveId: live.liveId, guard: { mode: "ask" } });
			expect(guard.status).toBe(200);
			expect(((await guard.json()) as { guard: LiveInfo["guard"] }).guard?.own?.mode).toBe("ask");
			const guidance = await post("/api/model-guidance/live", { liveId: live.liveId, guidance: { text: TYPED } });
			expect(guidance.status).toBe(200);
			expect(((await guidance.json()) as { guidance: { text: string } }).guidance.text).toBe(TYPED);

			// A new chat the phone opens with its own guard and typed guidance is given both.
			const mine = await request<LiveInfo>(phone, {
				t: "open",
				target: { kind: "new", cwd: s.work, guard: { mode: "ask" }, guidance: { text: TYPED } },
			});
			opened.push(mine.liveId);
			expect(mine.guard?.own?.mode).toBe("ask");
			expect(mine.guidance?.text).toBe(TYPED);
		} finally {
			for (const liveId of opened) await request(page, { t: "close", liveId }).catch(() => {});
			phone.close();
			page.close();
		}
	}, 120_000);

	test("changes the guidance templates and restores the shipped ones", async () => {
		setSettings();
		const saved = await post("/api/model-guidance", {
			template: { id: "access-template", name: "From the phone", text: "Reply in short sentences." },
		});
		expect(saved.status).toBe(200);
		const names = ((await (await local("/api/model-guidance")).json()) as { templates: { id: string }[] }).templates;
		expect(names.map((x) => x.id)).toContain("access-template");
		expect((await post("/api/model-guidance", { remove: "access-template" })).status).toBe(200);
		expect((await post("/api/model-guidance/restore", {})).status).toBe(200);
	});

	test("is still refused the Guard page's routes, the conflict check and the tunnel's settings", async () => {
		setSettings();
		for (const path of [
			"/api/guard/rules",
			"/api/guard/log",
			"/api/guard/decisions?session=x",
			"/api/guard/bench",
			"/api/guard/anything",
		])
			expect((await remote(path)).status, path).toBe(403);
		expect((await post("/api/guard/rules", { thresholds: { delete_outside: "allow" } })).status).toBe(403);
		expect((await post("/api/guard/bench", { reviewer: true })).status).toBe(403);
		expect((await post("/api/guard/bench/preview", { thresholds: {} })).status).toBe(403);
		// The conflict check shows what omp remembers, which is this computer's (`/api/memory*`).
		expect((await post("/api/model-guidance/conflicts", { liveId: "L0-nope", text: "x" })).status).toBe(403);
		// The protection against remote pages is the tunnel's setting: an Access page cannot turn it off.
		expect((await post("/api/remote/config", { confirmRisky: false })).status).toBe(403);
	});
});
