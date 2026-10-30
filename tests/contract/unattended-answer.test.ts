import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { DEFAULT_INSTRUCTION, type Question, type QuestionList, UNATTENDED_TOOL } from "../../shared/unattended.ts";
import { type AccessKey, type Jwks, makeKey, startJwks } from "../support/access-jwt.ts";
import { type Frame, messageWhere, watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { type RemoteClient, remoteClient, remoteSettings } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import {
	type ScriptedRequest,
	type ScriptedTurn,
	type StubScripted,
	startScriptedStub,
} from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The person answers (#646) against the real omp and the real server, the model a scripted provider. An answer goes to the
 * conversation as a message like any other: queued while it works, starting a turn when it is idle, resuming it when it is
 * closed; a page that is not on this computer is under the rules every remote message is under; a question that could not
 * be sent stays open. What is kept (the list, the mode, the instruction) survives a restart, privately.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-unattended-answer-"));
const settingsFile = join(root, "remote.json");
const dist = join(root, "dist");
const dataDir = join(root, "data");
let key: AccessKey;
let jwks: Jwks;
let s: TestServer;
let agent: StubScripted;
let phone: RemoteClient;

/** What the scripted main agent does next, once; and what holds its next answer (a turn that is under way). */
const plan: { call: { name: string; args: unknown } | null; hold: Promise<void> | null } = { call: null, hold: null };
let seq = 0;

const script = async (req: ScriptedRequest): Promise<ScriptedTurn> => {
	if (!req.tools.includes("write")) return { text: "A title" };
	const messages = JSON.parse(req.text) as { role?: string }[];
	if (messages.at(-1)?.role === "tool") return { text: "Main done." };
	const waiting = plan.hold;
	plan.hold = null;
	if (waiting) await waiting;
	const next = plan.call;
	plan.call = null;
	return next ? { call: next } : { text: "Nothing to do." };
};

const setRemote = (over: Record<string, unknown> = {}) =>
	writeFileSync(settingsFile, JSON.stringify(remoteSettings(over)));
const authed = () => ({ "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" });
const post = (path: string, body: unknown) =>
	fetch(`${s.url}${path}`, { method: "POST", headers: authed(), body: JSON.stringify(body) });
const list = async (): Promise<QuestionList> =>
	(await (await fetch(`${s.url}/api/questions`, { headers: authed() })).json()) as QuestionList;
const answerOf = (q: Question, body: Record<string, unknown> = { text: "Go ahead." }) =>
	post("/api/questions/answer", { id: q.id, ...body });

beforeAll(async () => {
	key = await makeKey("kid-1");
	jwks = await startJwks([key]);
	mkdirSync(join(dist, "assets"), { recursive: true });
	writeFileSync(
		join(dist, "index.html"),
		'<!doctype html>\n<html><head></head><body><div id="root"></div></body></html>\n',
	);
	setRemote();
	agent = await startScriptedStub(script);
	s = await startTestServer(
		0,
		{
			OMP_WEBUI_REMOTE_CONFIG: settingsFile,
			OMP_WEBUI_ACCESS_CERTS_URL: jwks.url,
			OMP_WEBUI_DIST: dist,
			OMP_WEBUI_DATA_DIR: dataDir,
		},
		{ login: false },
	);
	writeFileSync(
		join(s.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${agent.url}\n    api: openai-completions\n    apiKey: ${agent.apiKey}\n    models:\n      - id: stub-model\n`,
	);
	writeFileSync(
		join(s.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: omlx/stub-model`),
			"spelling:",
			"  autocomplete: ngram",
			"",
		].join("\n"),
	);
	phone = remoteClient(s, key);
}, 120_000);

afterAll(async () => {
	await s?.stop();
	await agent?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

interface Conversation {
	live: LiveInfo;
	ws: WebSocket;
	frames: ReturnType<typeof watchFrames>;
}

async function conversation(args: string[] = []): Promise<Conversation> {
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: s.work, approvalMode: "yolo", unattended: true, args },
	});
	return { live, ws, frames: watchFrames(ws, live.liveId) };
}

const fresh = (c: Conversation, match: (f: Frame) => boolean): Promise<Frame> => {
	const from = c.frames.seen.length;
	return c.frames.next((f) => c.frames.seen.indexOf(f) >= from && match(f));
};

async function turn(c: Conversation, message: string): Promise<void> {
	const ended = fresh(c, (f) => f.type === "agent_end");
	await request(c.ws, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message } });
	await ended;
}

