import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostToolServer } from "../../server/omp/host-tools.ts";
import { describeRemote, REMOTE_AI_DEFINITIONS, type RemoteAiHooks } from "../../server/remote-ai.ts";
import { REMOTE_AI_GUIDE } from "../../server/remote-ai-guide.ts";
import { judge } from "../../server/remote-check.ts";
import { RemoteService } from "../../server/remote-routes.ts";
import type { TunnelTimings } from "../../server/remote-tunnel.ts";
import { isRecord } from "../../shared/guards.ts";
import type { LiveAttached, ServerMessage } from "../../shared/protocol.ts";
import { DEFAULT_REMOTE_CONFIG, type RemoteSnapshot, withoutLinks } from "../../shared/remote.ts";
import { REMOTE_AI_READ_ONLY, REMOTE_AI_TOOL, REMOTE_AI_TOOL_NAMES } from "../../shared/remote-ai.ts";
import { FAKE_TUNNEL_ID, type FakeCloudflared, makeFakeCloudflared } from "../support/fake-cloudflared.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * The AI help for remote access, against the real `RemoteService` and the fake cloudflared: who may call its tools (only a
 * conversation started with "Set up with AI", only while the switch is on, never one a page from the tunnel is on), that
 * each tool reaches the same code, with the same validation, as the card's button, and that what the tools say holds no
 * secret.
 */

const AUD = "c".repeat(64);
const HOST = "omp.example.com";
const FAST: Partial<TunnelTimings> = { backoffMs: [40], stableMs: 400, stopGraceMs: 3000, loginUrlMs: 8000 };
const LOGIN_URL =
	"https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.example.com%2Fone-time-secret";

const dirs: string[] = [];
const services: RemoteService[] = [];
const stoppers: (() => void)[] = [];
afterEach(async () => {
	for (const stop of stoppers.splice(0)) stop();
	for (const s of services.splice(0)) await s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Hooks extends RemoteAiHooks {
	opened: { server: HostToolServer; cwd: string }[];
	withdrawn: string[];
	/** The conversations a page from the tunnel is attached to. */
	remote: Set<string>;
}

/** What a test of the AI help holds: the service, the fake program it runs, what the server was asked to do, what the pages were told. */
interface World {
	dir: string;
	fake: FakeCloudflared;
	service: RemoteService;
	hooks: Hooks;
	pushed: ServerMessage[];
	/** Where the switch is kept. */
	file: string;
}

function world(check?: string): World {
	const dir = mkdtempSync(join(tmpdir(), "ompw-remote-ai-"));
	dirs.push(dir);
	const fake = makeFakeCloudflared(join(dir, "fake"), { installed: false });
	fake.setLoginUrl(LOGIN_URL);
	const pushed: ServerMessage[] = [];
	let seq = 0;
	const hooks: Hooks = {
		opened: [],
		withdrawn: [],
		remote: new Set(),
		async open(server, cwd) {
			hooks.opened.push({ server, cwd });
			return { liveId: `L${++seq}` } as LiveAttached;
		},
		async withdraw(liveId) {
			hooks.withdrawn.push(liveId);
		},
		heldRemotely: (liveId) => hooks.remote.has(liveId),
	};
	const service = new RemoteService({
		dataDir: join(dir, "data"),
		host: "127.0.0.1",
		port: 4242,
		broadcast: (m) => pushed.push(m),
		env: {
			PATH: process.env.PATH,
			OMP_WEBUI_CLOUDFLARED: fake.bin,
			OMP_WEBUI_BREW: fake.brew,
			...(check ? { OMP_WEBUI_REMOTE_CHECK_URL: check } : {}),
		},
		home: fake.home,
		extraDirs: [],
		timings: FAST,
		ai: hooks,
	});
	services.push(service);
	return { dir, fake, service, hooks, pushed, file: join(dir, "data", "remote-ai.json") };
}

/** A request the way the page makes it: to the loopback address, with no Cloudflare header. */
async function ask(w: World, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
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
	const res = await w.service.handle(req, url, "127.0.0.1");
	if (!res) throw new Error(`${path} was not answered`);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: string } };
}

