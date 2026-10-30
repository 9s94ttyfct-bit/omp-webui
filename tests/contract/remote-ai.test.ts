import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteSnapshot } from "../../shared/remote.ts";
import { REMOTE_AI_READ_ONLY, REMOTE_AI_TOOL, REMOTE_AI_TOOL_NAMES } from "../../shared/remote-ai.ts";
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
import { FAKE_TUNNEL_ID, type FakeCloudflared, makeFakeCloudflared } from "../support/fake-cloudflared.ts";
import { writeFakeHostOmp } from "../support/fake-host-omp.ts";
import { messageWhere, type ServerMsg, watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The AI help for remote access against the real server (its real routes, its real pool and sockets) and a scripted omp
 * that logs everything it is sent and calls the tools it is told to (`tool <name> <json>`, see `fake-host-omp.ts`): that a
 * conversation has the tools only when it was started with "Set up with AI", that each call is answered by the server
 * alone, that the card of every page follows what the agent changes, that turning the switch off takes the tools away, that
 * nothing from the tunnel can start, change or use any of it, and that no secret is in anything omp is told or a page is shown.
 *
 * What a model does with the tools, and omp's own approval prompt in front of the ones that change something, is checked in
 * `remote-ai-live.test.ts`.
 */

const LOGIN_URL =
	"https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.example.com%2Fone-time-secret";

let root: string;
let log: string;
let settingsFile: string;
let key: AccessKey;
let jwks: Jwks;
let s: TestServer;
let program: FakeCloudflared;

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "ompw-remote-ai-contract-"));
	log = join(root, "omp.log");
	writeFileSync(log, "");
	settingsFile = join(root, "remote.json");
	key = await makeKey("kid-1");
	jwks = await startJwks([key]);
	program = makeFakeCloudflared(join(root, "cf"), { installed: false });
	program.setLoginUrl(LOGIN_URL);
	s = await startTestServer(
		0,
		{
			OMP_BIN: writeFakeHostOmp(root, log, { configured: "write" }),
			OMP_WEBUI_REMOTE_CONFIG: settingsFile,
			OMP_WEBUI_ACCESS_CERTS_URL: jwks.url,
			OMP_WEBUI_CLOUDFLARED: program.bin,
			OMP_WEBUI_BREW: program.brew,
		},
		{ login: false },
	);
}, 60_000);

afterAll(async () => {
	await s?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ what reached omp

interface Logged {
	argv?: string[];
	in?: Record<string, unknown>;
}

/** The lines the fake omp has finished writing: the last part, without its newline yet, is still being written. */
const logged = (): Logged[] =>
	readFileSync(log, "utf8")
		.split("\n")
		.slice(0, -1)
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Logged);
const received = (type: string) => logged().flatMap((l) => (l.in?.type === type ? [l.in] : []));
const toolSets = () => received("set_host_tools").map((f) => (f.tools as { name: string }[]).map((t) => t.name));

interface ToolResult {
	text: string;
	isError: boolean;
}
const results = (): ToolResult[] =>
	received("host_tool_result").map((r) => ({
		text: (r.result as { content: { text: string }[] }).content[0]?.text ?? "",
		isError: r.isError === true,
	}));

// ------------------------------------------------------------------ the person at this computer

const api = (path: string, body?: unknown) =>
	fetch(`${s.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

const snapshot = async (): Promise<RemoteSnapshot> => (await api("/api/remote")).json();

/** "Set up with AI", as the card's button asks for it: the id of the conversation that was started. */
async function setUpWithAi(): Promise<string> {
	const res = await api("/api/remote/ai/start", {});
	expect(res.status).toBe(200);
	return ((await res.json()) as { liveId: string }).liveId;
}

/** A page of the person's, and everything the server has said to it. */
interface Page {
	ws: WebSocket;
	heard: ServerMsg[];
}

/** A page of the person's, listening to everything the server says to it. */
async function page(): Promise<Page> {
	const ws = await connect(s);
	const heard: ServerMsg[] = [];
	ws.addEventListener("message", (ev) => {
		try {
			heard.push(JSON.parse(String(ev.data)) as ServerMsg);
		} catch {
			// a part of a big reply: not a message
		}
	});
	return { ws, heard };
}

/** What the agent of `liveId` does when told to call `name` (the scripted omp calls it): the result omp was sent. */
async function agentCalls(ws: WebSocket, liveId: string, name: string, args: unknown = {}): Promise<ToolResult> {
	const before = results().length;
	await request(ws, { t: "rpc", liveId, command: { type: "prompt", message: `tool ${name} ${JSON.stringify(args)}` } });
	await pollUntil(() => results().length > before, `the result of ${name}`);
	return results()[before] as ToolResult;
}

let frameCalls = 0;
/**
 * The agent calls `name` with no message from anyone: the scripted omp is told to send the call itself. That is what omp
 * does when the call comes after an approval the user gave earlier, and it must not be a message of the person at this Mac
 * (which lifts what a remote page left on the conversation).
 */
async function agentCallsUnprompted(
	ws: WebSocket,
	liveId: string,
	name: string,
	args: unknown = {},
): Promise<ToolResult> {
	const before = results().length;
	const frame = {
		type: "host_tool_call",
		id: `hx${++frameCalls}`,
		toolCallId: `tx${frameCalls}`,
		toolName: name,
		arguments: args,
	};
	await request(ws, { t: "rpc", liveId, command: { type: "emit_frames", frames: [frame] } });
	await pollUntil(() => results().length > before, `the result of ${name}`);
	return results()[before] as ToolResult;
}

// ------------------------------------------------------------------ a page that came through the tunnel

const REMOTE_ON = { enabled: true, hostname: HOSTNAME, team: TEAM, aud: AUD, emails: [EMAIL] };
const now = () => Math.floor(Date.now() / 1000);

async function tunnelHeaders(): Promise<Record<string, string>> {
	return {
		host: HOSTNAME,
		origin: `https://${HOSTNAME}`,
		cookie: `ompw_token=${s.accessToken}`,
		"cf-access-jwt-assertion": await sign(key, claims(now())),
		"cf-visitor": '{"scheme":"https"}',
	};
}

