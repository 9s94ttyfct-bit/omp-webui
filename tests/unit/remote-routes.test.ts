import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import { commandOf } from "../../server/instance.ts";
import { RemoteService } from "../../server/remote-routes.ts";
import type { TunnelTimings } from "../../server/remote-tunnel.ts";
import { isThisComputer } from "../../server/this-computer.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { RemoteLogin, RemoteSnapshot } from "../../shared/remote.ts";
import { FAKE_TUNNEL_ID, makeFakeCloudflared } from "../support/fake-cloudflared.ts";
import { pollUntil, processExists } from "../support/poll.ts";

/**
 * `/api/remote*` against the fake cloudflared: every call, what each answers, that a request that came through the tunnel
 * is refused before anything runs, and that the tunnel starts with the app when it is told to.
 */

const AUD = "c".repeat(64);
const HOST = "omp.example.com";
const FAST: Partial<TunnelTimings> = { backoffMs: [40], stableMs: 400, stopGraceMs: 3000, loginUrlMs: 8000 };

const dirs: string[] = [];
const services: RemoteService[] = [];
afterEach(async () => {
	for (const s of services.splice(0)) await s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world(o: { installed?: boolean; host?: string } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "ompw-remote-routes-"));
	dirs.push(dir);
	const fake = makeFakeCloudflared(join(dir, "fake"), { installed: o.installed });
	const pushed: ServerMessage[] = [];
	const service = new RemoteService({
		dataDir: join(dir, "data"),
		host: o.host ?? "127.0.0.1",
		port: 4242,
		broadcast: (m) => pushed.push(m),
		env: { PATH: process.env.PATH, OMP_WEBUI_CLOUDFLARED: fake.bin, OMP_WEBUI_BREW: fake.brew },
		home: fake.home,
		extraDirs: [],
		timings: FAST,
	});
	services.push(service);
	const signIn = () => {
		mkdirSync(join(fake.home, ".cloudflared"), { recursive: true });
		writeFileSync(join(fake.home, ".cloudflared", "cert.pem"), "cert");
	};
	return { dir, fake, service, pushed, signIn };
}