/** What the agent of conversation `liveId` gets when it calls `name`. */
const call = (w: World, name: string, args: unknown = {}, liveId = "L1") =>
	w.service.ai.call({ liveId, name, args, signal: new AbortController().signal });

/** "Set up with AI": the switch on, and a conversation that holds the tools. */
async function startConversation(w: World): Promise<string> {
	const res = await ask(w, "POST", "/api/remote/ai/start", {});
	expect(res.status).toBe(200);
	return res.body.liveId as string;
}

const signIn = (w: World) => {
	mkdirSync(join(w.fake.home, ".cloudflared"), { recursive: true });
	writeFileSync(join(w.fake.home, ".cloudflared", "cert.pem"), "cert");
};

describe("the opt-in", () => {
	test("it is off on a fresh install, and every tool is refused: nothing runs, nothing is changed", async () => {
		const w = world();
		expect((await ask(w, "GET", "/api/remote")).body.ai).toEqual({ enabled: false, conversations: [] });
		for (const name of REMOTE_AI_TOOL_NAMES) {
			const answer = await call(w, name, name === REMOTE_AI_TOOL.save ? { hostname: HOST } : {});
			expect(answer, name).toMatchObject({ isError: true });
			expect(answer.text, name).toContain("turned off");
		}
		expect(w.fake.calls()).toEqual([]);
		expect(w.fake.brewCalls()).toEqual([]);
		expect(w.service.store.read().hostname).toBe("");
	});

	test('"Set up with AI" turns the switch on and starts one conversation in a folder of its own that holds the tools', async () => {
		const w = world();
		const liveId = await startConversation(w);
		expect(w.hooks.opened).toHaveLength(1);
		expect(w.hooks.opened[0]?.cwd).toBe(join(w.dir, "data", "remote-help"));
		// The tools omp is told of: the nine, and the ones that only read are the ones it is told not to ask about.
		const server = w.hooks.opened[0]?.server;
		expect(server?.tools.map((t) => t.name)).toEqual([...REMOTE_AI_TOOL_NAMES]);
		expect(server?.readOnly).toEqual([...REMOTE_AI_READ_ONLY]);
		expect(server?.tools.every((t) => t.loadMode === "essential")).toBe(true);

		expect((await ask(w, "GET", "/api/remote")).body.ai).toEqual({ enabled: true, conversations: [liveId] });
		// Kept like the settings: in a file only its owner reads.
		expect(readFileSync(w.file, "utf8")).toContain('"enabled":true');
		expect(statSync(w.file).mode & 0o777).toBe(0o600);
		// The cards of every page are told.
		expect(w.pushed.length).toBeGreaterThan(0);
		// And the conversation can use them.
		expect(await call(w, REMOTE_AI_TOOL.status, {}, liveId)).not.toHaveProperty("isError");
	});

	test("a conversation that was not started with the button has no tools, even with the switch on", async () => {
		const w = world();
		await startConversation(w);
		const answer = await call(w, REMOTE_AI_TOOL.status, {}, "L-somebody-else");
		expect(answer.isError).toBe(true);
		expect(answer.text).toContain("Set up with AI");
		// Nor can it change anything.
		expect(await call(w, REMOTE_AI_TOOL.save, { hostname: HOST }, "L-somebody-else")).toMatchObject({ isError: true });
		expect(w.service.store.read().hostname).toBe("");
	});

	test("turned off, every conversation is refused at once and omp is told it has no tools", async () => {
		const w = world();
		const first = await startConversation(w);
		const second = await startConversation(w);
		expect(await call(w, REMOTE_AI_TOOL.status, {}, first)).not.toHaveProperty("isError");

		const off = await ask(w, "POST", "/api/remote/ai", { enabled: false });
		expect(off.body.ai).toEqual({ enabled: false, conversations: [] });
		expect(w.hooks.withdrawn.sort()).toEqual([first, second].sort());
		for (const liveId of [first, second]) {
			for (const name of REMOTE_AI_TOOL_NAMES) {
				expect(await call(w, name, { hostname: HOST }, liveId), `${liveId} ${name}`).toMatchObject({ isError: true });
			}
		}
		expect(w.fake.calls()).toEqual([]);
		expect(w.service.store.read().hostname).toBe("");
	});

	test("the switch's file is the truth: what it does not say is on, is off, and a call is checked against it", async () => {
		const w = world();
		const liveId = await startConversation(w);
		for (const content of ['{"enabled":false}', "not json", "[]", '{"enabled":"true"}', "{}", ""]) {
			writeFileSync(w.file, content);
			const answer = await call(w, REMOTE_AI_TOOL.status, {}, liveId);
			expect(answer.isError, content).toBe(true);
		}
		writeFileSync(w.file, '{"enabled":true}');
		expect(await call(w, REMOTE_AI_TOOL.status, {}, liveId)).not.toHaveProperty("isError");
		rmSync(w.file);
		expect(await call(w, REMOTE_AI_TOOL.status, {}, liveId)).toMatchObject({ isError: true });
	});

	test("a conversation that ends holds nothing any more", async () => {
		const w = world();
		const liveId = await startConversation(w);
		w.service.ai.ended(liveId);
		expect((await ask(w, "GET", "/api/remote")).body.ai).toEqual({ enabled: true, conversations: [] });
		expect(await call(w, REMOTE_AI_TOOL.status, {}, liveId)).toMatchObject({ isError: true });
	});

	test("turned off while the conversation is starting: it is withdrawn, is no holder, and the button says so", async () => {
		const w = world();
		const opened = w.hooks.open;
		let started = "";
		// The person flips the switch off at the moment omp has come up, before the button's answer.
		w.hooks.open = async (server, cwd) => {
			const info = await opened(server, cwd);
			started = info.liveId;
			await ask(w, "POST", "/api/remote/ai", { enabled: false });
			return info;
		};
		const res = await ask(w, "POST", "/api/remote/ai/start", {});
		expect(res.status).toBe(409);
		expect(res.body.error).toContain("turned off");

		expect(started).not.toBe("");
		expect(w.hooks.withdrawn).toContain(started);
		expect((await ask(w, "GET", "/api/remote")).body.ai).toEqual({ enabled: false, conversations: [] });
		// Turned on again by the person, it does not revive the conversation that started while it was off.
		await ask(w, "POST", "/api/remote/ai", { enabled: true });
		expect(await call(w, REMOTE_AI_TOOL.status, {}, started)).toMatchObject({ isError: true });
		expect(w.service.ai.state().conversations).toEqual([]);
	});

	test("a server that cannot start a conversation refuses the button, and the switch stays as it was", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ompw-remote-ai-none-"));
		dirs.push(dir);
		const service = new RemoteService({
			dataDir: join(dir, "data"),
			host: "127.0.0.1",
			port: 4242,
			broadcast: () => {},
			env: { PATH: process.env.PATH },
		});
		services.push(service);
		const url = new URL("http://127.0.0.1:4242/api/remote/ai/start");
		const res = await service.handle(
			new Request(url, { method: "POST", headers: { host: "127.0.0.1:4242" } }),
			url,
			"127.0.0.1",
		);
		expect(res?.status).toBe(501);
		expect(service.ai.enabled()).toBe(false);
	});
});

