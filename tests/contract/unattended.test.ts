import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuardConfig } from "../../shared/guard.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { ASK_RECORDED_REPLY, type Question, type QuestionList, UNATTENDED_TOOL } from "../../shared/unattended.ts";
import { type Frame, messageWhere, watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import {
	type ScriptedRequest,
	type ScriptedTurn,
	type StubScripted,
	startScriptedStub,
} from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Unattended mode (#646) against the real omp and the real server. The agent is a scripted provider: no model is called.
 *
 * What is measured: the standing instruction is in the **main agent's** provider request only while the mode is on (and in no
 * subagent's); `file_question` is offered only then, files the question and returns at once; an omp `ask` dialog of an
 * unattended conversation is answered by the server and filed, the turn goes on, and no page is shown a dialog; the guard's
 * own question is **never** answered for the person; an answer goes to the conversation as a message, queued while it works,
 * resuming it when it is closed.
 */

const NESTED = "You are operating on a piece of work assigned to you by the main agent";
const HEADING = "## Unattended mode";

interface Call {
	name: string;
	args: unknown;
}

let s: TestServer;
let agent: StubScripted;
const root = mkdtempSync(join(tmpdir(), "ompw-unattended-contract-"));
const outside = join(root, "outside");
/** What the scripted main agent does next, once. */
const plan: { main: Call | null } = { main: null };
/** What the tools answered the main agent, in order. */
const told: string[] = [];
let seq = 0;

const script = (req: ScriptedRequest): ScriptedTurn => {
	if (req.text.includes(NESTED)) return { text: "SUB-DONE" };
	// A title's request offers no task tool.
	if (!req.tools.includes("task")) return { text: "A title" };
	const messages = JSON.parse(req.text) as { role?: string; content?: unknown }[];
	const last = messages.at(-1);
	if (last?.role === "tool") {
		told.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
		return { text: "Main done." };
	}
	const next = plan.main;
	plan.main = null;
	return next ? { call: next } : { text: "Nothing to do." };
};

const authed = (extra: Record<string, string> = {}) => ({
	"x-omp-webui-token": s.accessToken,
	"x-omp-webui": "1",
	...extra,
});
const post = (path: string, body: unknown) =>
	fetch(`${s.url}${path}`, {
		method: "POST",
		headers: authed({ "content-type": "application/json" }),
		body: JSON.stringify(body),
	});
const questions = async (): Promise<QuestionList> => {
	const res = await fetch(`${s.url}/api/questions`, { headers: authed() });
	expect(res.status).toBe(200);
	return (await res.json()) as QuestionList;
};

beforeAll(async () => {
	mkdirSync(outside, { recursive: true });
	agent = await startScriptedStub(script);
	s = await startTestServer(0, {}, { login: false });
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
}, 120_000);

afterAll(async () => {
	await s?.stop();
	await agent?.stop();
	rmSync(root, { recursive: true, force: true });
});

interface Conversation {
	live: LiveInfo;
	ws: WebSocket;
	frames: ReturnType<typeof watchFrames>;
}

async function conversation(
	unattended: boolean | undefined,
	approvalMode: "yolo" | undefined = "yolo",
): Promise<Conversation> {
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: s.work, approvalMode, ...(unattended === undefined ? {} : { unattended }) },
	});
	return { live, ws, frames: watchFrames(ws, live.liveId) };
}

const prompt = (c: Conversation, message: string) =>
	request(c.ws, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message } });

/** The first frame from now on that satisfies `match`. */
const fresh = (c: Conversation, match: (f: Frame) => boolean): Promise<Frame> => {
	const from = c.frames.seen.length;
	return c.frames.next((f) => c.frames.seen.indexOf(f) >= from && match(f));
};

/** Send `message` and wait for the turn to end. */
async function turn(c: Conversation, message: string): Promise<void> {
	const ended = fresh(c, (f) => f.type === "agent_end");
	await prompt(c, message);
	await ended;
}

const mark = (what: string) => `PROMPT-646-${what}-${++seq}`;

/** The main agent's request for the prompt `m`: the first one that carries it and offers the task tool. */
async function mainRequestFor(m: string): Promise<ScriptedRequest> {
	await pollUntil(
		() => agent.requests.some((r) => r.text.includes(m) && r.tools.includes("task")),
		`a request for ${m}`,
	);
	const found = agent.requests.find((r) => r.text.includes(m) && r.tools.includes("task"));
	if (!found) throw new Error("unreachable");
	return found;
}

const FILE = {
	title: "Which database should the service use?",
	context: "Postgres is installed here; SQLite is simpler to ship.",
	options: [{ label: "Postgres", description: "what is installed" }, { label: "SQLite" }],
	recommended: 0,
	meanwhile: "Wrote the schema both ways.",
};

