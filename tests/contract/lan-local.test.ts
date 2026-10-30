import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FolderFile, FolderListing } from "../../shared/folder.ts";
import { MIGRATE_API } from "../../shared/migrate.ts";
import { writeChatSession } from "../support/chat-session.ts";
import { type FakeCloudflared, makeFakeCloudflared } from "../support/fake-cloudflared.ts";
import { messageWhere } from "../support/frames.ts";
import { lanAddress, type NetSocket, rawRequest, rawSocket } from "../support/lan-peer.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect } from "../support/ws.ts";

/**
 * What is for the person at this computer alone (#621): the tunnel's settings (`/api/remote*`), what guards the agent
 * (`/api/guard*`), the app's own updates (`/api/update*`), moving to another computer (`/api/migrate/*`), and the two
 * actions of the Files tab that hand a file to macOS. It is told by the socket: the address a connection is from. A
 * server that listens on a network address (`OMP_WEBUI_HOST`) answers the people of that network, and a page there is
 * no more this computer's for having the token, nor for saying that it is (a loopback Host, an Origin, `X-Forwarded-For`).
 *
 * The peer is real. Two servers: one on the loopback, where the page of this computer connects and where a page of the
 * network is made to connect from this computer's network address (`localAddress`), and one bound to that network
 * address itself (`OMP_WEBUI_HOST`), as the issue has it. A machine with no network address has no peer to make, and
 * the cases that need one say so; the decision is covered without a socket by `tests/unit/this-computer.test.ts`.
 *
 * Nothing real is touched: cloudflared and brew are stand-ins (`OMP_WEBUI_CLOUDFLARED`, `OMP_WEBUI_BREW`), the releases
 * server is a stub that counts what it is asked, and a refused request is shown to have changed and run nothing.
 */

const LAN = lanAddress();
if (LAN === undefined) {
	console.warn(
		"lan-local: this computer has no IPv4 address on a network, so a connection from a network peer cannot be made: the cases that need one are skipped (tests/unit/this-computer.test.ts covers the decision itself)",
	);
}
const networkOnly = LAN === undefined ? describe.skip : describe;

interface MetaAnswer {
	remote: boolean;
	/** Whether the page is on the computer the server runs on: what only that computer may change (#615). */
	local: boolean;
	/** The Macs the server has saved: read by every page. */
	macs: unknown[];
}
interface GuardAnswer {
	config: { mode: string };
}

const root = mkdtempSync(join(tmpdir(), "ompw-lan-local-"));
let program: FakeCloudflared;
let releases: Bun.Server<undefined>;
/** What the releases stub was asked for. */
const asked: string[] = [];
/** The server on the loopback, and the one bound to this computer's network address. */
let s: TestServer;
/** The saved Mac the routes of the list are tried on. */
let macId = "";
let bound: TestServer | null = null;
/** The conversation (its session file) that works in the project. */
let file = "";

const portOf = (server: TestServer) => Number(new URL(server.url).port);

beforeAll(async () => {
	program = makeFakeCloudflared(join(root, "cf"), { installed: false });
	releases = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			asked.push(new URL(req.url).pathname);
			return new Response("{}", { status: 500 });
		},
	});
	const env = {
		OMP_WEBUI_CLOUDFLARED: program.bin,
		OMP_WEBUI_BREW: program.brew,
		OMP_WEBUI_REMOTE_CONFIG: join(root, "remote.json"),
		OMP_WEBUI_APP_UPDATE_API: `http://127.0.0.1:${releases.port}`,
		// The look at the releases that the server does by itself comes an hour after it started.
		OMP_WEBUI_APP_UPDATE_FIRST_MS: "3600000",
	};
	s = await startTestServer(0, env, { login: false });
	if (LAN !== undefined) bound = await startTestServer(0, { ...env, OMP_WEBUI_HOST: LAN }, { login: false });
	const proj = join(s.work, "proj");
	mkdirSync(proj, { recursive: true });
	// An executable: a server that let a page open it would still open nothing (it is refused with another reason).
	writeFileSync(join(proj, "run.sh"), "#!/bin/sh\necho hi\n");
	chmodSync(join(proj, "run.sh"), 0o755);
	writeFileSync(join(proj, "README.md"), "# Title\n");
	writeFileSync(join(proj, ".env"), "SECRET=1\n");
	file = writeChatSession(s.agentDir, { n: 93, title: "LAN probe", cwd: proj, turns: [{ prompt: "hi", reply: "ok" }] });
	// One Mac is saved from this computer, so that a refused rename, removal or pin would have something to change (#628).
	const added = await onThisComputer().send("/api/macs", {
		method: "POST",
		body: { name: "Studio", address: "studio.example.com" },
	});
	expect(added.status).toBe(200);
	macId = (await added.json()).mac.id;
}, 120_000);

