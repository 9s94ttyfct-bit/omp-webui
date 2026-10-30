import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShellMessage } from "../../server/shell-events.ts";
import type { AttentionKind } from "../../shared/attention.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { writeChatSession } from "../support/chat-session.ts";
import { watchFrames } from "../support/frames.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * What the macOS app is told on its own (#627), against the real server and the real omp (the model a scripted provider: no
 * model call): the stream the app's notifications and menu bar icon come from. `tests/unit/shell-events.test.ts` has the
 * rules with the processes stood in for; here a real turn asks for an approval and ends, and the words come out in the
 * language the person saved or the app's. That a page that is not this computer's is refused the route is
 * `lan-local.test.ts` (the network) and `remote-auth.test.ts` (the tunnel); that the app reads and shows it is
 * `tests/unit/macos-shell-events.test.ts`.
 */

let server: TestServer;
let backend: StubScripted;
/** A saved conversation with a title of its own, whose file a resumed process reports. */
let file = "";

const RUN = "Run echo hi";
const script = (req: { text: string; tools: string[]; toolResults: number }): ScriptedTurn => {
	if (!req.tools.includes("bash")) return { text: "A title" };
	if (req.toolResults > 0) return { text: "Done." };
	if (req.text.includes(RUN)) return { call: { name: "bash", args: { command: "echo hi" } } };
	return { text: "Ok." };
};