test("off: the main agent's request has no instruction and no question tool", async () => {
	const c = await conversation(undefined);
	expect(c.live.unattended).toBeUndefined();
	const m = mark("off");
	await turn(c, m);
	const req = await mainRequestFor(m);
	expect(req.text).not.toContain(HEADING);
	expect(req.tools).not.toContain(UNATTENDED_TOOL);
	c.ws.close();
}, 120_000);

test("on from the start: the instruction and the tool reach the main agent's first request, and no subagent's", async () => {
	const c = await conversation(true);
	// What the page is told: the mode is on, and its omp carries the instruction (the extension said it started).
	expect(c.live.unattended).toEqual({ live: true });
	const m = mark("on");
	plan.main = {
		name: "task",
		args: { context: "# Goal\nShared.", tasks: [{ name: "Scout", task: "Say SUB-DONE" }] },
	};
	await turn(c, m);
	const req = await mainRequestFor(m);
	expect(req.text).toContain(HEADING);
	expect(req.text).toContain(UNATTENDED_TOOL);
	expect(req.tools).toContain(UNATTENDED_TOOL);
	// The subagent's own prompt carries neither, and offers it no such tool.
	await pollUntil(() => agent.requests.some((r) => r.text.includes(NESTED)), "the subagent's request");
	for (const sub of agent.requests.filter((r) => r.text.includes(NESTED))) {
		expect(sub.text).not.toContain(HEADING);
		expect(sub.tools).not.toContain(UNATTENDED_TOOL);
	}
	c.ws.close();
}, 180_000);

test("file_question files the question and returns at once; the turn goes on", async () => {
	const c = await conversation(true);
	const pushed = messageWhere(c.ws, (m) => m.t === "questions");
	plan.main = { name: UNATTENDED_TOOL, args: FILE };
	told.length = 0;
	await turn(c, mark("file"));
	// The model was told it was recorded, and the turn ended without anybody answering.
	expect(told.at(-1)).toContain("Recorded for the person");
	const counts = (await pushed).counts as { open: number };
	expect(counts.open).toBeGreaterThan(0);
	const list = await questions();
	const q = list.questions.find((x) => x.question === FILE.title);
	expect(q).toMatchObject({
		source: "tool",
		state: "open",
		context: FILE.context,
		options: FILE.options,
		recommended: 0,
		meanwhile: FILE.meanwhile,
	});
	expect(q?.session).toBe(c.live.sessionFile ?? q?.session);
	expect(list.byConversation[q?.session ?? ""]).toBeGreaterThan(0);
	c.ws.close();
}, 120_000);

test("a question the list cannot keep is said in the conversation, and the model is told it was recorded all the same", async () => {
	const c = await conversation(true);
	// A conversation with its 60 open questions already: the list is the server's file, written whole as the server writes it.
	const m = mark("dropped-seed");
	await turn(c, m);
	const session = c.live.sessionFile;
	expect(typeof session).toBe("string");
	const full = Array.from({ length: 60 }, (_, i) => ({
		id: `qfull${i}`,
		session,
		title: "",
		source: "tool",
		question: `Open question ${i}?`,
		context: "",
		options: [],
		askedAt: Date.now() - (60 - i) * 60_000,
		state: "open",
	}));
	writeFileSync(join(s.root, "data", "questions.json"), JSON.stringify({ rev: 900, questions: full }), { mode: 0o600 });
	plan.main = { name: UNATTENDED_TOOL, args: { ...FILE, title: "The sixty-first?" } };
	told.length = 0;
	await turn(c, mark("dropped"));
	// The model's result is untouched: it must not wait or try again.
	expect(told.at(-1)).toContain("Recorded for the person");
	// The conversation's own state carries it (`LiveInfo.questionDropped`), so a page that shows it — or attaches later — has it.
	const said = async (): Promise<LiveInfo | undefined> =>
		((await (await fetch(`${s.url}/api/lives`, { headers: authed() })).json()) as LiveInfo[]).find(
			(l) => l.liveId === c.live.liveId,
		);
	await pollUntil(async () => (await said())?.questionDropped?.question === "The sixty-first?", "the dropped question");
	expect((await said())?.questionDropped).toMatchObject({ why: "full", question: "The sixty-first?" });
	// The list holds it as dropped, for the Questions page, and the question itself is not in it.
	const list = await questions();
	expect(list.questions.filter((q) => q.question === "The sixty-first?")).toEqual([]);
	expect(list.dropped).toEqual([expect.objectContaining({ session, why: "full", question: "The sixty-first?" })]);
	c.ws.close();
}, 180_000);