describe("who may use it", () => {
	const REMOTE_HEADERS: Record<string, string>[] = [
		{ host: HOST, "cf-connecting-ip": "203.0.113.9", "cf-ray": "8a1b2c3d4e5f-SJC" },
		{ host: "127.0.0.1:4242", "cf-connecting-ip": "203.0.113.9" },
		{ host: "localhost:4242", "cf-access-jwt-assertion": "a.b.c" },
		{ host: HOST },
	];

	test("a request that came through the tunnel can neither turn the help on or off, start a conversation, nor check", async () => {
		const w = world();
		for (const headers of REMOTE_HEADERS) {
			for (const [path, body] of [
				["/api/remote/ai", { enabled: true }],
				["/api/remote/ai", { enabled: false }],
				["/api/remote/ai/start", {}],
				["/api/remote/check", {}],
			] as const) {
				expect((await ask(w, "POST", path, body, headers)).status, `${path} ${JSON.stringify(headers)}`).toBe(403);
			}
		}
		expect(w.hooks.opened).toEqual([]);
		expect(w.service.ai.enabled()).toBe(false);
	});

	test("while a page that came through the tunnel is on the conversation its tools are refused, and work again once it has gone", async () => {
		const w = world();
		const liveId = await startConversation(w);
		w.hooks.remote.add(liveId);
		for (const name of REMOTE_AI_TOOL_NAMES) {
			const answer = await call(w, name, { hostname: HOST }, liveId);
			expect(answer, name).toMatchObject({ isError: true });
			expect(answer.text, name).toContain("tunnel");
		}
		expect(w.fake.calls()).toEqual([]);
		expect(w.service.store.read().hostname).toBe("");

		w.hooks.remote.delete(liveId);
		expect(await call(w, REMOTE_AI_TOOL.status, {}, liveId)).not.toHaveProperty("isError");
	});

	test("the agent cannot turn the help on: no tool does it, and the settings that are the person's are refused by `save`", async () => {
		const w = world();
		const liveId = await startConversation(w);
		await ask(w, "POST", "/api/remote/ai", { enabled: false });
		// Off: nothing the agent calls turns it on.
		for (const name of [...REMOTE_AI_TOOL_NAMES, "remote_access_enable", "remote_access_ai", "set_remote_ai"]) {
			await call(w, name, { enabled: true, ai: { enabled: true } }, liveId);
		}
		expect(w.service.ai.enabled()).toBe(false);
		expect(w.service.ai.state()).toEqual({ enabled: false, conversations: [] });

		// On, with a conversation: an unknown tool is refused and the switches are not its to save.
		const again = await startConversation(w);
		expect(await call(w, "remote_access_enable", {}, again)).toMatchObject({ isError: true });
		for (const key of ["enabled", "autostart", "tunnelId", "tunnelName", "ai"]) {
			const answer = await call(
				w,
				REMOTE_AI_TOOL.save,
				{ hostname: HOST, [key]: key === "ai" ? { enabled: false } : true },
				again,
			);
			expect(answer, key).toMatchObject({ isError: true });
			expect(answer.text, key).toContain(key);
		}
		// Refused whole: not even the valid hostname beside them was saved.
		expect(w.service.store.read()).toMatchObject({
			hostname: "",
			enabled: false,
			autostart: false,
		});
	});
});

