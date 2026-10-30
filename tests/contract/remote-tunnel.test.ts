import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { RemoteLogin, RemoteSnapshot } from "../../shared/remote.ts";
import { FAKE_TUNNEL_ID, makeFakeCloudflared } from "../support/fake-cloudflared.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect } from "../support/ws.ts";

/**
 * Remote access's tunnel against the real server and the fake cloudflared: the whole API over HTTP, the status on the
 * socket, a request that came through the tunnel refused, and that the tunnel ends with the server, or, when the server
 * was killed, before the next one starts its own.
 */

const AUD = "d".repeat(64);
const HOST = "omp.example.com";

const root = mkdtempSync(join(tmpdir(), "ompw-remote-tunnel-"));
const fake = makeFakeCloudflared(join(root, "fake"), { installed: false });
let s: TestServer;

beforeAll(async () => {
	s = await startTestServer(
		0,
		{ OMP_WEBUI_CLOUDFLARED: fake.bin, OMP_WEBUI_BREW: fake.brew },
		// Nothing here calls a model.
		{ login: false },
	);
}, 60_000);

afterAll(async () => {
	// A tunnel that outlived its server (the test of a killed one) must not outlive the run.
	for (const line of fake.events()) {
		const pid = /^run \d+ pid=(\d+)$/.exec(line)?.[1];
		if (!pid) continue;
		try {
			process.kill(-Number(pid), "SIGKILL");
		} catch {}
	}
	await s?.stop();
	rmSync(root, { recursive: true, force: true });
});

const headers = (extra: Record<string, string> = {}) => ({
	"x-omp-webui-token": s.accessToken,
	"x-omp-webui": "1",
	"content-type": "application/json",
	...extra,
});

async function api<T = RemoteSnapshot>(method: string, path: string, body?: unknown, extra?: Record<string, string>) {
	const res = await fetch(`${s.url}${path}`, {
		method,
		headers: headers(extra),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json().catch(() => ({}))) as T & { error?: string } };
}

const SETTINGS = { hostname: HOST, team: "example", aud: AUD, emails: ["me@example.com"] };

test("install, log in, set up, start and stop through the API; the page hears every state on the socket", async () => {
	const ws = await connect(s);
	const heard: ServerMessage[] = [];
	ws.addEventListener("message", (ev) => heard.push(JSON.parse(String(ev.data))));
	const states = () => heard.filter((m) => m.t === "remote").map((m) => (m.t === "remote" ? m.status.state : ""));

	expect((await api("GET", "/api/remote")).body).toMatchObject({
		installed: false,
		loggedIn: false,
		status: { state: "off" },
		url: "",
		config: { enabled: false },
	});

	expect((await api("POST", "/api/remote/install")).body.installed).toBe(true);
	expect(fake.brewCalls()).toEqual(["install cloudflared"]);

	fake.setLoginUrl("https://dash.cloudflare.com/argotunnel?aud=&callback=x");
	const login = await api<RemoteLogin>("POST", "/api/remote/login");
	expect(login.body.loginUrl).toBe("https://dash.cloudflare.com/argotunnel?aud=&callback=x");
	fake.approveLogin();
	await pollUntil(async () => (await api("GET", "/api/remote")).body.loggedIn, "the login to end");
	expect(existsSync(join(s.home, ".cloudflared", "cert.pem"))).toBe(true);

	expect((await api("POST", "/api/remote/config", SETTINGS)).status).toBe(200);
	const setup = await api("POST", "/api/remote/setup");
	expect(setup.status).toBe(200);
	expect(setup.body.config.tunnelId).toBe(FAKE_TUNNEL_ID);
	expect(fake.calls()).toContain(`tunnel route dns ${FAKE_TUNNEL_ID} ${HOST}`);

	// The data dir is private, and so is what is in it.
	const yml = readFileSync(join(s.root, "data", "cloudflared.yml"), "utf8");
	expect(yml).toMatch(/service: "http:\/\/127\.0\.0\.1:\d+"/);
	expect(yml).toContain(`- hostname: "${HOST}"`);

	const started = await api("POST", "/api/remote/start");
	expect(started.status).toBe(200);
	await pollUntil(
		async () => (await api("GET", "/api/remote")).body.status.state === "connected",
		"the tunnel to connect",
	);
	expect((await api("GET", "/api/remote")).body).toMatchObject({ url: `https://${HOST}`, config: { enabled: true } });
	const port = new URL(s.url).port;
	expect(fake.runConfig(1)).toContain(`http://127.0.0.1:${port}`);

	const stopped = await api("POST", "/api/remote/stop");
	expect(stopped.body.status).toEqual({ state: "off" });
	await pollUntil(() => states().includes("off"), "the socket to say it stopped");
	expect(states()).toEqual(expect.arrayContaining(["starting", "connected", "off"]));
	ws.close();
});