/** The conversation files a question (with the tool) and the turn ends; the question as the list holds it. */
async function filed(c: Conversation, title: string, options: string[] = ["Postgres", "SQLite"]): Promise<Question> {
	plan.call = {
		name: UNATTENDED_TOOL,
		args: { title, context: `Context of ${title}`, options: options.map((label) => ({ label })) },
	};
	await turn(c, `ASK-ABOUT-${title}-${++seq}`);
	const q = (await list()).questions.find((x) => x.question === title);
	if (!q) throw new Error(`the question ${title} was not filed`);
	return q;
}

/** The first request of the main agent that carries `text`. */
async function requestWith(text: string): Promise<ScriptedRequest> {
	let found: ScriptedRequest | undefined;
	await pollUntil(() => {
		found = agent.requests.find((r) => r.text.includes(text) && r.tools.includes("write"));
		return found !== undefined;
	}, `a request carrying ${text}`);
	if (!found) throw new Error("unreachable");
	return found;
}

test("an answer to an idle conversation is a message that starts its next turn; the question is answered", async () => {
	const c = await conversation();
	const q = await filed(c, "Which database?");
	// Every page is told the counts when the answer settles it.
	const counts = messageWhere(c.ws, (m) => m.t === "questions");
	const res = await answerOf(q, { options: ["Postgres"], text: "with pgvector" });
	expect(res.status).toBe(200);
	expect(((await res.json()) as { question: Question }).question).toMatchObject({
		state: "answered",
		answer: { options: ["Postgres"], text: "with pgvector" },
	});
	await counts;
	const delivered = await requestWith('Answer to your question \\"Which database?\\"');
	expect(delivered.text).toContain("Chosen: Postgres");
	expect(delivered.text).toContain("Note: with pgvector");
	// The list says it is answered, and it is no longer counted as waiting.
	expect((await list()).questions.find((x) => x.id === q.id)?.state).toBe("answered");
	c.ws.close();
}, 120_000);

test("an answer to a conversation that is working is queued behind its turn", async () => {
	const c = await conversation();
	const q = await filed(c, "Which port?", []);
	const release = Promise.withResolvers<void>();
	plan.hold = release.promise;
	const started = fresh(c, (f) => f.type === "agent_start");
	const ended = fresh(c, (f) => f.type === "agent_end");
	await request(c.ws, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message: "LONG-TURN-646" } });
	await started;
	// The answer is accepted while the turn is under way; nothing has started a turn of its own with it.
	const res = await answerOf(q, { text: "Use 8080." });
	expect(res.status).toBe(200);
	expect(agent.requests.some((r) => r.text.includes("Use 8080."))).toBe(false);
	release.resolve();
	await ended;
	// It runs after the turn it was queued behind.
	const delivered = await requestWith("Use 8080.");
	expect(delivered.text).toContain('Answer to your question \\"Which port?\\"');
	c.ws.close();
}, 120_000);

test("an answer steered into a conversation that is working reaches the turn under way, before it ends (#703)", async () => {
	const c = await conversation();
	const q = await filed(c, "Which host?", []);
	const release = Promise.withResolvers<void>();
	plan.hold = release.promise;
	// The held answer calls a tool: a steered message joins the turn after the tool's result, ahead of the answer that ends it.
	plan.call = { name: "read", args: { path: s.work } };
	const started = fresh(c, (f) => f.type === "agent_start");
	const ended = fresh(c, (f) => f.type === "agent_end");
	await request(c.ws, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message: "LONG-TURN-703" } });
	await started;
	const res = await answerOf(q, { text: "Use localhost.", delivery: "steer" });
	expect(res.status).toBe(200);
	release.resolve();
	await ended;
	const delivered = await requestWith("Use localhost.");
	// It came with the tool's result, not after the turn's closing answer, which a queued one would follow (earlier turns
	// closed with one too: only what follows this turn's prompt counts).
	const turnSoFar = delivered.text.slice(delivered.text.lastIndexOf("LONG-TURN-703"));
	expect(turnSoFar).toContain("Use localhost.");
	expect(turnSoFar).not.toContain("Main done.");
	// One that says neither is refused, and the question stays open.
	const other = await filed(c, "Which user?", []);
	expect((await answerOf(other, { text: "root", delivery: "now" })).status).toBe(422);
	expect((await list()).questions.find((x) => x.id === other.id)?.state).toBe("open");
	c.ws.close();
}, 120_000);