afterAll(async () => {
	await s?.stop();
	await bound?.stop();
	releases?.stop(true);
	rmSync(root, { recursive: true, force: true });
});

/** A request as a kind of page makes it: with the token (header) unless `token` is false; headers as given. */
interface Ask {
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
	token?: boolean;
}
interface Page {
	/** The server the page talks to: its token, and the port. */
	server: TestServer;
	send(path: string, ask?: Ask): Promise<Response>;
}

function headersOf(server: TestServer, ask: Ask): Record<string, string> {
	const out: Record<string, string> = {};
	if (ask.token !== false) out["x-omp-webui-token"] = server.accessToken;
	if (ask.method && ask.method !== "GET") out["x-omp-webui"] = "1";
	if (ask.body !== undefined) out["content-type"] = "application/json";
	return { ...out, ...ask.headers };
}

const bodyOf = (ask: Ask) => (ask.body === undefined ? undefined : JSON.stringify(ask.body));

/** The page on this computer: a connection from 127.0.0.1. */
function onThisComputer(): Page {
	return {
		server: s,
		send: (path, ask = {}) =>
			fetch(`${s.url}${path}`, {
				method: ask.method ?? "GET",
				headers: headersOf(s, ask),
				body: bodyOf(ask),
				redirect: "manual",
			}),
	};
}

/** A page on the network of the server on the loopback: this computer's network address is where it is from. */
function peerOfLoopback(): Page {
	return {
		server: s,
		send: (path, ask = {}) =>
			rawRequest({
				host: "127.0.0.1",
				port: portOf(s),
				from: LAN,
				method: ask.method,
				path,
				headers: headersOf(s, ask),
				body: bodyOf(ask),
			}),
	};
}

/** A page on the network of the server bound to the network address: it names the server by that address. */
function peerOfBound(): Page {
	const server = bound as TestServer;
	return {
		server,
		send: (path, ask = {}) =>
			rawRequest({
				host: LAN as string,
				port: portOf(server),
				method: ask.method,
				path,
				headers: headersOf(server, ask),
				body: bodyOf(ask),
			}),
	};
}

const isRemotePage = async (page: Page, headers: Record<string, string> = {}): Promise<boolean> => {
	const body: MetaAnswer = await (await page.send("/api/meta", { headers })).json();
	expect(body.local, "meta.local says the opposite of meta.remote").toBe(!body.remote);
	return body.remote;
};

const GET_ONLY: string[] = [MIGRATE_API.plan, MIGRATE_API.state, MIGRATE_API.exportFile];
const MIGRATE_ROUTES = Object.values(MIGRATE_API).map((path) => ({
	method: GET_ONLY.includes(path) ? "GET" : "POST",
	path: path === MIGRATE_API.importChunk ? `${path}?offset=0` : path,
	body: GET_ONLY.includes(path) ? undefined : {},
}));