async function viaTunnel(path: string, body?: unknown): Promise<Response> {
	return fetch(`${s.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { ...(await tunnelHeaders()), "x-omp-webui": "1", "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: "manual",
	});
}

async function remotePage(): Promise<WebSocket> {
	const ws = new WebSocket(`${s.url.replace("http", "ws")}/ws`, {
		headers: await tunnelHeaders(),
	} as unknown as string[]);
	const open = Promise.withResolvers<void>();
	ws.onopen = () => open.resolve();
	ws.onerror = () => open.reject(new Error("the remote page's socket was refused"));
	await open.promise;
	return ws;
}

// ------------------------------------------------------------------ the specs

describe("without the opt-in", () => {
	test("a conversation has no tools and omp is never told of any, and the switch is off", async () => {
		expect((await snapshot()).ai).toEqual({ enabled: false, conversations: [] });
		const { ws } = await page();
		const live = await request<{ liveId: string }>(ws, { t: "open", target: { kind: "new", cwd: s.work } });
		await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "get_state" } });
		expect(received("set_host_tools")).toEqual([]);
		await request(ws, { t: "close", liveId: live.liveId });
		ws.close();
	}, 60_000);

	test("the page's own route to the opt-in is the only one: the tools have none, and the route needs the person's token", async () => {
		const res = await fetch(`${s.url}/api/remote/ai/start`, {
			method: "POST",
			headers: { "x-omp-webui": "1", "content-type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(401);
		expect((await snapshot()).ai.enabled).toBe(false);
	});
});

describe('"Set up with AI"', () => {
	let liveId: string;
	let watcher: Page;
	let ws: WebSocket;

	beforeAll(async () => {
		watcher = await page();
		ws = (await page()).ws;
		liveId = await setUpWithAi();
	}, 60_000);

	test("turns the switch on and starts a conversation that is given the nine tools, the reading ones allowed without a prompt", async () => {
		expect((await snapshot()).ai).toEqual({ enabled: true, conversations: [liveId] });
		expect(toolSets().at(-1)).toEqual([...REMOTE_AI_TOOL_NAMES]);
		// omp asks about the ones that change something (in Auto-approve too), and not about the ones that only read.
		const started = logged().findLast((l) => l.argv);
		const file = started?.argv?.at(-1) as string;
		const policies = () =>
			(
				Bun.YAML.parse(readFileSync(file, "utf8")) as {
					tools: { approval: Record<string, string>; approvalMode?: string };
				}
			).tools;
		const expected = Object.fromEntries(
			REMOTE_AI_TOOL_NAMES.map((n) => [n, REMOTE_AI_READ_ONLY.includes(n) ? "allow" : "prompt"]),
		);
		expect(policies().approval).toMatchObject(expected);
		// Auto-approve: the mode in the overlay says so, and the six are still asked about.
		await request(ws, { t: "approval_mode", liveId, mode: "yolo" });
		expect(policies().approvalMode).toBe("yolo");
		expect(policies().approval).toMatchObject(expected);
		// It runs in a folder of its own, not among the person's projects.
		const lives = await request<{ liveId: string; cwd: string }[]>(ws, { t: "list_lives" });
		expect(lives.find((l) => l.liveId === liveId)?.cwd).toBe(join(s.root, "data", "remote-help"));
	});

	test("a call is answered by the server alone: omp gets the result, and no page is shown the call", async () => {
		const watching = watchFrames(ws, liveId);
		await request(ws, { t: "attach", liveId });
		const answered = await agentCalls(ws, liveId, REMOTE_AI_TOOL.status);
		expect(answered.isError).toBe(false);
		expect(JSON.parse(answered.text)).toMatchObject({
			cloudflared: { installed: false },
			settings: { hostname: "", emails: [] },
			remoteAccessOn: false,
		});
		expect(JSON.parse(answered.text).next).toContain(REMOTE_AI_TOOL.install);
		expect(watching.seen.filter((f) => f.type === "host_tool_call")).toEqual([]);
	});

	test("what the agent changes, every page's card follows at once; a refused value changes nothing and says what the card says", async () => {
		const told = messageWhere(watcher.ws, (m) => m.t === "remote");
		const saved = await agentCalls(ws, liveId, REMOTE_AI_TOOL.save, { hostname: "omp.example.com", team: "my-team" });
		expect(saved.isError).toBe(false);
		await told;
		expect((await snapshot()).config).toMatchObject({ hostname: "omp.example.com", team: "my-team" });

		const card = await api("/api/remote/config", { aud: "not-an-aud" });
		const refused = await agentCalls(ws, liveId, REMOTE_AI_TOOL.save, { aud: "not-an-aud" });
		expect(card.status).toBe(400);
		expect(refused).toEqual({ text: ((await card.json()) as { error: string }).error, isError: true });
		expect((await snapshot()).config.aud).toBe("");

		// What is the person's own is not the agent's.
		const switches = await agentCalls(ws, liveId, REMOTE_AI_TOOL.save, { enabled: true });
		expect(switches.isError).toBe(true);
		expect((await snapshot()).config.enabled).toBe(false);
	});

	test("the whole set-up goes through, and nothing omp is told or a page is shown holds a secret", async () => {
		// The card does the same steps by the same routes; here the agent does them.
		expect((await agentCalls(ws, liveId, REMOTE_AI_TOOL.install)).isError).toBe(false);
		expect((await agentCalls(ws, liveId, REMOTE_AI_TOOL.login)).isError).toBe(false);
		// The link is the person's: it is on the card's snapshot, and the agent was not given it.
		expect((await snapshot()).loginUrl).toBe(LOGIN_URL);
		program.approveLogin();
		await pollUntil(async () => (await snapshot()).loggedIn, "the Cloudflare login");

		const filled = await agentCalls(ws, liveId, REMOTE_AI_TOOL.save, { aud: AUD, emails: [EMAIL] });
		expect(filled.isError).toBe(false);
		expect((await agentCalls(ws, liveId, REMOTE_AI_TOOL.setup)).isError).toBe(false);
		expect((await agentCalls(ws, liveId, REMOTE_AI_TOOL.start)).isError).toBe(false);
		await pollUntil(async () => (await snapshot()).status.state === "connected", "the tunnel to connect");
		const status = await agentCalls(ws, liveId, REMOTE_AI_TOOL.status);
		expect(JSON.parse(status.text)).toMatchObject({
			remoteAccessOn: true,
			tunnel: { setUp: true, state: "connected" },
		});
		expect((await agentCalls(ws, liveId, REMOTE_AI_TOOL.stop)).isError).toBe(false);

		// Everything omp was sent (the definitions, every result, every prompt) and every message a page heard.
		const toOmp = readFileSync(log, "utf8");
		const toPages = JSON.stringify([...watcher.heard]);
		for (const [where, text] of [
			["omp", toOmp],
			["the pages", toPages],
		] as const) {
			for (const secret of [
				s.accessToken,
				LOGIN_URL,
				"one-time-secret",
				FAKE_TUNNEL_ID,
				"TunnelSecret",
				"c2VjcmV0",
				"cert.pem",
			])
				expect(text, `${where} must not hold ${secret}`).not.toContain(secret);
		}
	}, 60_000);

	test("turning the switch off takes the tools away from omp and refuses a call that still comes; the conversation goes on", async () => {
		const off = await api("/api/remote/ai", { enabled: false });
		expect(off.status).toBe(200);
		expect(((await off.json()) as RemoteSnapshot).ai).toEqual({ enabled: false, conversations: [] });
		expect(toolSets().at(-1)).toEqual([]);

		const refused = await agentCalls(ws, liveId, REMOTE_AI_TOOL.save, { hostname: "other.example.com" });
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain("taken away");
		expect((await snapshot()).config.hostname).toBe("omp.example.com");
		// The conversation itself is still there.
		const state = await request<{ dumpTools?: { name: string }[] }>(ws, {
			t: "rpc",
			liveId,
			command: { type: "get_state" },
		});
		expect(state.dumpTools).toEqual([]);
	});

	test("the agent cannot turn it on again: no call does, and the switch stays off", async () => {
		for (const name of REMOTE_AI_TOOL_NAMES) {
			await agentCalls(ws, liveId, name, { enabled: true });
		}
		expect((await snapshot()).ai.enabled).toBe(false);
	});
});

describe("what comes through the tunnel", () => {
	let liveId: string;

	beforeAll(async () => {
		// Remote access is on, so that the tunnel's requests are verified and not simply refused for their Host.
		writeFileSync(settingsFile, JSON.stringify(REMOTE_ON));
		mkdirSync(root, { recursive: true });
		liveId = await setUpWithAi();
	}, 60_000);

	test("a page that came in through it can neither turn the help on or off, start a conversation, nor ask for the state", async () => {
		const before = await snapshot();
		for (const [path, body] of [
			["/api/remote/ai", { enabled: false }],
			["/api/remote/ai", { enabled: true }],
			["/api/remote/ai/start", {}],
			["/api/remote/check", {}],
			["/api/remote", undefined],
		] as const) {
			expect((await viaTunnel(path, body)).status, path).toBe(403);
		}
		expect(await snapshot()).toEqual(before);
		expect(before.ai).toEqual({ enabled: true, conversations: [liveId] });
	});

	test("while a page that came through it is on the conversation, its tools are refused; once it is gone and the person writes, they work again", async () => {
		const { ws } = await page();
		const remote = await remotePage();
		await request(remote, { t: "attach", liveId });

		const refused = await agentCalls(ws, liveId, REMOTE_AI_TOOL.save, { hostname: "evil.example.com" });
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain("tunnel");
		expect((await snapshot()).config.hostname).not.toBe("evil.example.com");
		expect((await agentCalls(ws, liveId, REMOTE_AI_TOOL.status)).isError).toBe(true);

		remote.close();
		await pollUntil(
			async () => !(await agentCalls(ws, liveId, REMOTE_AI_TOOL.status)).isError,
			"the remote page to be gone",
		);
		ws.close();
	}, 60_000);

	/** What a page that came through the tunnel does to a conversation before it leaves; each leaves it at once. */
	const TOUCHES = {
		attaches: async (remote: WebSocket) => void (await request(remote, { t: "attach", liveId })),
		"sends a command": async (remote: WebSocket) =>
			void (await request(remote, { t: "rpc", liveId, command: { type: "get_state" } })),
		// It answers omp's approval prompt of a call, and leaves before the call arrives: omp's `extension_ui_response`
		// is what reaches the process, so that is what says the server has taken the answer.
		"approves a tool call": async (remote: WebSocket) => {
			remote.send(JSON.stringify({ t: "ui_response", liveId, response: { id: "ap-9", value: "Approve" } }));
			await pollUntil(() => received("extension_ui_response").some((r) => r.id === "ap-9"), "the answer to reach omp");
		},
	};

	for (const [what, touch] of Object.entries(TOUCHES)) {
		test(`a page that came through it ${what} and leaves at once cannot have the agent change anything afterwards, until the person writes`, async () => {
			const { ws } = await page();
			const before = (await snapshot()).config.hostname;
			const remote = await remotePage();
			await touch(remote);
			remote.close();

			// The call comes after the page has gone: refused, and nothing is changed or run.
			const saved = await agentCallsUnprompted(ws, liveId, REMOTE_AI_TOOL.save, { hostname: "leaves.example.com" });
			expect(saved.isError).toBe(true);
			expect(saved.text).toContain("tunnel");
			expect((await snapshot()).config.hostname).toBe(before);
			for (const name of REMOTE_AI_TOOL_NAMES) {
				expect((await agentCallsUnprompted(ws, liveId, name, {})).isError, name).toBe(true);
			}
			expect((await snapshot()).config.hostname).toBe(before);

			// Only a message of the person at this Mac lifts it.
			const again = await agentCalls(ws, liveId, REMOTE_AI_TOOL.status);
			expect(again.isError).toBe(false);
			ws.close();
		}, 60_000);
	}

	test("a page that came through it cannot lift it: a message of its own does not", async () => {
		const { ws } = await page();
		const remote = await remotePage();
		await request(remote, { t: "attach", liveId });
		await request(remote, { t: "rpc", liveId, command: { type: "prompt", message: "hello" } });
		remote.close();
		expect((await agentCallsUnprompted(ws, liveId, REMOTE_AI_TOOL.status)).isError).toBe(true);

		// A message the person sends from this computer lifts it.
		expect((await agentCalls(ws, liveId, REMOTE_AI_TOOL.status)).isError).toBe(false);
		ws.close();
	}, 60_000);
});