describe("what each tool does is what the card's button does", () => {
	test("save: the same validation, the same words, nothing saved when a value is refused", async () => {
		const w = world();
		const liveId = await startConversation(w);
		const bad: Record<string, unknown>[] = [
			{ aud: "not-an-aud" },
			{ aud: "C".repeat(63) },
			{ hostname: "not a host" },
			{ hostname: "1.2.3.4" },
			{ team: "bad team!" },
			{ emails: ["nobody"] },
			{ emails: "me@example.com" },
			{ hostname: 5 },
		];
		for (const patch of bad) {
			const card = await ask(w, "POST", "/api/remote/config", patch);
			const agent = await call(w, REMOTE_AI_TOOL.save, patch, liveId);
			expect(card.status, JSON.stringify(patch)).toBe(400);
			expect(agent.isError, JSON.stringify(patch)).toBe(true);
			expect(agent.text, JSON.stringify(patch)).toBe(card.body.error as string);
		}
		expect(w.service.store.read()).toMatchObject({ hostname: "", team: "", aud: "", emails: [] });
	});

	test("save: good values are kept as the card keeps them (trimmed, lower-cased, de-duplicated), and only the fields given change", async () => {
		const w = world();
		const liveId = await startConversation(w);
		const answer = await call(
			w,
			REMOTE_AI_TOOL.save,
			{
				hostname: ` ${HOST.toUpperCase()} `,
				team: "My-Team",
				aud: AUD.toUpperCase(),
				emails: ["Me@Example.com", "me@example.com"],
			},
			liveId,
		);
		expect(answer.isError).toBeUndefined();
		expect(w.service.store.read()).toMatchObject({
			hostname: HOST,
			team: "my-team",
			aud: AUD,
			emails: ["me@example.com"],
		});

		await call(w, REMOTE_AI_TOOL.save, { team: "other-team" }, liveId);
		expect(w.service.store.read()).toMatchObject({
			hostname: HOST,
			team: "other-team",
			aud: AUD,
			emails: ["me@example.com"],
		});
		// It does not turn remote access on.
		expect(w.service.store.read().enabled).toBe(false);
		// Nothing to save, and not an object: refused.
		expect(await call(w, REMOTE_AI_TOOL.save, {}, liveId)).toMatchObject({ isError: true });
		expect(await call(w, REMOTE_AI_TOOL.save, "hostname", liveId)).toMatchObject({ isError: true });
		expect(await call(w, REMOTE_AI_TOOL.save, null, liveId)).toMatchObject({ isError: true });
		// The cards follow: they are told something changed.
		expect(w.pushed.some((m) => m.t === "remote")).toBe(true);
	});

	test("setup and start refuse what the card's buttons refuse, in the same words", async () => {
		const w = world();
		const liveId = await startConversation(w);
		w.fake.setBrewSeconds(0);
		for (const [tool, route] of [
			[REMOTE_AI_TOOL.setup, "setup"],
			[REMOTE_AI_TOOL.start, "start"],
		] as const) {
			// Not installed, not logged in, no hostname: whatever the route says first, the tool says.
			const card = await ask(w, "POST", `/api/remote/${route}`, {});
			const agent = await call(w, tool, {}, liveId);
			expect(card.status).toBeGreaterThanOrEqual(400);
			expect(agent).toEqual({ text: card.body.error as string, isError: true });
		}
		await call(w, REMOTE_AI_TOOL.install, {}, liveId);
		signIn(w);
		for (const [tool, route] of [
			[REMOTE_AI_TOOL.setup, "setup"],
			[REMOTE_AI_TOOL.start, "start"],
		] as const) {
			const card = await ask(w, "POST", `/api/remote/${route}`, {});
			const agent = await call(w, tool, {}, liveId);
			expect(card.status, route).toBe(400);
			expect(agent, route).toEqual({ text: card.body.error as string, isError: true });
		}
	});

	test("the whole set-up through the tools: install, login, save, set up, start, check, stop", async () => {
		const w = world();
		const liveId = await startConversation(w);
		const status = async () => JSON.parse((await call(w, REMOTE_AI_TOOL.status, {}, liveId)).text);
		expect((await status()).next).toContain(REMOTE_AI_TOOL.install);

		const installed = await call(w, REMOTE_AI_TOOL.install, {}, liveId);
		expect(installed.isError).toBeUndefined();
		expect(w.fake.brewCalls()).toEqual(["install cloudflared"]);
		expect((await status()).cloudflared.installed).toBe(true);
		expect((await status()).next).toContain(REMOTE_AI_TOOL.login);

		// The login starts and waits for the browser; the person finishes it, and the status says so.
		const login = await call(w, REMOTE_AI_TOOL.login, {}, liveId);
		expect(login.isError).toBeUndefined();
		expect((await status()).cloudflareLogin).toEqual({ signedIn: false, waitingForBrowser: true });
		// The link is on the page's snapshot (for the person), and nowhere the agent can read.
		expect(w.service.snapshot().loginUrl).toBe(LOGIN_URL);
		w.fake.approveLogin();
		await pollUntil(() => w.fake.hasCert(), "the certificate");
		expect((await status()).cloudflareLogin.signedIn).toBe(true);
		expect((await status()).next).toContain("hostname");

		await call(w, REMOTE_AI_TOOL.save, { hostname: HOST }, liveId);
		expect((await status()).missingSettings).toEqual(["team", "aud", "emails"]);
		expect((await status()).next).toContain("Access application");
		await call(w, REMOTE_AI_TOOL.save, { team: "my-team", aud: AUD, emails: ["me@example.com"] }, liveId);
		expect((await status()).next).toContain(REMOTE_AI_TOOL.setup);

		expect((await call(w, REMOTE_AI_TOOL.setup, {}, liveId)).isError).toBeUndefined();
		expect(w.fake.calls().some((c) => c.startsWith("tunnel create"))).toBe(true);
		expect((await status()).tunnel.setUp).toBe(true);
		expect((await status()).next).toContain(REMOTE_AI_TOOL.start);

		expect((await call(w, REMOTE_AI_TOOL.start, {}, liveId)).isError).toBeUndefined();
		expect((await status()).remoteAccessOn).toBe(true);
		expect(w.service.store.read().enabled).toBe(true);
		await pollUntil(async () => (await status()).tunnel.state === "connected", "the tunnel to connect");
		expect((await status()).next).toContain(REMOTE_AI_TOOL.check);

		expect((await call(w, REMOTE_AI_TOOL.stop, {}, liveId)).isError).toBeUndefined();
		expect(w.service.store.read().enabled).toBe(false);
		expect((await status()).tunnel.state).toBe("off");
	});
});

