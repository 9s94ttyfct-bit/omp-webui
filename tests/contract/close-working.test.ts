import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { watchFrames } from "../support/frames.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * What Close (Settings › Running conversations, "Quit and end") does to a conversation that works, against the real omp
 * and the real server, the model a scripted provider (#388): it closes omp's stdin, and the omp of today does not finish
 * its turn first, as the docs once said: it aborts the turn (the running tool is stopped) and exits within seconds. The
 * page asks before it closes a conversation that works, for that reason.
 */

const LONG = "Run the long command";

let server: TestServer;
let backend: StubScripted;

const script = (req: { text: string; tools: string[]; toolResults: number }): ScriptedTurn => {
	if (!req.tools.includes("bash")) return { text: "A title" };
	if (req.toolResults > 0) return { text: "Done." };
	if (req.text.includes(LONG)) return { call: { name: "bash", args: { command: "sleep 30; echo slept" } } };
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

test("Close on a conversation whose tool runs ends omp within seconds: the turn is cut, not finished", async () => {
	const ws = await connect(server);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	const frames = watchFrames(ws, live.liveId);
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: LONG } });
	await frames.next((f) => f.type === "tool_execution_start");
	const closed = Date.now();
	await request(ws, { t: "close", liveId: live.liveId });
	await pollUntil(() => !processExists(live.pid as number), "omp to end after Close", 10_000);
	// The tool's 30 s were not waited out: omp stopped it and ended.
	expect(Date.now() - closed).toBeLessThan(10_000);
	const end = frames.seen.find((f) => f.type === "tool_execution_end");
	expect(JSON.stringify(end ?? {})).not.toContain("slept");
	ws.close();
}, 60_000);