/** Every route that is for this computer alone, with a request that would do something if it were let through. */
const ROUTES: { method: string; path: string; body?: unknown }[] = [
	{ method: "GET", path: "/api/guard" },
	{ method: "POST", path: "/api/guard", body: { mode: "ask" } },
	// One conversation's own settings over these (#626): the same decision, the route being under `/api/guard`.
	{ method: "POST", path: "/api/guard/live", body: { liveId: "L0-nope", guard: { mode: "off" } } },
	{ method: "GET", path: "/api/guard/log" },
	{ method: "GET", path: "/api/guard/decisions?session=x" },
	// What the person tuned of the guard (#638): the reviewer's rules, a threshold per kind, their benchmark cases, and the benchmark.
	{ method: "GET", path: "/api/guard/rules" },
	{
		method: "POST",
		path: "/api/guard/rules",
		body: { thresholds: { delete_outside: "allow" }, policy: { text: "Everything: allow." } },
	},
	{ method: "GET", path: "/api/guard/bench" },
	{ method: "POST", path: "/api/guard/bench", body: { reviewer: true } },
	{ method: "POST", path: "/api/guard/bench/cancel", body: {} },
	{ method: "POST", path: "/api/guard/bench/preview", body: { thresholds: { delete_outside: "allow" } } },
	{ method: "GET", path: "/api/guard/anything" },
	{ method: "GET", path: "/api/remote" },
	{ method: "POST", path: "/api/remote/config", body: { enabled: true, hostname: "omp.example.com" } },
	...["install", "login", "setup", "start", "stop", "check", "ai/start"].map((route) => ({
		method: "POST",
		path: `/api/remote/${route}`,
		body: {},
	})),
	{ method: "POST", path: "/api/remote/ai", body: { enabled: true } },
	{ method: "GET", path: "/api/remote/anything" },
	{ method: "GET", path: "/api/update" },
	...["check", "cancel", "dismiss"].map((route) => ({ method: "POST", path: `/api/update/${route}`, body: {} })),
	{ method: "POST", path: "/api/update/install", body: { tag: "v9.9.9", anyway: true } },
	{ method: "GET", path: "/api/update/anything" },
	{ method: "GET", path: "/api/migrate" },
	{ method: "GET", path: "/api/migrate/anything" },
	// What the macOS app is told on its own (#627): the titles of the conversations that need somebody, for its notifications.
	{ method: "GET", path: "/api/shell/events" },
	{ method: "GET", path: "/api/shell/anything" },
	// The same stream for the app of another Mac (#656): let in only for a request that passed Cloudflare Access, or from here.
	{ method: "GET", path: "/api/notify/events" },
	// The app's notice that its window is going away: it makes the next page's terminals outlive it.
	{ method: "POST", path: "/api/shell/background", body: {} },
	{ method: "DELETE", path: "/api/shell/background" },
	...MIGRATE_ROUTES,
	// Where projects are made: told by the same decision, in the route itself (reading it, and making a folder in it, are open).
	{ method: "POST", path: "/api/projects", body: { folder: join(root, "projects-elsewhere") } },
	// The saved Macs (#628): every route of the list changes it, so it is this computer's alone (`:mac` is the one that is saved).
	{ method: "POST", path: "/api/macs", body: { name: "Intruder", address: "evil.example.com" } },
	{ method: "POST", path: "/api/macs/:mac/rename", body: { name: "Renamed" } },
	{ method: "POST", path: "/api/macs/:mac/connected", body: {} },
	{ method: "POST", path: "/api/macs/:mac/team", body: { team: "evil" } },
	{ method: "DELETE", path: "/api/macs/:mac" },
	{ method: "GET", path: "/api/macs" },
	{ method: "GET", path: "/api/macs/anything" },
];

/** What a refused request would have changed or run, looked at from the page on this computer. */
async function whatCouldHaveChanged() {
	const here = onThisComputer();
	const [guard, rules, bench, remote, migrate, projects, meta] = await Promise.all([
		here.send("/api/guard").then((r) => r.json()),
		here.send("/api/guard/rules").then((r) => r.json()),
		here.send("/api/guard/bench").then((r) => r.json()),
		here.send("/api/remote").then((r) => r.json()),
		here.send("/api/migrate/state").then((r) => r.json()),
		here.send("/api/projects").then((r) => r.json()),
		here.send("/api/meta").then((r) => r.json()),
	]);
	// The saved Macs (#628) are read by every page and changed by this computer's alone.
	const { macs }: MetaAnswer = meta;
	return {
		guard,
		rules,
		// A refused POST must not have started a run: no run exists.
		run: (bench as { run: unknown }).run,
		remote,
		migrate,
		projects,
		macs,
		releases: [...asked],
		tunnel: program.calls(),
		brew: program.brewCalls(),
	};
}

