import { afterAll, beforeAll, expect, test } from "bun:test";
import { hostResult, proposeGoalTool } from "../../shared/guided-goal.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { type Frame, watchFrames } from "../support/frames.ts";
import { canCallModel } from "../support/omp-env.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The guided goal against the real omp and the real server, where it meets tool approval and the process's life:
 * the interview's one tool must never be put behind an approval prompt of omp's own (Claude Haiku 5.5, a few short
 * turns), and an interview must outlive the omp process it was started in (no model).
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

const MODEL = "anthropic/claude-haiku-5-5";

const rpc = <T>(ws: WebSocket, liveId: string, command: Record<string, unknown>) =>
	request<T>(ws, { t: "rpc", liveId, command });

const toolNames = async (ws: WebSocket, liveId: string) =>
	((await rpc<{ dumpTools?: { name: string }[] }>(ws, liveId, { type: "get_state" })).dumpTools ?? []).map(
		(t) => t.name,
	);

// ------------------------------------------------------------------ approval

/** The model proposes at once instead of interviewing, so the test spends one short turn. */
const FORCED =
	'Call the propose_goal tool right now, without asking anything, with objective "Reply with the single word PONG", ' +
	'acceptance_criteria ["The reply is the word PONG"] and token_budget 50000. Then follow whatever the tool returns.';

/** What omp waits on: a tool's own call, or a prompt of its own to allow a tool. */
const waitsOnUser = (f: Frame) =>
	f.type === "host_tool_call" ||
	(f.type === "extension_ui_request" && ["select", "confirm"].includes(String(f.method)));

for (const mode of ["always-ask", "write"] as const) {
	test.if(canCallModel())(
		`with approval set to ${mode}, the first thing the user is asked is the proposal itself, not whether to allow propose_goal`,
		async () => {
			const ws = await connect(s);
			const live = await request<LiveInfo>(ws, {
				t: "open",
				target: { kind: "new", cwd: s.work, approvalMode: mode, args: ["--model", MODEL] },
			});
			expect(live.approvalMode).toBe(mode);
			const watch = watchFrames(ws, live.liveId);
			await rpc(ws, live.liveId, { type: "set_host_tools", tools: [proposeGoalTool()] });
			await rpc(ws, live.liveId, { type: "prompt", message: FORCED });

			const first = await watch.next(waitsOnUser);
			// Not `Allow tool: propose_goal`: that would be an approval select, and denying it breaks the interview.
			expect(first).toMatchObject({ type: "host_tool_call", toolName: "propose_goal" });

			// The user's decision reaches the model, which ends its turn with no approval asked on the way.
			const settled = watch.after("session_settled");
			ws.send(
				JSON.stringify({
					t: "ui_response",
					liveId: live.liveId,
					response: { id: first.id, ...hostResult("Reply with the single word ACK and nothing else.") },
				}),
			);
			await settled;
			expect(watch.seen.filter(waitsOnUser)).toHaveLength(1);
			await request(ws, { t: "close", liveId: live.liveId });
			ws.close();
		},
		120_000,
	);
}

// ------------------------------------------------------------------ the process's life

test("an interview whose omp process ended is still an interview when the conversation is opened again", async () => {
	const ws = await connect(s);
	const target = { kind: "resume", sessionFile: s.fixtures.alpha, model: MODEL };
	const first = await request<LiveInfo>(ws, { t: "open", target });
	await rpc(ws, first.liveId, { type: "set_host_tools", tools: [proposeGoalTool()] });
	expect(await toolNames(ws, first.liveId)).toContain("propose_goal");

	// The process goes away, as it does when it is idle and nobody watches.
	await request(ws, { t: "close", liveId: first.liveId });
	const second = await request<LiveInfo>(ws, { t: "open", target });
	expect(second.liveId).not.toBe(first.liveId);
	expect(await toolNames(ws, second.liveId)).toContain("propose_goal");

	// Taking the tool away ends it for good.
	await rpc(ws, second.liveId, { type: "set_host_tools", tools: [] });
	await request(ws, { t: "close", liveId: second.liveId });
	const third = await request<LiveInfo>(ws, { t: "open", target });
	expect(await toolNames(ws, third.liveId)).not.toContain("propose_goal");
	await request(ws, { t: "close", liveId: third.liveId });
	ws.close();
}, 120_000);
