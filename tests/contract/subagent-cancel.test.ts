import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Stopping one subagent of a running omp (`cancel_subagent`, which omp's rpc-ui documents as "hard-kill one running
 * subagent; false when it is not running"): the others of the same task call go on and finish, and omp says the
 * stopped one is over. A scripted provider makes the main agent start two subagents (omp runs them as background
 * jobs: the turn that started them ends at once) and holds both of their replies, so both are running when one is
 * stopped.
 */

const NESTED = "You are operating on a piece of work assigned to you by the main agent";

let server: TestServer;
let backend: StubScripted;
/** Opened by the test once one subagent is stopped: the other one's reply is held until then. */
const finish = Promise.withResolvers<void>();

const script = async (req: { text: string; tools: string[]; toolResults: number }): Promise<ScriptedTurn> => {
	if (req.text.includes(NESTED)) {
		// Neither subagent answers on its own: `Drop` is never answered (it is stopped), `Keep` when the test says so.
		if (req.text.includes("KEEP-TASK")) {
			await finish.promise;
			return { text: "KEEP-DONE" };
		}
		await new Promise<void>(() => {});
	}
	if (!req.tools.includes("task")) return { text: "A title" };
	if (req.toolResults === 0) {
		return {
			call: {
				name: "task",
				args: {
					context: "Two scouts.",
					tasks: [
						{ name: "Keep", task: "KEEP-TASK: say KEEP-DONE." },
						{ name: "Drop", task: "DROP-TASK: say DROP-DONE." },
					],
				},
			},
		};
	}
	return { text: "Both scouts reported." };
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
	finish.resolve();
	await server?.stop();
	await backend?.stop();
});

const subagentIds = async (ws: WebSocket, liveId: string): Promise<string[]> => {
	const data = await request<unknown>(ws, { t: "rpc", liveId, command: { type: "get_subagents" } });
	const list = isRecord(data) && Array.isArray(data.subagents) ? data.subagents : [];
	return list.flatMap((s) => (isRecord(s) && typeof s.id === "string" ? [s.id] : [])).sort();
};

test("omp stops one running subagent and only that one: the other finishes, a second stop says it was not running", async () => {
	const ws = await connect(server);
	const info = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	const frames = watchFrames(ws, info.liveId);
	const turnEnded = frames.next((f) => f.type === "agent_end");
	const lastStatus = (id: string) =>
		frames.seen
			.flatMap((f) =>
				f.type === "subagent_lifecycle" && isRecord(f.payload) && f.payload.id === id ? [f.payload.status] : [],
			)
			.at(-1);
	await request(ws, { t: "rpc", liveId: info.liveId, command: { type: "prompt", message: "Send two scouts" } });
	try {
		// The turn that started them is over; both subagents run on: omp lists them, and both have asked the model.
		await turnEnded;
		await pollUntil(
			async () => (await subagentIds(ws, info.liveId)).join() === "Drop,Keep",
			"both subagents to be listed as running",
		);
		await pollUntil(
			() => backend.requests.filter((r) => r.text.includes(NESTED)).length === 2,
			"both subagents to ask the model",
		);

		const stopped = await request<unknown>(ws, {
			t: "rpc",
			liveId: info.liveId,
			command: { type: "cancel_subagent", subagentId: "Drop" },
			user: true,
		});
		expect(stopped).toEqual({ cancelled: true });

		// omp no longer lists it; the other one still runs.
		await pollUntil(
			async () => (await subagentIds(ws, info.liveId)).join() === "Keep",
			"only the other subagent to be listed as running",
		);
		expect(lastStatus("Keep")).toBe("started");
		const again = await request<unknown>(ws, {
			t: "rpc",
			liveId: info.liveId,
			command: { type: "cancel_subagent", subagentId: "Drop" },
			user: true,
		});
		expect(again).toEqual({ cancelled: false });

		// The other subagent is let answer, and finishes.
		finish.resolve();
		await frames.next(
			(f) =>
				f.type === "subagent_lifecycle" &&
				isRecord(f.payload) &&
				f.payload.id === "Keep" &&
				f.payload.status === "completed",
		);
		expect(lastStatus("Drop")).toBe("aborted");
		expect(await subagentIds(ws, info.liveId)).toEqual([]);
	} finally {
		finish.resolve();
		void request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
		ws.close();
	}
}, 120_000);