/** What a page that holds the token may try: none of it makes it this computer's. */
const SPOOFS: [string, (port: number) => Record<string, string>][] = [
	["its own address as the Host", () => ({})],
	["Host: 127.0.0.1", (port) => ({ host: `127.0.0.1:${port}` })],
	["Host: localhost", (port) => ({ host: `localhost:${port}` })],
	["Host: [::1]", (port) => ({ host: `[::1]:${port}` })],
	[
		"an Origin of the loopback, and the Host to match",
		(port) => ({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }),
	],
	["Sec-Fetch-Site: same-origin", () => ({ "sec-fetch-site": "same-origin" })],
	["X-Forwarded-For: 127.0.0.1", () => ({ "x-forwarded-for": "127.0.0.1" })],
	["X-Real-IP: 127.0.0.1", () => ({ "x-real-ip": "127.0.0.1" })],
	["Forwarded: for=127.0.0.1", () => ({ forwarded: "for=127.0.0.1;host=127.0.0.1" })],
	["X-Forwarded-Host: 127.0.0.1", (port) => ({ "x-forwarded-host": `127.0.0.1:${port}` })],
];

/** One route of each family that is this computer's alone. */
const FAMILIES = [
	"/api/guard",
	"/api/remote",
	"/api/update",
	"/api/migrate/state",
	"/api/shell/events",
	"/api/notify/events",
];