test("the agent is told, every turn, the questions it filed that still wait, and the turn an answer starts is not (#694)", async () => {
	const c = await conversation();
	const waits = "Questions you filed that still wait for the person";
	const q = await filed(c, "Which cache?", ["redis", "memory"]);
	// The next turn's prompt lists it: a compaction that took the call out of the history does not take this.
	await turn(c, "NEXT-TURN-694");
	const next = await requestWith("NEXT-TURN-694");
	expect(next.text).toContain(waits);
	expect(next.text).toContain('\\"Which cache?\\" (filed ');
	// The answer says when it was filed; the turn it starts is no longer told the question waits.
	expect((await answerOf(q, { options: ["redis"], text: "" })).status).toBe(200);
	const delivered = await requestWith("Chosen: redis");
	expect(delivered.text).toContain("You filed it at ");
	expect(delivered.text).not.toContain(waits);
	c.ws.close();
}, 120_000);

test("an answer to a conversation that is closed resumes it", async () => {
	const c = await conversation();
	const q = await filed(c, "Which region?", ["eu", "us"]);
	await request(c.ws, { t: "close", liveId: c.live.liveId });
	await pollUntil(async () => {
		const lives = await request<LiveInfo[]>(c.ws, { t: "list_lives" });
		return !lives.some((l) => l.liveId === c.live.liveId && !l.exited);
	}, "the conversation to be closed");
	const res = await answerOf(q, { options: ["eu"] });
	expect(res.status).toBe(200);
	const delivered = await requestWith('Answer to your question \\"Which region?\\"');
	expect(delivered.text).toContain("Chosen: eu");
	// A new process holds the conversation now, and it is the same conversation, still unattended.
	const lives = await request<LiveInfo[]>(c.ws, { t: "list_lives" });
	const resumed = lives.find((l) => !l.exited && l.sessionFile === q.session);
	expect(resumed?.unattended).toEqual({ live: true });
	c.ws.close();
}, 180_000);

test("an answer that cannot be taken is refused and the question stays open; a settled one is not answered twice", async () => {
	const c = await conversation();
	const q = await filed(c, "Which license?", ["MIT", "Apache"]);
	expect((await answerOf(q, {})).status).toBe(422);
	expect((await answerOf(q, { options: ["GPL"] })).status).toBe(422);
	expect((await post("/api/questions/answer", { id: "q-nothing", text: "x" })).status).toBe(404);
	expect((await list()).questions.find((x) => x.id === q.id)?.state).toBe("open");
	expect((await answerOf(q, { options: ["MIT", "Apache"] })).status).toBe(200);
	// One option of a question that takes one: the first is the answer.
	expect((await list()).questions.find((x) => x.id === q.id)?.answer?.options).toEqual(["MIT"]);
	expect((await answerOf(q, { options: ["Apache"] })).status).toBe(409);
	c.ws.close();
}, 120_000);

test("a dismissed question leaves the open list and sends nothing", async () => {
	const c = await conversation();
	const q = await filed(c, "Which colour?", ["red", "blue"]);
	const before = agent.requests.length;
	const res = await post("/api/questions/dismiss", { id: q.id });
	expect(res.status).toBe(200);
	const after = await list();
	expect(after.questions.find((x) => x.id === q.id)?.state).toBe("dismissed");
	expect(after.byConversation[q.session] ?? 0).toBe(0);
	expect(agent.requests.length).toBe(before);
	expect((await answerOf(q, { options: ["red"] })).status).toBe(409);
	expect((await post("/api/questions/dismiss", { id: q.id })).status).toBe(409);
	c.ws.close();
}, 120_000);

