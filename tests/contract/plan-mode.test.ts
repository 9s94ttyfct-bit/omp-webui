import "../unit/browser-globals.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionEntry } from "../../shared/protocol.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { openLive, useApp } from "../../web/src/store/app.ts";
import type { RpcState } from "../../web/src/store/live.ts";
import { type PageStore, pageStore, viewLive } from "../support/page-store.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";
import { installGlobals, restoreGlobals } from "../unit/browser-globals.ts";

/**
 * Read-only plan mode (`--plan-yolo`) against the real omp and the page's own store. omp 18.12 tells an RPC client nothing
 * of plan mode: `get_state` has no field for it, no command enters or leaves it, and `/plan` is not in its catalog. The page
 * infers it (`LiveState.planMode`): on from the start for a process started with the flag, off once omp writes its hidden
 * `plan-yolo-handoff` entry because the plan was approved. These tests pin what that inference rests on; when one fails
 * after an omp update, omp has started to say it itself and the page should read that instead. No model call: a scripted
 * provider plays the model (it writes the plan and proposes it).
 */

let server: TestServer;
let backend: StubScripted;
let ws: WebSocket;
let page: PageStore;

let plan: (n: number) => ScriptedTurn = () => ({ text: "Done." });
let modelRequests = 0;
/** What the page held of plan mode when each model request of the run came in. */
let planAtRequest: (boolean | undefined)[] = [];
/** Whether each model request of the run carried omp's plan mode context ("Plan mode active"): what omp itself is told. */
let ompPlanAtRequest: boolean[] = [];
/** The `notice` frames omp sent, as `source: message`. */
let notices: string[] = [];
let liveId = "";

const planMode = () => useApp.getState().lives[liveId]?.planMode;
const rpc = <T>(command: Record<string, unknown>) => request<T>(ws, { t: "rpc", liveId, command });
const records = (): SessionEntry[] =>
	readFileSync(String(useApp.getState().lives[liveId]?.info.sessionFile), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as SessionEntry);
const hidden = (type: string) => (e: SessionEntry) => e.type === "custom_message" && e.customType === type;

/** The model writes its plan, then proposes it: the call that plan-yolo approves. */
const planAndPropose = (n: number): ScriptedTurn =>
	n === 1
		? { call: { name: "write", args: { path: "local://probe-plan.md", content: "# Plan\n1. Say hello\n" } } }
		: n === 2
			? { call: { name: "write", args: { path: "xd://propose", content: "probe" } } }
			: { text: "Implemented." };

async function start(args: string[]): Promise<void> {
	modelRequests = 0;
	planAtRequest = [];
	ompPlanAtRequest = [];
	notices = [];
	liveId = await openLive({ kind: "new", cwd: server.work, args });
	viewLive(liveId, useApp.getState().lives[liveId]?.info.sessionFile ?? null);
}