test("a request that came through the tunnel is refused on every route, and nothing is changed or run", async () => {
	const before = fake.calls().length;
	const runs = fake.runs();
	const config = readFileSync(join(s.root, "data", "remote.json"), "utf8");
	const throughTunnel = {
		"cf-connecting-ip": "203.0.113.9",
		"cf-ray": "8a1b2c3d4e5f-SJC",
		"cdn-loop": "cloudflare; loops=1",
	};
	for (const path of ["config", "install", "login", "setup", "start", "stop"]) {
		const res = await api(
			"POST",
			`/api/remote/${path}`,
			{ enabled: false, hostname: "evil.example.com" },
			throughTunnel,
		);
		expect(res.status, path).toBe(403);
	}
	expect((await api("GET", "/api/remote", undefined, throughTunnel)).status).toBe(403);
	expect(fake.calls().length).toBe(before);
	expect(fake.runs()).toBe(runs);
	expect(readFileSync(join(s.root, "data", "remote.json"), "utf8")).toBe(config);
	// And the same request without Cloudflare's headers is the person at this computer.
	expect((await api("GET", "/api/remote")).status).toBe(200);
});

test("the tunnel ends with the server, and the page's next server finds nothing of it running", async () => {
	await api("POST", "/api/remote/start");
	await pollUntil(
		async () => (await api("GET", "/api/remote")).body.status.state === "connected",
		"the tunnel to connect",
	);
	const pid = fake.runPid(fake.runs());
	expect(processExists(pid)).toBe(true);

	await s.restart();
	expect(processExists(pid)).toBe(false);
	// The settings survive the restart; the tunnel does not start by itself (the person did not ask for that).
	const after = (await api("GET", "/api/remote")).body;
	expect(after.config).toMatchObject({ enabled: true, hostname: HOST, tunnelId: FAKE_TUNNEL_ID, autostart: false });
	expect(after.status).toEqual({ state: "off" });
});

test("a tunnel a killed server left behind is ended when the next server starts its own", async () => {
	await api("POST", "/api/remote/config", { autostart: true });
	await api("POST", "/api/remote/start");
	await pollUntil(
		async () => (await api("GET", "/api/remote")).body.status.state === "connected",
		"the tunnel to connect",
	);
	const leftover = fake.runPid(fake.runs());

	// A crash gives the server no chance to end anything: the tunnel is still there, carrying the hostname to a dead port.
	await s.restart(undefined, { signal: "SIGKILL" });
	// The next server starts it with the app (the person asked for that) and ends the one that was left first.
	await pollUntil(
		async () => (await api("GET", "/api/remote")).body.status.state === "connected",
		"the new tunnel to connect",
	);
	expect(processExists(leftover)).toBe(false);
	expect(fake.runPid(fake.runs())).not.toBe(leftover);
	expect(processExists(fake.runPid(fake.runs()))).toBe(true);
});

test("a killed server's tunnel is ended when the next server comes up, also when nothing starts with the app; Stop turns remote access off", async () => {
	await api("POST", "/api/remote/config", { autostart: false, enabled: true });
	await api("POST", "/api/remote/start");
	await pollUntil(
		async () => (await api("GET", "/api/remote")).body.status.state === "connected",
		"the tunnel to connect",
	);
	const leftover = fake.runPid(fake.runs());
	const runs = fake.runs();

	await s.restart(undefined, { signal: "SIGKILL" });
	await pollUntil(() => !processExists(leftover), "the leftover to end");
	// Nothing was started in its place.
	expect(fake.runs()).toBe(runs);
	expect((await api("GET", "/api/remote")).body.status).toEqual({ state: "off" });

	const stopped = await api("POST", "/api/remote/stop");
	expect(stopped.body.config.enabled).toBe(false);
});