test("a remote page reads the list and answers under the rules of every remote message", async () => {
	const c = await conversation();
	const q = await filed(c, "Which queue?", ["sqs", "nats"]);
	const asRemote = (path: string, body?: unknown) =>
		phone.fetch(
			path,
			{
				method: body === undefined ? "GET" : "POST",
				headers: { "content-type": "application/json", "x-omp-webui": "1" },
			},
			body === undefined ? undefined : JSON.stringify(body),
		);
	expect(((await (await asRemote("/api/questions")).json()) as QuestionList).questions.some((x) => x.id === q.id)).toBe(
		true,
	);
	// The instruction is read by any page and changed on this computer only.
	expect((await asRemote("/api/unattended")).status).toBe(200);
	const phoneEdit = await asRemote("/api/unattended", { instruction: "from a phone" });
	expect(phoneEdit.status).toBe(403);
	expect(((await phoneEdit.json()) as { error: string }).error).toContain("changed on the computer omp-webui runs on");
	const answered = await asRemote("/api/questions/answer", { id: q.id, options: ["nats"] });
	expect(answered.status, await answered.clone().text()).toBe(200);
	const delivered = await requestWith('Answer to your question \\"Which queue?\\"');
	expect(delivered.text).toContain("Chosen: nats");
	c.ws.close();

	// A conversation the gate does not cover (omp refuses `--trusted-extension` together with `--extension`) is not given a remote
	// page's turn while "Confirm risky commands from remote pages" is on: the answer is refused and stays open; this computer's goes.
	setRemote({ confirmRisky: true });
	const own = join(root, "trusted.ts");
	writeFileSync(own, "export default function () {}\n");
	const t = await conversation(["--trusted-extension", own]);
	// Its mode is on and it says what its omp does not carry; its own `ask` dialogs are still the server's to file.
	expect(t.live.unattended).toEqual({ live: false, skipped: "trustedExtension" });
	plan.call = {
		name: "ask",
		args: { questions: [{ id: "a", question: "Which topic?", options: [{ label: "x" }, { label: "y" }] }] },
	};
	await turn(t, "ASK-TRUSTED-646");
	const asked = (await list()).questions.find((x) => x.question === "Which topic?");
	expect(asked?.source).toBe("ask");
	if (!asked) throw new Error("unreachable");
	const refused = await asRemote("/api/questions/answer", { id: asked.id, options: ["x"] });
	expect(refused.status).toBe(403);
	expect(((await refused.json()) as { error: string }).error).toMatch(/Confirm risky commands from remote pages is on/);
	expect((await list()).questions.find((x) => x.id === asked.id)?.state).toBe("open");
	expect((await answerOf(asked, { options: ["y"] })).status).toBe(200);
	setRemote();
	t.ws.close();
}, 240_000);

test("the instruction the person edits reaches the next turn of an unattended conversation, and Restore default undoes it", async () => {
	const c = await conversation();
	const custom = "CUSTOM-INSTRUCTION-646: file everything, I am asleep.";
	const saved = await post("/api/unattended", { instruction: custom });
	expect(saved.status).toBe(200);
	expect(await saved.json()).toMatchObject({ instruction: custom, custom: true, shipped: DEFAULT_INSTRUCTION });
	const marked = `PROMPT-646-custom-${++seq}`;
	await turn(c, marked);
	const withCustom = await requestWith(marked);
	expect(withCustom.text).toContain(custom);
	expect(withCustom.text).not.toContain("Do not ask them anything directly");
	expect((await post("/api/unattended", { instruction: "   " })).status).toBe(422);
	expect((await post("/api/unattended", { instruction: "x".repeat(4_001) })).status).toBe(422);
	const restored = await post("/api/unattended", { instruction: null });
	expect(await restored.json()).toMatchObject({ custom: false });
	const again = `PROMPT-646-default-${++seq}`;
	await turn(c, again);
	const withDefault = await requestWith(again);
	expect(withDefault.text).toContain("Do not ask them anything directly");
	expect(withDefault.text).not.toContain(custom);
	c.ws.close();
}, 180_000);

test("the list, the mode and the instruction are private to the person and survive a restart", async () => {
	const c = await conversation();
	const q = await filed(c, "Which logger?", ["pino", "winston"]);
	await post("/api/unattended", { instruction: "KEPT-ACROSS-RESTART-646" });
	for (const file of ["questions.json", "unattended.json"])
		expect(statSync(join(dataDir, file)).mode & 0o777, file).toBe(0o600);
	c.ws.close();
	await s.restart();
	const after = await list();
	expect(after.questions.find((x) => x.id === q.id)).toMatchObject({ state: "open", question: "Which logger?" });
	expect(after.open).toBeGreaterThan(0);
	// The mode is kept for the conversation: opened again, it is unattended and told what the person wrote.
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "resume", sessionFile: q.session } });
	expect(live.unattended).toEqual({ live: true });
	const marked = `PROMPT-646-restart-${++seq}`;
	const frames = watchFrames(ws, live.liveId);
	const ended = frames.after("agent_end");
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: marked } });
	await ended;
	expect((await requestWith(marked)).text).toContain("KEPT-ACROSS-RESTART-646");
	await post("/api/unattended", { instruction: null });
	ws.close();
}, 240_000);