beforeAll(async () => {
	backend = await startScriptedStub(script);
	server = await startTestServer(0, {}, { login: false });
	writeFileSync(
		join(server.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(server.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: omlx/stub-model`),
			"spelling:",
			"  autocomplete: ngram",
			"",
		].join("\n"),
	);
	file = writeChatSession(server.agentDir, {
		n: 94,
		title: "Shell probe",
		cwd: server.work,
		turns: [{ prompt: "hi", reply: "ok" }],
	});
}, 120_000);

afterAll(async () => {
	await server?.stop();
	await backend?.stop();
});

const authed = () => ({
	"x-omp-webui-token": server.accessToken,
	"x-omp-webui": "1",
	"content-type": "application/json",
});

const choose = async (changes: Record<string, string | null>) => {
	const res = await fetch(`${server.url}/api/prefs`, {
		method: "POST",
		headers: authed(),
		body: JSON.stringify({ changes }),
	});
	expect(res.status).toBe(200);
};

/** The app reading the stream: each line as a message, in order. */
async function read(query = "") {
	const control = new AbortController();
	const res = await fetch(`${server.url}/api/shell/events${query}`, {
		headers: { "x-omp-webui-token": server.accessToken },
		signal: control.signal,
	});
	const body = res.body?.getReader();
	if (!body) throw new Error("no body");
	const decoder = new TextDecoder();
	let buffer = "";
	/** The next message that satisfies `match` (every message by default); the ones before it are read and dropped. */
	const message = async (match: (m: ShellMessage) => boolean = () => true): Promise<ShellMessage> => {
		for (;;) {
			const at = buffer.indexOf("\n");
			if (at < 0) {
				const { value, done } = await body.read();
				if (done) throw new Error("the stream ended");
				buffer += decoder.decode(value);
				continue;
			}
			const text = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			if (text === "") continue;
			const parsed = JSON.parse(text) as ShellMessage;
			if (match(parsed)) return parsed;
		}
	};
	const attention = (kind: AttentionKind, liveId?: string) =>
		message((m) => m.t === "attention" && m.kind === kind && (liveId === undefined || m.liveId === liveId));
	return { res, message, attention, close: () => control.abort() };
}

const isState = (working: number, asking: number) => (m: ShellMessage) =>
	m.t === "state" && m.working === working && m.asking === asking;

test("this computer's page with the token is given the state as newline-delimited JSON; no token, no stream", async () => {
	expect((await fetch(`${server.url}/api/shell/events`)).status).toBe(401);
	const app = await read();
	expect(app.res.status).toBe(200);
	expect(app.res.headers.get("content-type")).toBe("application/x-ndjson");
	expect(await app.message()).toEqual({
		t: "state",
		epoch: expect.any(String),
		working: 0,
		asking: 0,
		paused: 0,
		menuIcon: true,
		questions: 0,
		finished: 0,
	});
	app.close();
});

test("a turn that stops for an approval and ends tells the app, once each, in the order it happened", async () => {
	await choose({ "ompw.notify": "on", "ompw.lang": "en" });
	const app = await read();
	await app.message(isState(0, 0));
	const ws = await connect(server);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: server.work, approvalMode: "always-ask" },
	});
	const frames = watchFrames(ws, live.liveId);
	const asked = frames.next((f) => f.type === "extension_ui_request" && f.method === "select");
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: RUN } });
	const approval = await asked;

	// The menu bar hears it wait (and does not count it as working) in the same breath as the notice comes: first.
	await app.message(isState(0, 1));
	const asking = await app.attention("asking", live.liveId);
	expect(asking).toMatchObject({
		t: "attention",
		id: live.liveId,
		kind: "asking",
		body: "Needs your input",
		liveId: live.liveId,
	});
	if (asking.t !== "attention") throw new Error("not a notice");
	expect(asking.title.length).toBeGreaterThan(0);

	const deny = (approval.options as string[]).find((o) => /^Deny/i.test(o));
	ws.send(JSON.stringify({ t: "ui_response", liveId: live.liveId, response: { id: approval.id, value: deny } }));
	await frames.next((f) => f.type === "agent_end");
	await app.message(isState(0, 0));
	const finished = await app.attention("finished", live.liveId);
	expect(finished).toMatchObject({ kind: "finished", body: "Finished", liveId: live.liveId });
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
	app.close();
}, 120_000);

test("a saved conversation is named by its title, in the saved language, else the app's, and the saved one wins", async () => {
	await choose({ "ompw.notify": "on", "ompw.lang": "zh-CN" });
	const ws = await connect(server);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "resume", sessionFile: file, model: "omlx/stub-model" },
	});
	const frames = watchFrames(ws, live.liveId);
	const turn = async (message: string) => {
		const ended = frames.after("agent_end");
		await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message } });
		await ended;
	};

	// The saved language says it, whatever the app's own is.
	const app = await read("?lang=en");
	await app.message(isState(0, 0));
	await turn("one");
	expect(await app.attention("finished", live.liveId)).toMatchObject({
		title: "Shell probe",
		body: "已完成",
		file: live.sessionFile,
	});

	// With none saved the app's decides.
	await choose({ "ompw.lang": null });
	await turn("two");
	expect(await app.attention("finished", live.liveId)).toMatchObject({ title: "Shell probe", body: "Finished" });
	app.close();
	const chinese = await read("?lang=zh-CN");
	await chinese.message(isState(0, 0));
	await turn("three");
	expect(await chinese.attention("finished", live.liveId)).toMatchObject({ body: "已完成" });
	chinese.close();
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 180_000);

test("with notifications off the app is told nothing to show, and a conversation that ran meanwhile is not told of afterwards", async () => {
	await choose({ "ompw.notify": "off", "ompw.lang": "en" });
	const app = await read();
	await app.message(isState(0, 0));
	const ws = await connect(server);
	const quiet = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	const quietFrames = watchFrames(ws, quiet.liveId);
	const quietEnd = quietFrames.after("agent_end");
	await request(ws, { t: "rpc", liveId: quiet.liveId, command: { type: "prompt", message: "quiet" } });
	await quietEnd;
	// It was working, and the menu bar knew; nothing came to show.
	await app.message(isState(1, 0));
	await app.message(isState(0, 0));

	await choose({ "ompw.notify": "on" });
	const loud = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	const loudFrames = watchFrames(ws, loud.liveId);
	const loudEnd = loudFrames.after("agent_end");
	await request(ws, { t: "rpc", liveId: loud.liveId, command: { type: "prompt", message: "loud" } });
	await loudEnd;
	// The first notice there is, is the second conversation's.
	expect(await app.message((m) => m.t === "attention")).toMatchObject({ liveId: loud.liveId, kind: "finished" });
	await request(ws, { t: "close", liveId: quiet.liveId });
	await request(ws, { t: "close", liveId: loud.liveId });
	ws.close();
	app.close();
}, 120_000);

test("Settings' menu bar icon switch reaches the app at once", async () => {
	const app = await read();
	await app.message(isState(0, 0));
	await choose({ "ompw.menuIcon": "off" });
	expect(await app.message((m) => m.t === "state")).toMatchObject({ menuIcon: false });
	await choose({ "ompw.menuIcon": null });
	expect(await app.message((m) => m.t === "state")).toMatchObject({ menuIcon: true });
	app.close();
});

test("Pause all freezes the conversation that waits for an answer, Resume all runs it again; both are POSTs only", async () => {
	const post = (path: string) => fetch(`${server.url}${path}`, { method: "POST", headers: authed() });
	expect((await fetch(`${server.url}/api/shell/pause-all`, { headers: authed() })).status).toBe(405);
	const app = await read();
	await app.message(isState(0, 0));
	const ws = await connect(server);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: server.work, approvalMode: "always-ask" },
	});
	const frames = watchFrames(ws, live.liveId);
	const asked = frames.next((f) => f.type === "extension_ui_request" && f.method === "select");
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: RUN } });
	await asked;
	await app.message(isState(0, 1));

	expect(await (await post("/api/shell/pause-all")).json()).toEqual({ changed: 1, of: 1 });
	await app.message((m) => m.t === "state" && m.paused === 1 && m.asking === 0);
	// Nothing is left to pause.
	expect(await (await post("/api/shell/pause-all")).json()).toEqual({ changed: 0, of: 0 });

	expect(await (await post("/api/shell/resume-all")).json()).toEqual({ changed: 1, of: 1 });
	await app.message((m) => m.t === "state" && m.paused === 0 && m.asking === 1);
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
	app.close();
}, 120_000);
