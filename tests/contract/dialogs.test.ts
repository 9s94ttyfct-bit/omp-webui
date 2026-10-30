import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { type Frame, watchFrames } from "../support/frames.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * What omp does with the dialogs it waits on, against the real omp and the real server, the model a scripted provider (no
 * model call): an `ask` whose timeout (`ask.timeout`) runs out is answered by omp itself and the server says so in the
 * frame that closes it; a message sent while a tool approval waits is delivered once the approval is denied, and not before.
 */

const ASK_TIMEOUT_S = 2;

let server: TestServer;
let backend: StubScripted;

/** What the scripted model does for the prompt that has it: `ask` a question, or run a command (which asks approval). */
const ASK = "Ask me which colour";
const RUN = "Run echo hi";
const script = (req: { text: string; tools: string[]; toolResults: number }): ScriptedTurn => {
	if (!req.tools.includes("ask") || !req.tools.includes("bash")) return { text: "A title" };
	// The denied call has its result too: the message that follows it gets an answer, not the same call again.
	if (req.toolResults > 0) return { text: "Done." };
	if (req.text.includes(ASK))
		return {
			call: {
				name: "ask",
				args: {
					questions: [
						{
							id: "colour",
							question: "Which colour?",
							options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }],
							recommended: 1,
						},
					],
				},
			},
		};
	if (req.text.includes(RUN)) return { call: { name: "bash", args: { command: "echo hi" } } };
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
			"ask:",
			`  timeout: ${ASK_TIMEOUT_S}`,
			"",
		].join("\n"),
	);
	writeFileSync(join(server.work, "hello.txt"), "hello from the folder\n");
}, 120_000);

afterAll(async () => {
	await server?.stop();
	await backend?.stop();
});

const isRequest = (f: Frame, method: string) => f.type === "extension_ui_request" && f.method === method;
const isCancel = (f: Frame, target: unknown) =>
	f.type === "extension_ui_request" && f.method === "cancel" && f.targetId === target;

test("an ask that omp times out carries its deadline, and the frame that closes it says it timed out", async () => {
	const ws = await connect(server);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	const frames = watchFrames(ws, live.liveId);
	const asked = frames.after("extension_ui_request");
	const before = Date.now();
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: ASK } });
	const ask = await asked;
	expect(ask.method).toBe("ask");
	// omp's own deadline, and the server's reading of it on its clock: what a page counts down to, also after a reload.
	expect(ask.timeout).toBe(ASK_TIMEOUT_S * 1000);
	expect(typeof ask.expiresAt).toBe("number");
	expect(Math.abs((ask.expiresAt as number) - (before + ASK_TIMEOUT_S * 1000))).toBeLessThan(1500);

	// A tab that attaches while it waits is given the same deadline, not a fresh one.
	const late = await connect(server);
	const lateFrames = watchFrames(late, live.liveId);
	await request(late, { t: "attach", liveId: live.liveId });
	const replayed = await lateFrames.next((f) => isRequest(f, "ask"));
	expect(replayed.expiresAt).toBe(ask.expiresAt);

	// Nobody answers: omp does, and tells the tabs which dialog it closed and why.
	const closed = await frames.next((f) => isCancel(f, ask.id));
	expect(closed.timedOut).toBe(true);
	await frames.next((f) => f.type === "agent_end");
	// What omp chose for the user went to the model.
	expect(backend.requests.at(-1)?.text).toMatch(/Blue/);

	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
	late.close();
}, 120_000);

test("an ask answered in time is closed without the timeout mark", async () => {
	const ws = await connect(server);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	const frames = watchFrames(ws, live.liveId);
	const asked = frames.after("extension_ui_request");
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: ASK } });
	const ask = await asked;
	ws.send(
		JSON.stringify({
			t: "ui_response",
			liveId: live.liveId,
			response: { id: ask.id, answers: [{ id: "colour", selectedOptions: ["Red"] }] },
		}),
	);
	const closed = await frames.next((f) => isCancel(f, ask.id));
	expect(closed.timedOut).toBeUndefined();
	await frames.next((f) => f.type === "agent_end");
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 120_000);

test("a message sent while a tool approval waits is queued behind it until the approval is denied, then delivered", async () => {
	const ws = await connect(server);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: server.work, approvalMode: "always-ask" },
	});
	const frames = watchFrames(ws, live.liveId);
	const asked = frames.next((f) => isRequest(f, "select"));
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: RUN } });
	const approval = await asked;
	expect(String(approval.title)).toMatch(/^Allow tool: bash\b/);
	const options = approval.options as string[];
	const deny = options.find((o) => /^Deny/i.test(o));
	expect(deny).toBeDefined();

	const STEER = "Never mind, use the other file";
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "steer", message: STEER } });
	// Waiting behind the approval: queued, not delivered (omp sends no cancel for it either). A real wait: the claim is
	// that nothing happens in the real omp process, so there is no event to await and no clock to fake.
	await Bun.sleep(1500);
	const state = await request<{ queuedMessages?: { steering: string[] } }>(ws, {
		t: "rpc",
		liveId: live.liveId,
		command: { type: "get_state" },
	});
	expect(state.queuedMessages?.steering).toEqual([STEER]);
	expect(backend.requests.some((r) => r.text.includes(STEER))).toBe(false);

	// Denied first, as the terminal does: the model hears the message right after the denial.
	ws.send(JSON.stringify({ t: "ui_response", liveId: live.liveId, response: { id: approval.id, value: deny } }));
	await frames.next((f) => f.type === "agent_end");
	expect(backend.requests.some((r) => r.text.includes(STEER))).toBe(true);
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 120_000);

test("omp answers a message sent while an approval waits, so the denial can follow it", async () => {
	const ws = await connect(server);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: server.work, approvalMode: "always-ask" },
	});
	const frames = watchFrames(ws, live.liveId);
	const asked = frames.next((f) => isRequest(f, "select"));
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: RUN } });
	const approval = await asked;

	// The message is taken in while the approval waits: the request is answered at once, so the page can deny the
	// approval right after it, and the message is delivered.
	const STEER = "Never mind, use the other file";
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "steer", message: STEER } });
	const state = await request<{ queuedMessages?: { steering: string[] } }>(ws, {
		t: "rpc",
		liveId: live.liveId,
		command: { type: "get_state" },
	});
	expect(state.queuedMessages?.steering).toEqual([STEER]);

	// Denying it after the message delivers the message.
	const options = approval.options as string[];
	const deny = options.find((o) => /^Deny/i.test(o));
	ws.send(JSON.stringify({ t: "ui_response", liveId: live.liveId, response: { id: approval.id, value: deny } }));
	await frames.next((f) => f.type === "agent_end");
	expect(backend.requests.some((r) => r.text.includes(STEER))).toBe(true);
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 120_000);