describe("what the tools say holds no secret", () => {
	test("a login that fails after cloudflared printed the sign-in link puts no link in the note, the status or any result", async () => {
		const w = world();
		const liveId = await startConversation(w);
		await call(w, REMOTE_AI_TOOL.install, {}, liveId);
		// cloudflared prints the link, waits for the browser, and then fails: what it printed last holds the link.
		w.fake.fail("login-ends-badly");
		const told: string[] = [];
		const run = async (name: string) => {
			const answer = await call(w, name, {}, liveId);
			told.push(answer.text);
			return answer;
		};
		expect((await run(REMOTE_AI_TOOL.login)).isError).toBeUndefined();
		w.fake.approveLogin();
		await pollUntil(() => (w.service.tunnel.status().message ?? "").includes("login failed"), "the login to fail");

		// The note every page shows holds no link either: the card has the link from `loginUrl` while the login waits, and
		// the login is over.
		const note = w.service.tunnel.status().message ?? "";
		expect(note).toContain("Cloudflare login failed");
		expect(note).not.toMatch(/https?:\/\//);
		expect(note).not.toContain("one-time-secret");
		expect(w.service.snapshot().loginUrl).toBeUndefined();

		const status = await run(REMOTE_AI_TOOL.status);
		expect(JSON.parse(status.text).tunnel.message).toContain("Cloudflare login failed");
		await run(REMOTE_AI_TOOL.start);
		for (const text of told) {
			expect(text).not.toMatch(/https?:\/\//);
			expect(text).not.toContain("one-time-secret");
			expect(text).not.toContain("callback=");
		}
	});

	test("an address in anything the tunnel said is replaced, a cut one included, whatever the way it reaches the agent", () => {
		expect(
			withoutLinks(
				"see https://dash.cloudflare.com/argotunnel?cb=https%3A%2F%2Fx.example.com%2Fs and http://a.example.com/x.",
			),
		).toBe("see [link] and [link]");
		expect(withoutLinks("cut https://dash.cloudflare.com/arg…")).toBe("cut [link]");
		expect(withoutLinks("HTTPS://UPPER.example.com/Path")).toBe("[link]");
		expect(withoutLinks("no address, a host.example.com and a path /a/b")).toBe(
			"no address, a host.example.com and a path /a/b",
		);

		const snapshot: RemoteSnapshot = {
			config: { ...DEFAULT_REMOTE_CONFIG },
			status: {
				state: "error",
				message: "failed: https://dash.cloudflare.com/argotunnel?aud=&callback=one-time-secret done",
			},
			installed: true,
			loggedIn: false,
			url: "",
			ai: { enabled: true, conversations: [] },
		};
		const told = describeRemote(snapshot);
		expect(told).toContain("failed: [link] done");
		expect(told).not.toContain("one-time-secret");
	});
	test("through a whole set-up, nothing the agent is told carries the login link, the tunnel's id or credentials, or the certificate", async () => {
		const w = world();
		const liveId = await startConversation(w);
		const told: string[] = [];
		const run = async (name: string, args: unknown = {}) => {
			const answer = await call(w, name, args, liveId);
			told.push(JSON.stringify(answer), JSON.stringify(args));
		};
		await run(REMOTE_AI_TOOL.guide);
		await run(REMOTE_AI_TOOL.install);
		await run(REMOTE_AI_TOOL.login);
		w.fake.approveLogin();
		await pollUntil(() => w.fake.hasCert(), "the certificate");
		await run(REMOTE_AI_TOOL.status);
		await run(REMOTE_AI_TOOL.save, { hostname: HOST, team: "my-team", aud: AUD, emails: ["me@example.com"] });
		await run(REMOTE_AI_TOOL.setup);
		await run(REMOTE_AI_TOOL.start);
		await run(REMOTE_AI_TOOL.status);
		await run(REMOTE_AI_TOOL.stop);
		expect(w.fake.hasCredentials()).toBe(true);

		const everything = told.join("\n");
		for (const secret of [
			LOGIN_URL,
			"one-time-secret",
			"callback=",
			FAKE_TUNNEL_ID,
			"TunnelSecret",
			"c2VjcmV0",
			"cert.pem",
			w.fake.home,
		]) {
			expect(everything, secret).not.toContain(secret);
		}
	});

	test("the tools take no token or secret: the only arguments any of them has are the four settings", () => {
		const properties = REMOTE_AI_DEFINITIONS.flatMap((d) =>
			isRecord(d.parameters.properties) ? Object.keys(d.parameters.properties) : [],
		);
		expect(properties.sort()).toEqual(["aud", "emails", "hostname", "team"]);
	});
});

describe("the check of the public address", () => {
	function target(handler: (req: Request) => Response) {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
		stoppers.push(() => void server.stop(true));
		return `http://127.0.0.1:${server.port}/`;
	}

	test("it finds the way in as it should be: the hostname answers and Access asks for a sign-in at the saved team", async () => {
		const w = world(
			target(
				() =>
					new Response(null, {
						status: 302,
						headers: { location: "https://my-team.cloudflareaccess.com/cdn-cgi/access/login/omp.example.com?kid=1" },
					}),
			),
		);
		const liveId = await startConversation(w);
		await call(w, REMOTE_AI_TOOL.save, { hostname: HOST, team: "my-team" }, liveId);
		const answer = await call(w, REMOTE_AI_TOOL.check, {}, liveId);
		expect(JSON.parse(answer.text)).toMatchObject({ url: `https://${HOST}/`, verdict: "ok", httpStatus: 302 });
		// The card's button is the same check.
		expect((await ask(w, "POST", "/api/remote/check", {})).body).toMatchObject({ verdict: "ok" });
	});

	test("it says what is wrong with each way the answer can go, and asks for a hostname first", async () => {
		let answer: () => Response = () => new Response("Forbidden", { status: 403 });
		const w = world(target(() => answer()));
		const liveId = await startConversation(w);
		expect(await call(w, REMOTE_AI_TOOL.check, {}, liveId)).toMatchObject({ isError: true });
		expect((await ask(w, "POST", "/api/remote/check", {})).status).toBe(400);
		await call(w, REMOTE_AI_TOOL.save, { hostname: HOST }, liveId);

		const verdict = async () => JSON.parse((await call(w, REMOTE_AI_TOOL.check, {}, liveId)).text).verdict;
		expect(await verdict()).toBe("no-access");
		answer = () => new Response("<html>Error 1033</html>", { status: 530 });
		expect(await verdict()).toBe("tunnel-down");
		answer = () => new Response("bad gateway", { status: 502 });
		expect(await verdict()).toBe("origin-down");
		answer = () => new Response("", { status: 404 });
		expect((await verdict()) as string).toBe("other");
	});

	test("a hostname that cannot be reached is an answer, not a failure of the tool", async () => {
		const w = world("http://127.0.0.1:9/");
		const liveId = await startConversation(w);
		await call(w, REMOTE_AI_TOOL.save, { hostname: HOST }, liveId);
		const answer = await call(w, REMOTE_AI_TOOL.check, {}, liveId);
		expect(answer.isError).toBeUndefined();
		expect(JSON.parse(answer.text).verdict).toBe("unreachable");
	});

	test("judging an answer", () => {
		const url = "https://omp.example.com/";
		const redirect = (location: string) => ({ status: 302, location, body: "" });
		expect(judge(url, redirect("https://my-team.cloudflareaccess.com/cdn-cgi/access/login/x"), "my-team").verdict).toBe(
			"ok",
		);
		expect(judge(url, redirect("https://my-team.cloudflareaccess.com/cdn-cgi/access/login/x"), "").verdict).toBe("ok");
		// Access asks, but not at the team that is saved: this app would refuse every token.
		expect(judge(url, redirect("https://other.cloudflareaccess.com/login"), "my-team").verdict).toBe("other");
		expect(judge(url, redirect("https://example.org/login"), "my-team").verdict).toBe("other");
		expect(judge(url, { status: 530, location: null, body: "error code: 1033" }, "").verdict).toBe("tunnel-down");
		expect(judge(url, { status: 530, location: null, body: "Error 1016 Origin DNS error" }, "").verdict).toBe(
			"tunnel-down",
		);
		expect(judge(url, { status: 530, location: null, body: "error code: 1001" }, "").verdict).toBe("dns");
		for (const status of [502, 503, 504, 521, 522, 523, 524])
			expect(judge(url, { status, location: null, body: "" }, "").verdict, String(status)).toBe("origin-down");
		expect(judge(url, { status: 403, location: null, body: "Forbidden" }, "").verdict).toBe("no-access");
		expect(judge(url, { status: 403, location: null, body: "<html>Access denied</html>" }, "").verdict).toBe("other");
		expect(judge(url, { status: 404, location: null, body: "" }, "").verdict).toBe("other");
		expect(judge(url, { status: 200, location: null, body: "<html>the app</html>" }, "").verdict).toBe("other");
	});
});

test("the guide ships with the app and holds nobody's own values", async () => {
	const w = world();
	const liveId = await startConversation(w);
	expect((await call(w, REMOTE_AI_TOOL.guide, {}, liveId)).text).toBe(REMOTE_AI_GUIDE);
	// The steps, the two values of the dashboard and the errors the guide is for.
	for (const word of ["AUD", "team", "1033", "1016", "409", "Allow", "remote_access_status"])
		expect(REMOTE_AI_GUIDE).toContain(word);
	// Made-up names only.
	expect(REMOTE_AI_GUIDE).toContain("omp.example.com");
	expect(REMOTE_AI_GUIDE).not.toMatch(
		/https?:\/\/(?!<hostname>)[a-z0-9.-]+\.(?:com|org|net|io|dev)\b(?<!example\.com)/,
	);
});

// The snapshot's shape: the card reads `ai` and, while a login waits, `loginUrl`.
test("the snapshot says whether the AI may help, in how many conversations, and where a waiting login is", async () => {
	const w = world();
	const snapshot = (): RemoteSnapshot => w.service.snapshot();
	expect(snapshot().ai).toEqual({ enabled: false, conversations: [] });
	expect(snapshot()).not.toHaveProperty("loginUrl");
	const liveId = await startConversation(w);
	expect(snapshot().ai).toEqual({ enabled: true, conversations: [liveId] });
});
