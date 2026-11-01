import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESTART_ACCEPTED_RESULT } from "../../server/omp/restart/extension.ts";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { RESTART_TOOL } from "../../shared/restart.ts";
import { type Frame, watchFrames } from "../support/frames.ts";
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
 * `restart_session` against the real omp and the real server. The agent is a scripted provider: no model is called.
 *
 * What is measured: omp loads the extension the app starts it with; the main agent's requests offer the tool and a
 * subagent's do not; a call returns at once with the tool's result; when the main agent's turn ends the server ends that omp
 * and resumes the same session file in a new one, which is sent the agent's `continue_with` once.
 */

const NESTED = "You are operating on a piece of work assigned to you by the main agent";

interface Call {
	name: string;
	args: unknown;
}

let s: TestServer;
let agent: StubScripted;
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
		return { text: "Ending the turn." };
	}
	const next = plan.main;
	plan.main = null;
	return next ? { call: next } : { text: "Carried on." };
};

beforeAll(async () => {
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
});

async function conversation() {
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work, approvalMode: "yolo" } });
	return { live, ws, frames: watchFrames(ws, live.liveId) };
}

/** Send `message` and wait for the turn to end. */
async function turn(c: Awaited<ReturnType<typeof conversation>>, message: string): Promise<void> {
	const from = c.frames.seen.length;
	const ended = c.frames.next((f: Frame) => c.frames.seen.indexOf(f) >= from && f.type === "agent_end");
	await request(c.ws, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message } });
	await ended;
}

const mark = (what: string) => `PROMPT-RESTART-${what}-${++seq}`;

test("the main agent is offered restart_session, and a subagent is not", async () => {
	const c = await conversation();
	const extension = c.live.args.find(
		(arg, i) => c.live.args[i - 1] === "--extension" && arg.endsWith("/restart/server/omp/restart/extension.ts"),
	);
	expect(extension).toBeDefined();
	const m = mark("offered");
	plan.main = { name: "task", args: { context: "# Goal\nShared.", tasks: [{ name: "Scout", task: "Say SUB-DONE" }] } };
	await turn(c, m);
	const main = agent.requests.find((r) => r.text.includes(m) && r.tools.includes("task"));
	expect(main?.tools).toContain(RESTART_TOOL);
	await pollUntil(() => agent.requests.some((r) => r.text.includes(NESTED)), "the subagent's request", 60_000);
	for (const sub of agent.requests.filter((r) => r.text.includes(NESTED)))
		expect(sub.tools).not.toContain(RESTART_TOOL);
	c.ws.close();
}, 180_000);

test("a call ends the main agent's omp when its turn ends; a new omp resumes the conversation and is told once", async () => {
	const c = await conversation();
	// The conversation has a file before the restart: the first exchange writes it.
	await turn(c, mark("first"));
	const next = `NEXT-STEP-${++seq}`;
	plan.main = { name: RESTART_TOOL, args: { reason: "bash hangs", continue_with: `Do ${next} again if needed.` } };
	await turn(c, mark("restart"));
	expect(told.at(-1)).toContain(RESTART_ACCEPTED_RESULT);
	// A new process runs the conversation, and the agent is told what it asked for.
	const lives = () => request<LiveListing[]>(c.ws, { t: "list_lives" });
	const first = (await lives()).find((l) => l.liveId === c.live.liveId);
	const file = first?.sessionFile;
	expect(file).toBeTruthy();
	await pollUntil(
		async () => (await lives()).some((l) => !l.exited && l.sessionFile === file && l.liveId !== c.live.liveId),
		"the new process",
		60_000,
	);
	await pollUntil(
		() => agent.requests.some((r) => r.text.includes(next) && r.text.includes("Restarted by the agent")),
		"the message",
		60_000,
	);
	await pollUntil(
		() => readFileSync(String(file), "utf8").includes("Restarted by the agent: bash hangs"),
		"the message saved",
		30_000,
	);
	const saved = readFileSync(String(file), "utf8")
		.split("\n")
		.filter((line) => line.includes("Restarted by the agent: bash hangs"));
	expect(saved).toHaveLength(1);
	expect((await lives()).find((l) => l.liveId === c.live.liveId)?.exited ?? true).toBe(true);
	c.ws.close();
}, 240_000);
