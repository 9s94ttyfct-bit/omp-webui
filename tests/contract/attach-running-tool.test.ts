import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { messageWhere, watchFrames } from "../support/frames.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A tab that attaches while a tool runs (a reload, the Mac app's window opened again, a second tab) is told that it runs and
 * since when, against the real omp and the real server, the model a scripted provider: a tool that prints nothing sends no
 * frame between its start and its end, and the tab showed the call as one about to start (no bar, no clock) until it ended.
 */

const QUIET = "Run the quiet command";
const LOUD = "Run the loud command";

let server: TestServer;
let backend: StubScripted;

const script = (req: { text: string; tools: string[]; toolResults: number }): ScriptedTurn => {
	if (!req.tools.includes("bash")) return { text: "A title" };
	if (req.toolResults > 0) return { text: "Done." };
	if (req.text.includes(QUIET)) return { call: { name: "bash", args: { command: "sleep 600" } } };
	if (req.text.includes(LOUD)) return { call: { name: "bash", args: { command: "echo first-line; sleep 600" } } };
	return { text: "Ok." };
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

/** A conversation whose tool runs `prompt`'s command; the frames of the tab that started it, and when the turn was asked. */
async function running(prompt: string) {
	const ws = await connect(server);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	const frames = watchFrames(ws, live.liveId);
	const asked = Date.now();
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: prompt } });
	const start = await frames.next((f) => f.type === "tool_execution_start");
	return { ws, live, frames, start, asked };
}

/** A second tab attaches; it has heard all the server replays once the server says that is all (`attached`). */
async function attach(liveId: string) {
	const late = await connect(server);
	const lateFrames = watchFrames(late, liveId);
	const done = messageWhere(late, (m) => m.t === "attached" && m.liveId === liveId);
	await request(late, { t: "attach", liveId });
	await done;
	return { late, lateFrames };
}

test("a tab that attaches while a quiet tool runs is given its start, with when it began on the server's clock", async () => {
	const { ws, live, frames, start, asked } = await running(QUIET);
	// Long enough that a start stamped at the attach would be told apart from the real one.
	await Bun.sleep(1200);
	const { late, lateFrames } = await attach(live.liveId);
	const replayed = await lateFrames.next((f) => f.type === "tool_execution_start" && f.toolCallId === start.toolCallId);
	expect(replayed).toMatchObject({ toolName: "bash", args: { command: "sleep 600" } });
	expect(typeof replayed.startedAt).toBe("number");
	expect(replayed.startedAt as number).toBeGreaterThanOrEqual(asked);
	expect(Date.now() - (replayed.startedAt as number)).toBeGreaterThanOrEqual(1200);

	// Once the turn is stopped nothing runs, and a tab that attaches then is told of no tool.
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "abort_and_restore_queue" }, stop: true });
	await frames.next((f) => f.type === "agent_end");
	const after = await attach(live.liveId);
	await Bun.sleep(300);
	expect(after.lateFrames.seen.filter((f) => f.type === "tool_execution_start")).toEqual([]);

	await request(ws, { t: "close", liveId: live.liveId });
	for (const s of [ws, late, after.late]) s.close();
}, 120_000);

test("a tool that printed something is replayed with what it printed last, after its start", async () => {
	const { ws, live, frames, start } = await running(LOUD);
	const printed = await frames.next(
		(f) => f.type === "tool_execution_update" && JSON.stringify(f).includes("first-line"),
	);
	const { late, lateFrames } = await attach(live.liveId);
	await lateFrames.next((f) => f.type === "tool_execution_update" && f.toolCallId === start.toolCallId);
	const mine = lateFrames.seen.filter((f) => f.toolCallId === start.toolCallId).map((f) => f.type);
	expect(mine.slice(0, 2)).toEqual(["tool_execution_start", "tool_execution_update"]);
	expect(JSON.stringify(lateFrames.seen.find((f) => f.type === "tool_execution_update"))).toContain("first-line");
	expect(printed.toolCallId).toBe(start.toolCallId);

	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "abort_and_restore_queue" }, stop: true });
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
	late.close();
}, 120_000);
