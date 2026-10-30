import { afterAll, beforeAll, expect, test } from "bun:test";
import type { LiveInfo } from "../../shared/protocol.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A slim state read, against the real omp and the real server: the answer the page asks for in its routine reads
 * carries neither the system prompt nor the bodies of the tool schemas, and it is much smaller than the whole one
 * (#467). A read that does not ask for it still carries them, so that a consumer that reads a tool's schema (the
 * guided goal's own tests) is served as before.
 */

let s: TestServer;
let ws: WebSocket;
let live: LiveInfo;

const MODEL = "anthropic/claude-haiku-5-5";

interface RpcState {
	systemPrompt?: unknown;
	dumpTools?: { name: string; description?: string; parameters?: unknown }[];
	[key: string]: unknown;
}

/** The answer to a `get_state`; `slim` asks for the answer without what the page does not read. */
const state = (slim = false): Promise<RpcState> =>
	request<RpcState>(ws, {
		t: "rpc",
		liveId: live.liveId,
		command: { type: "get_state" },
		...(slim ? { slim: true } : {}),
	});

beforeAll(async () => {
	s = await startTestServer();
	ws = await connect(s);
	live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: s.work, args: ["--model", MODEL] },
	});
}, 90_000);

afterAll(async () => {
	ws?.close();
	await s?.stop();
});

test("a slim state read carries no system prompt and the tool names alone", async () => {
	const slim = await state(true);
	expect(slim.systemPrompt).toBeUndefined();
	expect(Array.isArray(slim.dumpTools)).toBe(true);
	for (const tool of slim.dumpTools ?? []) {
		expect(Object.keys(tool)).toEqual(["name"]);
	}
	// The rest of the state is there: what the page reads of it.
	expect(slim.messageCount).toBeGreaterThanOrEqual(0);
	expect(typeof slim.isStreaming).toBe("boolean");
}, 60_000);

test("the whole answer is still there for a read that does not ask for a slim one", async () => {
	const whole = await state();
	// omp names the tools the model is offered, with their schemas.
	expect(Array.isArray(whole.dumpTools)).toBe(true);
	expect((whole.dumpTools ?? []).length).toBeGreaterThan(0);
	expect((whole.dumpTools ?? []).every((t) => typeof t.name === "string")).toBe(true);
	// A tool's schema is what a consumer that reads the tools needs: it is in the whole answer.
	expect((whole.dumpTools ?? []).some((t) => t.parameters !== undefined)).toBe(true);
}, 60_000);

test("a slim read is much smaller than the whole one: the prompt and the schemas are what it leaves out", async () => {
	const slim = await state(true);
	const whole = await state();
	const bytes = (s: RpcState) => new TextEncoder().encode(JSON.stringify(s)).length;
	expect(bytes(slim)).toBeLessThan(bytes(whole));
}, 60_000);
