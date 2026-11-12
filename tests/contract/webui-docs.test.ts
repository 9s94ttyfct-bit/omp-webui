import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_NOTE } from "../../server/omp/docs-tool/extension.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
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
 * The `webui_docs` tool against the real omp and the real server. The agent is a scripted provider: no model is called.
 *
 * What is measured: a conversation the app starts has omp loaded with the docs extension (`--extension` of the installed copy
 * under the data folder); the main agent's request offers `webui_docs` (mounted at `xd://webui_docs`, omp's discoverable
 * tools); a call of it through that device reads the bundled docs, and a topic that is a path is refused as the tool's error.
 */

const DEVICE = "xd://webui_docs";
/** What omp's prompt for a task subagent says (its request is told apart by it). */
const SUBAGENT = "You are operating on a piece of work assigned to you by the main agent";

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
	// A subagent reports at once.
	if (req.text.includes(SUBAGENT)) return { text: "Scout report." };
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

interface Conversation {
	live: LiveInfo;
	ws: WebSocket;
	frames: ReturnType<typeof watchFrames>;
}

async function conversation(): Promise<Conversation> {
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work, approvalMode: "yolo" } });
	return { live, ws, frames: watchFrames(ws, live.liveId) };
}

/** Send `message` and wait for the turn to end. */
async function turn(c: Conversation, message: string): Promise<void> {
	const from = c.frames.seen.length;
	const ended = c.frames.next((f: Frame) => c.frames.seen.indexOf(f) >= from && f.type === "agent_end");
	await request(c.ws, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message } });
	await ended;
}

/** The main agent's request for the prompt `m`. */
async function mainRequestFor(m: string): Promise<ScriptedRequest> {
	await pollUntil(
		() => agent.requests.some((r) => r.text.includes(m) && r.tools.includes("task")),
		`a request for ${m}`,
	);
	const found = agent.requests.find((r) => r.text.includes(m) && r.tools.includes("task"));
	if (!found) throw new Error("unreachable");
	return found;
}

const mark = (what: string) => `PROMPT-DOCS-${what}-${++seq}`;

/** A call of the tool through omp's device for it: `write` its arguments to `xd://webui_docs`. */
const docsCall = (args: Record<string, unknown>): Call => ({
	name: "write",
	args: { path: DEVICE, content: JSON.stringify(args) },
});

test("the app starts omp with the docs extension, and the main agent is offered webui_docs", async () => {
	const c = await conversation();
	const given = c.live.args.flatMap((arg, i) => (c.live.args[i - 1] === "--extension" ? [arg] : []));
	const extension = given.find((a) =>
		a.split("\\").join("/").endsWith("/webui-docs/server/omp/docs-tool/extension.ts"),
	);
	expect(extension).toBeDefined();
	// The server put the extension, its lookup and the docs in place before it started omp.
	for (const f of ["extension.ts", "lookup.ts", "docs-data.ts"])
		expect(existsSync(join(String(extension), "..", f))).toBe(true);
	const m = mark("offered");
	await turn(c, m);
	const req = await mainRequestFor(m);
	// Mounted among omp's discoverable tools, with its summary: the schema is read on demand. omp up to 18.18 lists the
	// device as `- xd://webui_docs — …`; 18.19 drops the scheme (`- webui_docs — …`, read through `xd://<tool>`).
	expect(req.text).toMatch(/- (xd:\/\/)?webui_docs — Look up omp-webui's own documentation/);
	// And told to look at pages in the built-in browser, never in a window on the person's desktop.
	expect(req.text).toContain(BROWSER_NOTE.split("\n")[1]);
	c.ws.close();
}, 120_000);

test("a subagent is told where to look at web pages too", async () => {
	const c = await conversation();
	const word = mark("sub");
	plan.main = {
		name: "task",
		args: { context: "# Goal\nShared.", tasks: [{ name: "Scout", task: `Report back. ${word}-TASK` }] },
	};
	await turn(c, word);
	await pollUntil(
		() => agent.requests.some((r) => r.text.includes(SUBAGENT) && r.text.includes(`${word}-TASK`)),
		"the subagent's request",
	);
	const sub = agent.requests.find((r) => r.text.includes(SUBAGENT) && r.text.includes(`${word}-TASK`));
	expect(sub?.text).toContain(BROWSER_NOTE.split("\n")[1]);
	c.ws.close();
}, 120_000);

test("a call reads the bundled docs; a topic that is a path is refused", async () => {
	const c = await conversation();
	told.length = 0;
	plan.main = docsCall({ action: "read", topic: "webui-docs-tool", section: "Security notes" });
	await turn(c, mark("read"));
	expect(told.at(-1)).toContain("Read-only by construction");
	plan.main = docsCall({ action: "search", query: "xd://webui_docs" });
	await turn(c, mark("search"));
	expect(told.at(-1)).toContain("webui-docs-tool ›");
	plan.main = docsCall({ action: "read", topic: "../../token" });
	await turn(c, mark("traversal"));
	expect(told.at(-1)).toContain("is not a topic name");
	expect(told.at(-1)).not.toContain(s.accessToken);
	c.ws.close();
}, 120_000);