test("an ask dialog of an unattended conversation is answered by the server and filed; the turn goes on", async () => {
	const c = await conversation(true);
	plan.main = {
		name: "ask",
		args: {
			questions: [
				{ id: "db", question: "Which cache?", options: [{ label: "Redis" }, { label: "None" }], recommended: 1 },
			],
		},
	};
	told.length = 0;
	// No page is shown a dialog.
	await turn(c, mark("ask"));
	expect(c.frames.seen.some((f) => f.type === "extension_ui_request" && f.method === "ask")).toBe(false);
	// The model read the fixed reply as the answer, and the turn went on.
	expect(told.at(-1)).toContain("Recorded for the person");
	expect(told.at(-1)).toContain(ASK_RECORDED_REPLY.slice(0, 30));
	const q = (await questions()).questions.find((x) => x.question === "Which cache?");
	expect(q).toMatchObject({
		source: "ask",
		state: "open",
		options: [{ label: "Redis" }, { label: "None" }],
		recommended: 1,
	});
	c.ws.close();
}, 120_000);

test("an ask dialog of a conversation that is not unattended is still a dialog for the page", async () => {
	const c = await conversation(undefined);
	plan.main = {
		name: "ask",
		args: {
			questions: [{ id: "q", question: "Which cache, really?", options: [{ label: "Redis" }, { label: "None" }] }],
		},
	};
	const dialog = fresh(c, (f) => f.type === "extension_ui_request" && f.method === "ask");
	const ended = fresh(c, (f) => f.type === "agent_end");
	await prompt(c, mark("ask-off"));
	const frame = await dialog;
	// Nothing answered it, so the turn is still waiting; the page answers.
	expect((await questions()).questions.some((x) => x.question === "Which cache, really?")).toBe(false);
	c.ws.send(
		JSON.stringify({
			t: "ui_response",
			liveId: c.live.liveId,
			response: { id: frame.id, answers: [{ id: "q", selectedOptions: ["Redis"] }] },
		}),
	);
	await ended;
	c.ws.close();
}, 120_000);

test("turning the mode on or off reaches the next turn without a restart", async () => {
	const c = await conversation(undefined);
	const before = mark("before");
	await turn(c, before);
	expect((await mainRequestFor(before)).tools).not.toContain(UNATTENDED_TOOL);
	const on = await post("/api/unattended/live", { liveId: c.live.liveId, on: true });
	expect(on.status).toBe(200);
	expect(((await on.json()) as { unattended: { live: boolean } }).unattended).toEqual({ live: true });
	const during = mark("during");
	await turn(c, during);
	const req = await mainRequestFor(during);
	expect(req.text).toContain(HEADING);
	expect(req.tools).toContain(UNATTENDED_TOOL);
	const off = await post("/api/unattended/live", { liveId: c.live.liveId, on: false });
	expect(off.status).toBe(200);
	const after = mark("after");
	await turn(c, after);
	const last = await mainRequestFor(after);
	expect(last.text).not.toContain(HEADING);
	expect(last.tools).not.toContain(UNATTENDED_TOOL);
	c.ws.close();
}, 180_000);

test("the guard's own question is never answered for the person", async () => {
	const res = await post("/api/guard", { mode: "ask" } satisfies Partial<GuardConfig>);
	expect(res.status).toBe(200);
	const c = await conversation(true);
	const target = join(outside, "guarded.txt");
	plan.main = { name: "write", args: { path: target, content: "from the agent" } };
	const asked = fresh(
		c,
		(f) =>
			f.type === "extension_ui_request" &&
			f.method === "select" &&
			String(f.title ?? "").startsWith("Confirm risky call:"),
	);
	const ended = fresh(c, (f) => f.type === "agent_end");
	await prompt(c, mark("guard"));
	const dialog = await asked;
	// The mode did not answer it: it waits for the person, whatever the mode says, and nothing was filed for it.
	await Bun.sleep(1_500);
	expect(
		c.frames.seen.some((f) => f.type === "extension_ui_request" && f.method === "cancel" && f.targetId === dialog.id),
	).toBe(false);
	expect(await Bun.file(target).exists()).toBe(false);
	expect((await questions()).questions.some((x) => x.question.includes("Confirm risky"))).toBe(false);
	// The person refuses it; the turn ends.
	c.ws.send(JSON.stringify({ t: "ui_response", liveId: c.live.liveId, response: { id: dialog.id, value: "Deny" } }));
	await ended;
	expect(await Bun.file(target).exists()).toBe(false);
	await post("/api/guard", { mode: "off" } satisfies Partial<GuardConfig>);
	c.ws.close();
}, 120_000);

export type { Question };
