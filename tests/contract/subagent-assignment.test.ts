import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo, LiveListing, SessionEntry } from "../../shared/protocol.ts";
import { assignmentOfInit, taskItemsOf } from "../../web/src/lib/subagent-assignment.ts";
import { watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * What a real omp sends a subagent, and where it records it (no model call: a scripted provider makes the main agent
 * call the task tool). The web UI reads the assignment from the subagent's transcript (the `session_init` record: the
 * first user message, and the shared context in the system prompt), from the task call's arguments and result, and from
 * the progress frames; this pins all of them to the same words, in the omp that is installed.
 */

const TASK = "Reply with the single word ECHO-DONE.\n\n## Second paragraph\n- a list item";
/** A context with a line that looks like a section of omp's subagent prompt: it must come back whole. */
const CONTEXT = "# Goal\nShared background for every subagent.\n\n- one\n- two\n\n§ Coop\nA line of the context.";
const NESTED = "You are operating on a piece of work assigned to you by the main agent";

let server: TestServer;
let backend: StubScripted;

const script = (req: { text: string; tools: string[]; toolResults: number }): ScriptedTurn => {
	// The subagent's prompt says what its Coop section says; the main agent's does not.
	if (req.text.includes(NESTED)) return { text: "ECHO-DONE" };
	// Other requests of the main agent's process (titles) offer no task tool: they get a text.
	if (!req.tools.includes("task")) return { text: "A title" };
	if (req.toolResults === 0)
		return { call: { name: "task", args: { context: CONTEXT, tasks: [{ name: "Echo", task: TASK }] } } };
	return { text: "The subagent reported." };
};

beforeAll(async () => {
	backend = await startScriptedStub(script);
	server = await startTestServer();
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
}, 120_000);

afterAll(async () => {
	await server?.stop();
	await backend?.stop();
});

/** The records of a transcript file, as the server reads them. */
function recordsOf(file: string): SessionEntry[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			const record: unknown = JSON.parse(line);
			return isRecord(record) && typeof record.id === "string" ? [record as SessionEntry] : [];
		});
}

test("omp gives a subagent the call's task as its first message and the call's context in its system prompt, and says both in its frames and result", async () => {
	const ws = await connect(server);
	const info = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	const frames = watchFrames(ws, info.liveId);
	const progress = frames.next((f) => f.type === "subagent_progress");
	const ended = frames.next((f) => f.type === "agent_end");
	await request(ws, { t: "rpc", liveId: info.liveId, command: { type: "prompt", message: "Send a scout" } });
	const frame = await progress;
	await ended;
	try {
		const lives = await request<LiveListing[]>(ws, { t: "list_lives" });
		const sessionFile = lives.find((l) => l.liveId === info.liveId)?.sessionFile;
		if (!sessionFile) throw new Error("omp wrote no session file");

		// The frames carry the task as the call wrote it, and as the first message renders it.
		const payload = isRecord(frame.payload) ? frame.payload : {};
		expect(payload.assignment).toBe(TASK);
		expect(payload.task).toBe(`Complete assignment thoroughly:\n\n${TASK}`);

		// The subagent's transcript opens with the record of both texts.
		const transcript = join(sessionFile.replace(/\.jsonl$/, ""), "Echo.jsonl");
		await pollUntil(
			() => existsSync(transcript) && readFileSync(transcript, "utf8").includes('"role":"assistant"'),
			"the subagent's reply",
		);
		const entries = recordsOf(transcript);
		expect(assignmentOfInit(entries)).toEqual({ task: TASK, context: CONTEXT });
		const first = entries.find((e) => e.type === "message");
		const content = isRecord(first?.message) ? first.message.content : undefined;
		expect(Array.isArray(content) && isRecord(content[0]) ? content[0].text : undefined).toBe(
			`Complete assignment thoroughly:\n\n${TASK}`,
		);

		// The conversation's own file has the call and its result: the same two texts, and the id omp gave the subagent.
		const own = recordsOf(sessionFile);
		const messages = own.flatMap((e) => (isRecord(e.message) ? [e.message] : []));
		const call = messages
			.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.find((b) => isRecord(b) && b.type === "toolCall" && b.name === "task");
		const result = messages.find((m) => m.role === "toolResult" && m.toolName === "task");
		expect(taskItemsOf(isRecord(call) ? call.arguments : undefined, result?.details)).toEqual([
			{ name: "Echo", agent: undefined, assignment: { task: TASK, context: CONTEXT } },
		]);
	} finally {
		void request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
		ws.close();
	}
}, 90_000);
