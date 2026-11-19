import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { watchFrames } from "../support/frames.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * New chat with omp's `autoResume` on (#383), against the real omp and the real server: a plain omp resumes the folder's
 * newest conversation, so the web UI's New chat would be that conversation (or, while it is open, a copy of it that sends
 * its whole history to the model). The server's omp processes are started with `autoResume` off.
 */

let server: TestServer;
let backend: StubScripted;

const script = (): ScriptedTurn => ({ text: "Ok." });

beforeAll(async () => {
	backend = await startScriptedStub(script);
	server = await startTestServer();
	writeFileSync(
		join(server.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    models:\n      - id: stub-model\n`,
	);
	writeFileSync(
		join(server.agentDir, "config.yml"),
		[
			"autoResume: true",
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

test("New chat is a new conversation, not the folder's newest one, with omp's autoResume on", async () => {
	const ws = await connect(server);
	const first = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	const frames = watchFrames(ws, first.liveId);
	await request(ws, { t: "rpc", liveId: first.liveId, command: { type: "prompt", message: "Hello" } });
	await frames.next((f) => f.type === "agent_end");
	const state = await request<{ sessionFile?: string }>(ws, {
		t: "rpc",
		liveId: first.liveId,
		command: { type: "get_state" },
	});
	expect(state.sessionFile).toBeTruthy();

	const second = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	expect(second.liveId).not.toBe(first.liveId);
	const next = await request<{ sessionFile?: string; messageCount?: number }>(ws, {
		t: "rpc",
		liveId: second.liveId,
		command: { type: "get_state" },
	});
	expect(next.sessionFile).not.toBe(state.sessionFile);
	expect(next.messageCount ?? 0).toBe(0);
	ws.close();
}, 90_000);