/** A request the way the page makes it: to the loopback address, from the loopback, with no Cloudflare header. */
function ask(
	w: { service: RemoteService },
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
	peer: string | null = "127.0.0.1",
) {
	const url = new URL(`http://127.0.0.1:4242${path}`);
	const req = new Request(url, {
		method,
		headers: {
			host: "127.0.0.1:4242",
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return w.service.handle(req, url, peer ?? undefined);
}

async function answer<T = RemoteSnapshot>(
	w: { service: RemoteService },
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: T & { error?: string } }> {
	const res = await ask(w, method, path, body);
	if (!res) throw new Error(`${path} was not answered`);
	return { status: res.status, body: (await res.json()) as T & { error?: string } };
}

describe("who may use it", () => {
	const POSTS = ["config", "install", "login", "setup", "start", "stop"];

	test("a request that came through the tunnel is refused before anything runs, on every route", async () => {
		const w = world();
		w.signIn();
		const remoteHeaders: Record<string, string>[] = [
			// What reaches this server from the tunnel: the public Host, and what Cloudflare adds.
			{ host: HOST, "cf-connecting-ip": "203.0.113.9", "cf-ray": "8a1b2c3d4e5f-SJC" },
			// A request that the tunnel made look local is still one: Cloudflare's own headers.
			{ host: "127.0.0.1:4242", "cf-connecting-ip": "203.0.113.9" },
			{ host: "localhost:4242", "cf-access-jwt-assertion": "a.b.c" },
			{ host: "127.0.0.1:4242", "cdn-loop": "cloudflare; loops=1" },
			// The Host alone.
			{ host: HOST },
			{ host: "" },
		];
		for (const headers of remoteHeaders) {
			for (const path of ["/api/remote", ...POSTS.map((p) => `/api/remote/${p}`)]) {
				const method = path === "/api/remote" ? "GET" : "POST";
				const res = await ask(w, method, path, method === "POST" ? { enabled: true } : undefined, headers);
				expect(res?.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(403);
			}
		}
		// Nothing was changed, started or run on the way.
		expect(w.fake.calls()).toEqual([]);
		expect(w.fake.brewCalls()).toEqual([]);
		expect(w.service.store.read().enabled).toBe(false);
		expect(w.service.tunnel.status()).toEqual({ state: "off" });
	});

	test("a request over a network address the server listens on is refused before anything runs, on every route", async () => {
		// The server is bound to its network address (`OMP_WEBUI_HOST`), which is the Host its clients use. The Host and the
		// headers are those of a page on this computer; the socket is not.
		const w = world({ host: "10.0.0.5" });
		w.signIn();
		const asked: [Record<string, string>, string | null][] = [
			[{ host: "10.0.0.5:4242" }, "10.0.0.7"],
			[{ host: "10.0.0.5:4242" }, "10.0.0.5"],
			[{ host: "127.0.0.1:4242" }, "10.0.0.7"],
			[{ host: "localhost:4242" }, "192.168.1.20"],
			[{ host: "127.0.0.1:4242" }, "::ffff:10.0.0.7"],
			[{ host: "127.0.0.1:4242" }, "fe80::1"],
			[{ host: "127.0.0.1:4242" }, null],
			// A proxy on this computer that carries the network's requests to it.
			[{ host: "127.0.0.1:4242", "x-forwarded-for": "10.0.0.7" }, "127.0.0.1"],
			[{ host: "127.0.0.1:4242", forwarded: "for=10.0.0.7" }, "::1"],
		];
		for (const [headers, peer] of asked) {
			for (const path of ["/api/remote", ...POSTS.map((p) => `/api/remote/${p}`)]) {
				const method = path === "/api/remote" ? "GET" : "POST";
				const res = await ask(w, method, path, method === "POST" ? { enabled: true } : undefined, headers, peer);
				expect(res?.status, `${method} ${path} ${JSON.stringify(headers)} from ${peer}`).toBe(403);
			}
		}
		expect(w.fake.calls()).toEqual([]);
		expect(w.fake.brewCalls()).toEqual([]);
		expect(w.service.store.read().enabled).toBe(false);
		expect(w.service.tunnel.status()).toEqual({ state: "off" });
	});

	test("the person at this computer is let in by any of the names the loopback answers to, from any form of it", () => {
		const ask = (host: string, peer: string | undefined) =>
			isThisComputer(new Request("http://x/", { headers: { host } }), peer);
		for (const host of ["127.0.0.1:7878", "localhost:7878", "[::1]:7878", "127.0.0.1"]) {
			for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.2"])
				expect(ask(host, peer), `${host} from ${peer}`).toBe(true);
		}
		// The server's own network address is not a name for this computer, from wherever it is asked.
		for (const peer of ["127.0.0.1", "::1", "10.0.0.5", undefined])
			expect(ask("mac.local:7878", peer), `mac.local from ${peer}`).toBe(false);
	});

	test("what is not for remote access is not answered here", async () => {
		const w = world();
		for (const path of ["/api/meta", "/api/remotely", "/api/remote-x", "/"]) {
			const url = new URL(`http://127.0.0.1:4242${path}`);
			expect(
				await w.service.handle(new Request(url, { headers: { host: "127.0.0.1:4242" } }), url, "127.0.0.1"),
				path,
			).toBeNull();
		}
	});
});

describe("the routes", () => {
	test("GET /api/remote: the settings, the state, what this machine has, and the public URL", async () => {
		const w = world({ installed: false });
		expect(await answer(w, "GET", "/api/remote")).toEqual({
			status: 200,
			body: {
				config: {
					enabled: false,
					hostname: "",
					team: "",
					aud: "",
					emails: [],
					autostart: false,
					confirmRisky: false,
					fileTransfer: "full",
					remoteShell: true,
				},
				status: { state: "off" },
				installed: false,
				loggedIn: false,
				url: "",
				ai: { enabled: false, conversations: [] },
			},
		});
		w.signIn();
		await answer(w, "POST", "/api/remote/config", { hostname: HOST });
		const after = await answer(w, "GET", "/api/remote");
		expect(after.body.url).toBe(`https://${HOST}`);
		expect(after.body.loggedIn).toBe(true);
	});

	test("POST /api/remote/config changes what it names, answers the whole, and refuses a value that does not fit", async () => {
		const w = world();
		const changed = await answer(w, "POST", "/api/remote/config", {
			hostname: HOST,
			team: "Example",
			aud: AUD,
			emails: ["Me@Example.com"],
			autostart: true,
		});
		expect(changed.status).toBe(200);
		expect(changed.body.config).toMatchObject({
			hostname: HOST,
			team: "example",
			aud: AUD,
			emails: ["me@example.com"],
			autostart: true,
			enabled: false,
		});
		expect(JSON.parse(readFileSync(join(w.dir, "data", "remote.json"), "utf8")).team).toBe("example");

		for (const bad of [{ hostname: "not a host" }, { aud: "abc" }, { emails: ["x"] }, { autostart: "yes" }, [], "x"]) {
			const refused = await answer(w, "POST", "/api/remote/config", bad);
			expect(refused.status, JSON.stringify(bad)).toBe(400);
			expect(typeof refused.body.error).toBe("string");
		}
		const unchanged = await answer(w, "GET", "/api/remote");
		expect(unchanged.body.config.team).toBe("example");
		expect(unchanged.body.config.hostname).toBe(HOST);

		// A page cannot point the server at another tunnel.
		const named = await answer(w, "POST", "/api/remote/config", { tunnelId: FAKE_TUNNEL_ID, tunnelName: "x" });
		expect(named.body.config.tunnelId).toBeUndefined();
	});

	test("a body that is not JSON is a refused change, not a server error", async () => {
		const w = world();
		const url = new URL("http://127.0.0.1:4242/api/remote/config");
		const res = await w.service.handle(
			new Request(url, { method: "POST", headers: { host: "127.0.0.1:4242" }, body: "{not json" }),
			url,
			"127.0.0.1",
		);
		expect(res?.status).toBe(400);
	});

	test("the wrong method, and a route there is none of", async () => {
		const w = world();
		expect((await answer(w, "POST", "/api/remote")).status).toBe(405);
		for (const p of ["config", "install", "login", "setup", "start", "stop"])
			expect((await answer(w, "GET", `/api/remote/${p}`)).status, p).toBe(405);
		expect((await answer(w, "POST", "/api/remote/nope")).status).toBe(404);
		expect(w.fake.calls()).toEqual([]);
	});

	test("the whole way: install, log in, set up, start, stop; the page is told at each state", async () => {
		const w = world({ installed: false });
		expect((await answer(w, "GET", "/api/remote")).body.installed).toBe(false);

		const installed = await answer(w, "POST", "/api/remote/install");
		expect(installed.body.installed).toBe(true);
		expect(w.fake.brewCalls()).toEqual(["install cloudflared"]);

		w.fake.setLoginUrl("https://dash.cloudflare.com/argotunnel?aud=&callback=x");
		const login = await answer<RemoteLogin>(w, "POST", "/api/remote/login");
		expect(login.body.loginUrl).toBe("https://dash.cloudflare.com/argotunnel?aud=&callback=x");
		expect(login.body.loggedIn).toBe(false);
		w.fake.approveLogin();
		await pollUntil(() => w.fake.hasCert(), "the login to end");
		expect((await answer(w, "GET", "/api/remote")).body.loggedIn).toBe(true);

		await answer(w, "POST", "/api/remote/config", {
			hostname: HOST,
			team: "example",
			aud: AUD,
			emails: ["me@example.com"],
		});
		expect((await answer(w, "POST", "/api/remote/setup")).status).toBe(200);
		expect(w.service.store.read().tunnelId).toBe(FAKE_TUNNEL_ID);

		const started = await answer(w, "POST", "/api/remote/start");
		expect(started.status).toBe(200);
		expect(started.body.config.enabled).toBe(true);
		await pollUntil(() => w.service.tunnel.status().state === "connected", "the tunnel to connect");
		const running = await answer(w, "GET", "/api/remote");
		expect(running.body.status).toEqual({ state: "connected" });
		expect(running.body.url).toBe(`https://${HOST}`);

		const stopped = await answer(w, "POST", "/api/remote/stop");
		expect(stopped.body.status).toEqual({ state: "off" });
		// Stop is off: remote requests are refused at once (the part that lets them in reads `enabled`), and it does not come back with the app.
		expect(stopped.body.config.enabled).toBe(false);

		const told = w.pushed.filter((m): m is Extract<ServerMessage, { t: "remote" }> => m.t === "remote");
		expect(told.length).toBeGreaterThan(0);
		const order = told.map((m) => m.status.state);
		expect(order).toEqual(expect.arrayContaining(["starting", "connected", "off"]));
		expect(order.indexOf("starting")).toBeLessThan(order.indexOf("connected"));
		expect(order.lastIndexOf("connected")).toBeLessThan(order.lastIndexOf("off"));
	});

	test("what cannot be done answers with the reason and a status the page can tell", async () => {
		const w = world({ installed: false });
		const login = await answer(w, "POST", "/api/remote/login");
		expect(login.status).toBe(400);
		expect(login.body.error).toContain("install");
		const setup = await answer(w, "POST", "/api/remote/setup");
		expect(setup.status).toBe(400);
		const start = await answer(w, "POST", "/api/remote/start");
		expect(start.status).toBe(400);
		w.fake.fail("brew");
		const install = await answer(w, "POST", "/api/remote/install");
		expect(install.status).toBe(502);
		expect(install.body.error).toContain("no available formula");
	});

	test("turning remote access off in the settings stops the tunnel", async () => {
		const w = world();
		w.signIn();
		await answer(w, "POST", "/api/remote/config", {
			hostname: HOST,
			team: "example",
			aud: AUD,
			emails: ["me@example.com"],
		});
		await answer(w, "POST", "/api/remote/setup");
		await answer(w, "POST", "/api/remote/start");
		await pollUntil(() => w.service.tunnel.status().state === "connected", "the tunnel to connect");
		const pid = w.fake.runPid(1);
		const off = await answer(w, "POST", "/api/remote/config", { enabled: false });
		expect(off.body.status).toEqual({ state: "off" });
		expect(off.body.config.enabled).toBe(false);
		expect(processExists(pid)).toBe(false);
	});
});

describe("with the app", () => {
	async function prepared(settings: Record<string, unknown>, o: { installed?: boolean } = {}) {
		const w = world(o);
		w.signIn();
		await answer(w, "POST", "/api/remote/config", {
			hostname: HOST,
			team: "example",
			aud: AUD,
			emails: ["me@example.com"],
		});
		if (o.installed !== false) await answer(w, "POST", "/api/remote/setup");
		await answer(w, "POST", "/api/remote/config", settings);
		return w;
	}

	test("the tunnel starts when the person asked for that and remote access is on", async () => {
		const w = await prepared({ autostart: true, enabled: true });
		await w.service.autostart();
		await pollUntil(() => w.service.tunnel.status().state === "connected", "the tunnel to connect");
		expect(w.fake.runs()).toBe(1);
	});

	test("it does not start when it was not asked to, or remote access is off, or the settings are not complete", async () => {
		const notAsked = await prepared({ autostart: false, enabled: true });
		await notAsked.service.autostart();
		const off = await prepared({ autostart: true, enabled: false });
		await off.service.autostart();
		const incomplete = await prepared({ autostart: true, enabled: true });
		await answer(incomplete, "POST", "/api/remote/config", { emails: [] });
		await incomplete.service.autostart();
		for (const w of [notAsked, off, incomplete]) {
			expect(w.fake.runs()).toBe(0);
			expect(w.service.tunnel.status()).toEqual({ state: "off" });
		}
	});

	test("a program that is not there is no reason for the app not to start", async () => {
		const w = world({ installed: false });
		w.service.store.patch({
			hostname: HOST,
			team: "example",
			aud: AUD,
			emails: ["me@example.com"],
			enabled: true,
			autostart: true,
		});
		await w.service.autostart();
		expect(w.service.tunnel.status()).toEqual({ state: "off" });
	});
});

describe("the server's own", () => {
	test("is answered by the service itself, and its tunnel ends when the service is closed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ompw-remote-service-"));
		dirs.push(dir);
		const fake = makeFakeCloudflared(join(dir, "fake"));
		const url = new URL("http://127.0.0.1:4242/api/remote");
		const req = () => new Request(url, { headers: { host: "127.0.0.1:4242" } });
		const other = new URL("http://127.0.0.1:4242/api/meta");

		const service = new RemoteService({
			dataDir: join(dir, "data"),
			host: "127.0.0.1",
			port: 4242,
			broadcast: () => {},
			env: { PATH: process.env.PATH, OMP_WEBUI_CLOUDFLARED: fake.bin },
			home: fake.home,
			extraDirs: [],
			timings: FAST,
		});
		services.push(service);

		// A request that is not for the remote API is not ours to answer.
		expect(await service.handle(new Request(other), other, "127.0.0.1")).toBeNull();

		const snapshot = (await (await service.handle(req(), url, "127.0.0.1"))?.json()) as RemoteSnapshot;
		expect(snapshot.installed).toBe(true);
		expect(await service.handle(new Request(other), other, "127.0.0.1")).toBeNull();

		mkdirSync(join(fake.home, ".cloudflared"), { recursive: true });
		writeFileSync(join(fake.home, ".cloudflared", "cert.pem"), "cert");
		service.store.patch({ hostname: HOST, team: "example", aud: AUD, emails: ["me@example.com"] });
		await service.tunnel.setup();
		await service.tunnel.start();
		await pollUntil(() => service.tunnel.status().state === "connected", "the tunnel to connect");
		const pid = fake.runPid(1);
		await service.close();
		expect(processExists(pid)).toBe(false);
		expect(service.tunnel.status()).toEqual({ state: "off" });
	});
});

describe("a tunnel a crashed server left behind", () => {
	const strays: Subprocess[] = [];
	afterEach(() => {
		for (const p of strays.splice(0)) p.kill("SIGKILL");
	});

	/** A set-up world with a `cloudflared` running that no server of this process started, and its record. */
	async function crashed(settings: Record<string, unknown>) {
		const w = world();
		w.signIn();
		await answer(w, "POST", "/api/remote/config", {
			hostname: HOST,
			team: "example",
			aud: AUD,
			emails: ["me@example.com"],
		});
		await answer(w, "POST", "/api/remote/setup");
		await answer(w, "POST", "/api/remote/config", settings);
		const data = join(w.dir, "data");
		const old = spawn(
			[w.fake.bin, "tunnel", "--no-autoupdate", "--config", join(data, "cloudflared.yml"), "run", FAKE_TUNNEL_ID],
			{
				env: { PATH: process.env.PATH, HOME: w.fake.home },
				stdout: "ignore",
				stderr: "ignore",
				detached: true,
			},
		);
		strays.push(old);
		await pollUntil(() => w.fake.runs() === 1, "the leftover to start");
		writeFileSync(join(data, "cloudflared.pid"), JSON.stringify({ pid: old.pid, command: commandOf(old.pid) }));
		return { w, old };
	}

	test("a server that comes up ends it whatever the settings say: no autostart, or remote access off", async () => {
		for (const settings of [
			{ autostart: false, enabled: true },
			{ autostart: true, enabled: false },
		]) {
			const { w, old } = await crashed(settings);
			await w.service.autostart();
			await pollUntil(() => !processExists(old.pid), `the leftover to end (${JSON.stringify(settings)})`);
			expect(w.fake.runs()).toBe(1);
			expect(w.service.tunnel.status()).toEqual({ state: "off" });
		}
	});

	test("Stop ends it and turns remote access off in the same answer", async () => {
		const { w, old } = await crashed({ enabled: true });
		const stopped = await answer(w, "POST", "/api/remote/stop");
		expect(stopped.status).toBe(200);
		expect(stopped.body.config.enabled).toBe(false);
		await pollUntil(() => !processExists(old.pid), "the leftover to end");
	});

	test("turning remote access off in the settings ends it too", async () => {
		const { w, old } = await crashed({ enabled: true });
		await answer(w, "POST", "/api/remote/config", { enabled: false });
		await pollUntil(() => !processExists(old.pid), "the leftover to end");
	});

	test("one that another server of this data dir is running is not ended by this one", async () => {
		const { w, old } = await crashed({ enabled: true });
		// The record names its server: a process that is alive and is not this one.
		const other = spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore", detached: true });
		strays.push(other);
		const file = join(w.dir, "data", "cloudflared.pid");
		writeFileSync(file, JSON.stringify({ pid: old.pid, command: commandOf(old.pid), owner: other.pid }));
		await w.service.autostart();
		await answer(w, "POST", "/api/remote/stop");
		expect(processExists(old.pid)).toBe(true);
		expect(readFileSync(file, "utf8")).toContain(`"owner":${other.pid}`);
	});
});

describe("Confirm risky commands from remote pages", () => {
	test("it is off for a fresh install, and the person at this computer turns it on and off", async () => {
		const w = world();
		expect((await answer(w, "GET", "/api/remote")).body.config.confirmRisky).toBe(false);
		const on = await answer(w, "POST", "/api/remote/config", { confirmRisky: true });
		expect(on.status).toBe(200);
		expect(on.body.config.confirmRisky).toBe(true);
		expect(JSON.parse(readFileSync(join(w.dir, "data", "remote.json"), "utf8")).confirmRisky).toBe(true);
		expect((await answer(w, "POST", "/api/remote/config", { confirmRisky: false })).body.config.confirmRisky).toBe(
			false,
		);
		// The other settings are not touched by it.
		expect((await answer(w, "POST", "/api/remote/config", { confirmRisky: true })).body.config).toMatchObject({
			enabled: false,
			autostart: false,
			confirmRisky: true,
		});
	});

	test("a request that came through the tunnel cannot change it, whatever it says", async () => {
		const w = world();
		for (const confirmRisky of [true, false]) {
			const viaTunnel: Record<string, string>[] = [
				{ host: HOST, "cf-connecting-ip": "203.0.113.9" },
				{ host: HOST },
				{ host: "127.0.0.1:4242", "cdn-loop": "cloudflare" },
			];
			for (const headers of viaTunnel) {
				const res = await ask(w, "POST", "/api/remote/config", { confirmRisky }, headers);
				expect(res?.status, JSON.stringify(headers)).toBe(403);
			}
		}
		expect(w.service.store.read().confirmRisky).toBe(false);
		await answer(w, "POST", "/api/remote/config", { confirmRisky: true });
		const refused = await ask(w, "POST", "/api/remote/config", { confirmRisky: false }, { host: HOST });
		expect(refused?.status).toBe(403);
		expect(w.service.store.read().confirmRisky).toBe(true);
	});

	test("a value that is not true or false is refused, and nothing is changed", async () => {
		const w = world();
		for (const bad of ["yes", 1, null, "true"]) {
			const res = await answer(w, "POST", "/api/remote/config", { confirmRisky: bad });
			expect(res.status, String(bad)).toBe(400);
		}
		expect(w.service.store.read().confirmRisky).toBe(false);
	});
});