beforeAll(async () => {
	installGlobals();

	backend = await startScriptedStub((req) => {
		if (!req.tools.includes("read")) return { text: "A title" };
		planAtRequest.push(planMode());
		ompPlanAtRequest.push(req.text.includes("Plan mode active"));
		return plan(++modelRequests);
	});
	server = await startTestServer(0, {}, { login: false });
	// Listed models, not discovered ones: plan-yolo resolves its target model while omp starts, before discovery has run.
	writeFileSync(
		join(server.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    models:\n      - id: stub-model\n`,
	);
	writeFileSync(
		join(server.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit", "plan"].map((r) => `  ${r}: omlx/stub-model`),
			"",
		].join("\n"),
	);
	ws = await connect(server);
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(String(ev.data)) as {
			t?: string;
			frame?: { type?: string; source?: string; message?: string };
		};
		if (m.t === "frame" && m.frame?.type === "notice") notices.push(`${m.frame.source}: ${m.frame.message}`);
	});
	page = pageStore(ws);
}, 120_000);

afterAll(async () => {
	page?.stop();
	ws?.close();
	await server?.stop();
	await backend?.stop();
	restoreGlobals();
});

afterEach(async () => {
	if (liveId) await request(ws, { t: "close", liveId }).catch(() => {});
	liveId = "";
});

test("a --plan-yolo conversation is in plan mode until omp's handoff entry, which comes once the plan is approved", async () => {
	plan = planAndPropose;
	await start(["--plan-yolo"]);

	// Before any message: the page knows from the flag, omp says nothing, and no command could change it.
	expect(planMode()).toBe(true);
	const state = await rpc<RpcState & Record<string, unknown>>({ type: "get_state" });
	expect(Object.keys(state).filter((k) => /plan/i.test(k))).toEqual([]);
	const { commands } = await rpc<{ commands: { name: string; aliases?: string[] }[] }>({
		type: "get_available_commands",
	});
	expect(commands.flatMap((c) => [c.name, ...(c.aliases ?? [])])).not.toContain("plan");
	await expect(rpc({ type: "set_plan_mode", enabled: false })).rejects.toThrow(/Unknown command/);

	await socket.rpc(liveId, { type: "prompt", message: "Plan a greeting" });
	await pollUntil(() => planMode() === false, "the page to see the plan approved", 30_000);

	// The two model requests that come before the approval were made in plan mode, as far as the page knew.
	expect(planAtRequest.slice(0, 2)).toEqual([true, true]);
	// What it read it from: the hidden entry that carries the plan mode in, then the one that ends it, nothing else.
	const saved = records();
	const entered = saved.findIndex(hidden("plan-mode-context"));
	const handoff = saved.findIndex(hidden("plan-yolo-handoff"));
	const firstMessage = saved.findIndex((e) => e.type === "message");
	expect(entered).toBeGreaterThanOrEqual(0);
	expect(entered).toBeLessThan(firstMessage);
	expect(handoff).toBeGreaterThan(entered);
	expect(saved.filter((e) => e.type === "mode_change")).toEqual([]);
	// omp's own words for it, which the page shows as a toast.
	expect(notices.some((n) => n.startsWith("plan-yolo: Plan-yolo: plan approved"))).toBe(true);
	// The work that follows is not plan mode again.
	await pollUntil(() => modelRequests >= 3, "the implementation turn", 30_000);
	expect(planMode()).toBe(false);
}, 90_000);

test("a conversation resumed from a plan-mode transcript is not in plan mode: omp does not restore it over RPC", async () => {
	// The model writes a plan and never proposes it: the transcript ends inside plan mode.
	plan = (n) => (n === 1 ? planAndPropose(1) : { text: "Still thinking about it." });
	await start(["--plan-yolo"]);
	await socket.rpc(liveId, { type: "prompt", message: "Plan a greeting" });
	await pollUntil(
		() => modelRequests >= 2 && useApp.getState().lives[liveId]?.streaming === false,
		"the plan turn to end",
		30_000,
	);
	const file = String(useApp.getState().lives[liveId]?.info.sessionFile);
	expect(planMode()).toBe(true);
	expect(records().some(hidden("plan-yolo-handoff"))).toBe(false);
	await request(ws, { t: "close", liveId });

	// Resumed the way the page does it, without the flag.
	plan = () => ({ text: "Hello." });
	modelRequests = 0;
	liveId = await openLive({ kind: "resume", sessionFile: file });
	expect(useApp.getState().lives[liveId]?.planMode).toBe(false);
	const before = records().filter(hidden("plan-mode-context")).length;
	await socket.rpc(liveId, { type: "prompt", message: "Now say hello" });
	await pollUntil(
		() => modelRequests >= 1 && useApp.getState().lives[liveId]?.streaming === false,
		"the turn to end",
		30_000,
	);
	// omp enters plan mode by injecting its context: it did not do it again.
	expect(records().filter(hidden("plan-mode-context")).length).toBe(before);
}, 90_000);

/** omp's `/new` as the page sends it; resolves once the page has been told the process moved to the new session file. */
async function newSession(): Promise<void> {
	const before = useApp.getState().lives[liveId]?.info.sessionFile;
	await socket.act(liveId, { type: "new_session" });
	await pollUntil(
		() => useApp.getState().lives[liveId]?.info.sessionFile !== before,
		"the page to follow omp to the new session",
		30_000,
	);
}

const turnEnded = (requests: number) => () =>
	modelRequests >= requests && useApp.getState().lives[liveId]?.streaming === false;

test("/new before the plan is approved: omp is still in plan mode in the new session, and the page keeps showing it", async () => {
	plan = (n) => (n === 1 ? planAndPropose(1) : { text: "Still thinking about it." });
	await start(["--plan-yolo"]);
	await socket.rpc(liveId, { type: "prompt", message: "Plan a greeting" });
	await pollUntil(turnEnded(2), "the plan turn to end", 30_000);
	// Every request so far was made in plan mode (omp may add a reminder request of its own to the two).
	const inFirst = modelRequests;
	expect(ompPlanAtRequest.every(Boolean)).toBe(true);
	expect(planMode()).toBe(true);

	await newSession();
	expect(records().some(hidden("plan-yolo-handoff"))).toBe(false);
	await socket.rpc(liveId, { type: "prompt", message: "A fresh start" });
	await pollUntil(turnEnded(inFirst + 1), "the turn in the new session to end", 30_000);
	// omp's first request of the new session again says plan mode, and the page agrees.
	expect(ompPlanAtRequest[inFirst]).toBe(true);
	expect(planAtRequest[inFirst]).toBe(true);
	expect(planMode()).toBe(true);
	expect(records().some(hidden("plan-mode-context"))).toBe(true);
}, 90_000);

test("/new after the plan is approved: omp is out of plan mode in the new session, and so is the page", async () => {
	plan = planAndPropose;
	await start(["--plan-yolo"]);
	await socket.rpc(liveId, { type: "prompt", message: "Plan a greeting" });
	await pollUntil(() => planMode() === false && turnEnded(3)(), "the plan to be approved and implemented", 30_000);
	const inFirst = modelRequests;

	await newSession();
	await socket.rpc(liveId, { type: "prompt", message: "A fresh start" });
	await pollUntil(turnEnded(inFirst + 1), "the turn in the new session to end", 30_000);
	expect(ompPlanAtRequest[inFirst]).toBe(false);
	expect(planMode()).toBe(false);
	expect(records().some(hidden("plan-mode-context"))).toBe(false);
}, 90_000);
