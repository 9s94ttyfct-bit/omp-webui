import { afterAll, beforeAll, expect, test } from "bun:test";
import { goalObjective, hostResult, proposeGoalTool } from "../../shared/guided-goal.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { type Frame, messageWhere, watchFrames } from "../support/frames.ts";
import { canCallModel } from "../support/omp-env.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The omp interfaces the guided goal stands on, against the real omp and the real server: host tools (what the
 * model is offered, load mode), goal mode (`goal` create/get/drop), and, with a model, a host tool call held by the
 * server for the user, shown again to a tab that attaches later, answered, or cancelled by a stopped turn.
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

type RpcState = { dumpTools?: { name: string; description?: string; parameters?: unknown }[]; goal?: unknown };

/** The one model any test of this file calls (the two with a model below); the others never send a prompt. */
const MODEL = "anthropic/claude-haiku-5-5";

async function openLive(ws: WebSocket, approvalMode: "yolo" | "always-ask" = "yolo"): Promise<LiveInfo> {
	return request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: s.work, approvalMode, args: ["--model", MODEL] },
	});
}

const rpc = <T>(ws: WebSocket, liveId: string, command: Record<string, unknown>) =>
	request<T>(ws, { t: "rpc", liveId, command });

const tools = async (ws: WebSocket, liveId: string) =>
	(await rpc<RpcState>(ws, liveId, { type: "get_state" })).dumpTools ?? [];

test("the model is offered the host tool as the web UI defines it, and loses it when it is taken away", async () => {
	const ws = await connect(s);
	const live = await openLive(ws);
	const def = proposeGoalTool();
	expect((await tools(ws, live.liveId)).some((t) => t.name === def.name)).toBe(false);

	const registered = await rpc<{ toolNames: string[] }>(ws, live.liveId, { type: "set_host_tools", tools: [def] });
	expect(registered.toolNames).toEqual(["propose_goal"]);
	const offered = (await tools(ws, live.liveId)).find((t) => t.name === def.name);
	expect(offered?.parameters).toEqual(def.parameters);
	expect(offered?.description).toBe(def.description);

	// Re-sending replaces the set: an empty one takes the tool away.
	await rpc(ws, live.liveId, { type: "set_host_tools", tools: [] });
	expect((await tools(ws, live.liveId)).some((t) => t.name === def.name)).toBe(false);
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 60_000);

test("a host tool that is not `essential` is not in the model's tool list: why the definition says it is", async () => {
	const ws = await connect(s);
	const live = await openLive(ws);
	const { loadMode: _essential, ...discoverable } = proposeGoalTool();
	await rpc(ws, live.liveId, { type: "set_host_tools", tools: [discoverable] });
	expect((await tools(ws, live.liveId)).some((t) => t.name === discoverable.name)).toBe(false);
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 60_000);

test("a host tool cannot take the name of a built-in tool", async () => {
	const ws = await connect(s);
	const live = await openLive(ws);
	await expect(
		rpc(ws, live.liveId, {
			type: "set_host_tools",
			tools: [{ ...proposeGoalTool(), name: "bash" }],
		}),
	).rejects.toThrow(/conflicts with an existing tool/);
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 60_000);

test("a confirmed proposal becomes a goal: the objective with its criteria, a budget, one goal at a time", async () => {
	const ws = await connect(s);
	const live = await openLive(ws);
	const objective = goalObjective({ objective: "Ship the release", criteria: ["Tests pass", "Notes are written"] });
	const created = await rpc<{ goal: { objective: string; status: string; tokenBudget: number } }>(ws, live.liveId, {
		type: "goal",
		op: "create",
		objective,
		token_budget: 150_000,
	});
	expect(created.goal).toMatchObject({ objective, status: "active", tokenBudget: 150_000 });
	expect(created.goal.objective).toBe("Ship the release\n\nAcceptance criteria:\n- Tests pass\n- Notes are written");

	await expect(rpc(ws, live.liveId, { type: "goal", op: "create", objective: "Another" })).rejects.toThrow(
		/already active/,
	);
	await rpc(ws, live.liveId, { type: "goal", op: "drop" });
	expect((await rpc<{ goal: unknown }>(ws, live.liveId, { type: "goal", op: "get" })).goal).toBeNull();
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 60_000);

// ------------------------------------------------------------------ with a model (Claude Haiku 5.5)

/** The model proposes at once instead of interviewing, so the test spends one short turn. */
const FORCED =
	'Call the propose_goal tool right now, without asking anything, with objective "Reply with the single word PONG", ' +
	'acceptance_criteria ["The reply is the word PONG"] and token_budget 50000. Then follow whatever the tool returns.';

test.if(canCallModel())(
	"a proposal is held for the user, shown again to a tab that attaches later, and its answer reaches the model",
	async () => {
		const first = await connect(s);
		const live = await openLive(first);
		const one = watchFrames(first, live.liveId);
		await rpc(first, live.liveId, { type: "set_host_tools", tools: [proposeGoalTool()] });
		await rpc(first, live.liveId, { type: "prompt", message: FORCED });
		const call = await one.next((f) => f.type === "host_tool_call");
		expect(call).toMatchObject({ toolName: "propose_goal", arguments: { token_budget: 50000 } });

		// The tab is reloaded: it attaches again and is shown the call that still waits.
		const second = await connect(s);
		const two = watchFrames(second, live.liveId);
		await request(second, { t: "attach", liveId: live.liveId });
		expect(await two.next((f) => f.type === "host_tool_call")).toMatchObject({ id: call.id });

		// It answers; the other tab is told, and the model continues from the result.
		const settled = one.next((f) => f.type === "session_settled");
		const dropped = messageWhere(
			first,
			(m) => m.t === "frame" && (m.frame as Frame).method === "cancel" && (m.frame as Frame).targetId === call.id,
		);
		second.send(
			JSON.stringify({
				t: "ui_response",
				liveId: live.liveId,
				response: { id: call.id, ...hostResult("Reply with the single word ACK and nothing else.") },
			}),
		);
		await dropped;
		await settled;
		const reply = await rpc<{ text: string | null }>(first, live.liveId, { type: "get_last_assistant_text" });
		expect(reply.text).toMatch(/ACK/);
		for (const ws of [first, second]) ws.close();
	},
	120_000,
);

test.if(canCallModel())(
	"stopping the turn cancels the call: no tab is shown it afterwards",
	async () => {
		const first = await connect(s);
		const live = await openLive(first);
		const one = watchFrames(first, live.liveId);
		await rpc(first, live.liveId, { type: "set_host_tools", tools: [proposeGoalTool()] });
		await rpc(first, live.liveId, { type: "prompt", message: FORCED });
		const call = await one.next((f) => f.type === "host_tool_call");
		const cancelled = one.after("host_tool_cancel");
		await rpc(first, live.liveId, { type: "abort" });
		expect(await cancelled).toMatchObject({ targetId: call.id });

		// A tab that attaches now has nothing to decide: the replay comes before the reply to the next request.
		const late = await connect(s);
		const watcher = watchFrames(late, live.liveId);
		await request(late, { t: "attach", liveId: live.liveId });
		await request(late, { t: "list_lives" });
		expect(watcher.seen.filter((f) => f.type === "host_tool_call")).toEqual([]);
		for (const ws of [first, late]) ws.close();
	},
	120_000,
);