networkOnly("a page on the network that holds the token", () => {
	const pages: [string, () => Page][] = [
		["a peer on the network of a server on the loopback", peerOfLoopback],
		["a peer of the server bound to the network address", peerOfBound],
	];

	for (const [name, make] of pages) {
		describe(name, () => {
			test("is refused every route that is for this computer alone, and nothing is changed or run", async () => {
				const page = make();
				const before = await whatCouldHaveChanged();
				for (const route of ROUTES) {
					const path = route.path.replace(":mac", macId);
					const res = await page.send(path, { method: route.method, body: route.body });
					expect(res.status, `${route.method} ${path}`).toBe(403);
				}
				expect(await whatCouldHaveChanged()).toEqual(before);
				expect(before.tunnel).toEqual([]);
				expect(before.brew).toEqual([]);
				expect(before.releases).toEqual([]);
			}, 60_000);

			test("is not this computer by what it says: no Host, Origin or forwarding header makes it one", async () => {
				const page = make();
				const port = portOf(page.server);
				for (const [what, spoof] of SPOOFS) {
					for (const path of FAMILIES) {
						const res = await page.send(path, { headers: spoof(port) });
						expect(res.status, `${what}: ${path}`).toBe(403);
					}
					const post = await page.send("/api/guard", { method: "POST", body: { mode: "ask" }, headers: spoof(port) });
					expect(post.status, `${what}: POST /api/guard`).toBe(403);
					expect(await isRemotePage(page, spoof(port)), `${what}: meta`).toBe(true);
				}
				const guard: GuardAnswer = await (await onThisComputer().send("/api/guard")).json();
				expect(guard.config.mode).toBe("off");
			}, 60_000);

			test("is refused them whatever the token is carried in, and no token is no API", async () => {
				const page = make();
				const cookie = { cookie: `ompw_token=${page.server.accessToken}` };
				expect((await page.send("/api/guard", { token: false, headers: cookie })).status).toBe(403);
				expect((await page.send("/api/guard", { token: false })).status).toBe(403);
				expect((await page.send("/api/sessions", { token: false })).status).toBe(401);
			});

			test("is told it is a remote page, and is served the rest of the API as before", async () => {
				const page = make();
				expect(await isRemotePage(page)).toBe(true);
				for (const path of ["/api/sessions", "/api/prefs", "/api/lives", "/api/mode", "/api/models", "/api/projects"])
					expect((await page.send(path)).status, path).toBe(200);
				// The page on this computer is told it is not.
				expect(await isRemotePage(onThisComputer())).toBe(false);
			});

			test("can sign in with the token it was given, by /?token= and by POST /api/auth, so that a browser on the network can use the app", async () => {
				const page = make();
				const { accessToken } = page.server;
				const link = await page.send(`/?token=${accessToken}`, { token: false });
				expect(link.status).toBe(303);
				const cookie = link.headers.get("set-cookie") ?? "";
				expect(cookie).toContain(`ompw_token=${accessToken}`);
				expect(cookie).toContain("HttpOnly");
				expect((await page.send("/?token=wrong", { token: false })).status).toBe(401);

				const post = await page.send("/api/auth", { method: "POST", body: { token: accessToken }, token: false });
				expect(post.status).toBe(200);
				expect(post.headers.get("set-cookie") ?? "").toContain(`ompw_token=${accessToken}`);
				const wrong = await page.send("/api/auth", { method: "POST", body: { token: "wrong" }, token: false });
				expect(wrong.status).toBe(401);
				expect(wrong.headers.get("set-cookie")).toBeNull();

				// With the cookie it was given it is a signed-in page of the network: the API, and not what is this computer's.
				const cookies = { cookie: cookie.split(";")[0] ?? "" };
				expect((await page.send("/api/sessions", { token: false, headers: cookies })).status).toBe(200);
				expect((await page.send("/api/guard", { token: false, headers: cookies })).status).toBe(403);
				expect((await page.send("/api/remote", { token: false, headers: cookies })).status).toBe(403);
			});
		});
	}

	describe("the Files tab", () => {
		const page = peerOfLoopback;
		const filePath = (path: string) => `/api/folder/file?${new URLSearchParams({ file, path })}`;

		test("is not let open or reveal a file, and is told so by name; this computer's page passes that gate", async () => {
			for (const reveal of [false, true]) {
				const res = await page().send("/api/folder/open", { method: "POST", body: { file, path: "run.sh", reveal } });
				expect(res.status).toBe(403);
				expect(await res.json()).toEqual({ error: "Opening files is only for the page on this computer" });
				// This computer's page passes that gate. What it asks for is a conversation nobody has, so that nothing is
				// ever handed to macOS from a test (a reveal of a real file would open a Finder window).
				const here = await onThisComputer().send("/api/folder/open", {
					method: "POST",
					body: { file: "no-such-conversation.jsonl", path: "run.sh", reveal },
				});
				expect(here.status).toBe(404);
				expect(await here.json()).toEqual({ error: "Unknown conversation" });
			}
			for (const header of ["x-forwarded-for", "forwarded", "x-real-ip"]) {
				const res = await page().send("/api/folder/open", {
					method: "POST",
					body: { file, path: "run.sh" },
					headers: { [header]: "127.0.0.1" },
				});
				expect(await res.json(), header).toEqual({ error: "Opening files is only for the page on this computer" });
			}
		});

		test("is not let open the folder either, the conversation's own or one in it; this computer's page passes that gate", async () => {
			for (const path of ["", "src"]) {
				const res = await page().send("/api/folder/open", { method: "POST", body: { file, path, dir: true } });
				expect(res.status, path).toBe(403);
				expect(await res.json(), path).toEqual({ error: "Opening files is only for the page on this computer" });
				// This computer's page passes that gate; the conversation is one nobody has, so nothing is ever handed to macOS.
				const here = await onThisComputer().send("/api/folder/open", {
					method: "POST",
					body: { file: "no-such-conversation.jsonl", path, dir: true },
				});
				expect(here.status, path).toBe(404);
				expect(await here.json(), path).toEqual({ error: "Unknown conversation" });
			}
			const listing: FolderListing = await (
				await page().send(`/api/folder/list?${new URLSearchParams({ file, path: "" })}`)
			).json();
			expect(listing.local).toBeUndefined();
		});

		test("is shown the folder as a remote page is: what looks like a secret is not read, nor listed", async () => {
			const read = await page().send(filePath(".env"));
			expect(read.status).toBe(403);
			expect(await read.text()).not.toContain("SECRET");
			const listing: FolderListing = await (
				await page().send(`/api/folder/list?${new URLSearchParams({ file, path: "", all: "1" })}`)
			).json();
			expect(listing.guarded).toBe(true);
			expect(listing.entries.map((e) => e.name)).not.toContain(".env");
			// The page on this computer is given all of it.
			const local: FolderFile = await (await onThisComputer().send(filePath(".env"))).json();
			expect(local).toMatchObject({ kind: "text", text: "SECRET=1\n" });
		});
	});

	describe("the socket", () => {
		const open = async (): Promise<NetSocket> => {
			const socket = await rawSocket({
				host: "127.0.0.1",
				port: portOf(s),
				from: LAN,
				headers: { origin: s.url, cookie: `ompw_token=${s.accessToken}` },
			});
			if (!socket) throw new Error("the server refused the socket of a page on the network");
			return socket;
		};

		test("opens with the token, and is told nothing that is for this computer: the guard's settings are said to its pages only", async () => {
			const home = await connect(s);
			const away = await open();
			try {
				const guardSaid = messageWhere(home, (m) => m.t === "guard_config");
				const saved = await onThisComputer().send("/api/guard", { method: "POST", body: { mode: "off" } });
				expect(saved.status).toBe(200);
				await guardSaid;
				// A page on the network is asked something that is answered after what was said to it before, on the one
				// connection: by its answer, everything the server had to tell it has come.
				const answered = Promise.withResolvers<void>();
				away.addEventListener("message", ((ev: MessageEvent) => {
					if (JSON.parse(String(ev.data)).req === "after") answered.resolve();
				}) as never);
				away.send(JSON.stringify({ t: "list_lives", req: "after" }));
				await answered.promise;
				const said = away.received.map((text) => JSON.parse(text).t as string);
				expect(said).toContain("hello");
				expect(said).not.toContain("guard_config");
			} finally {
				home.close();
				away.close();
			}
		});

		test("is refused without the token, and for the Host of another site", async () => {
			const refused = (headers: Record<string, string>) =>
				rawSocket({ host: "127.0.0.1", port: portOf(s), from: LAN, headers });
			expect(await refused({ origin: s.url })).toBeNull();
			expect(await refused({ host: "evil.example.com", cookie: `ompw_token=${s.accessToken}` })).toBeNull();
		});
	});
});

describe("a page on this computer", () => {
	test("is let to the routes that are its own, by any name the loopback has", async () => {
		const page = onThisComputer();
		const port = portOf(s);
		for (const path of [
			"/api/guard",
			"/api/guard/log",
			"/api/remote",
			"/api/update",
			"/api/migrate/plan",
			"/api/migrate/state",
		]) {
			expect((await page.send(path)).status, path).toBe(200);
			for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
				const res = await page.send(path, { headers: { host } });
				expect(res.status, `${host} ${path}`).toBe(200);
			}
		}
		const saved = await page.send("/api/guard", { method: "POST", body: { mode: "off" } });
		expect(saved.status).toBe(200);
		// The setting of the projects folder passes the gate here: what it is asked is no folder name, so nothing is changed.
		const shape = await page.send("/api/projects", { method: "POST", body: { folder: 5 } });
		expect(shape.status).toBe(400);
		expect(await isRemotePage(page)).toBe(false);
	});

	test("behind a proxy on this computer, or with what Cloudflare adds, is not this computer, whatever the socket is", async () => {
		const page = onThisComputer();
		const proxied: Record<string, string>[] = [
			{ "x-forwarded-for": "203.0.113.9" },
			{ forwarded: "for=203.0.113.9" },
			{ "x-real-ip": "203.0.113.9" },
			{ via: "1.1 proxy" },
			{ "cf-connecting-ip": "203.0.113.9" },
			{ "cf-ray": "8a1b2c3d4e5f-SJC" },
			{ "cdn-loop": "cloudflare" },
		];
		for (const headers of proxied) {
			for (const path of FAMILIES) {
				const res = await page.send(path, { headers });
				expect(res.status, `${JSON.stringify(headers)} ${path}`).toBe(403);
			}
		}
		expect(await isRemotePage(page, { "x-forwarded-for": "203.0.113.9" })).toBe(true);
	});
});
