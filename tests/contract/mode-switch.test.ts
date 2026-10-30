import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { CORE_TOOLS } from "../../shared/offline.ts";
import type { LiveInfo, LiveListing, ModeSwitchReply } from "../../shared/protocol.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import {
	type ScriptedRequest,
	type ScriptedTurn,
	type StubScripted,
	startScriptedStub,
} from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * This session's Full / Light switch (`set_mode`) against the real server and the real omp, with a scripted model that
 * answers from the stub (no real model): an idle conversation is restarted in the other mode at once and resumed from its
 * own session file; one that works waits for the turn to end, says so (`LiveInfo.modeSwitch`) and can be taken back; Light
 * runs on the person's own models (the stub is a provider of their models.yml) with only the allowed tools.
 */

let s: TestServer;
let agent: StubScripted;

/** The model's answers wait for `hold` while it is set, and `began` says when one has arrived. */
let hold: Promise<void> | null = null;
let began = Promise.withResolvers<void>();
const script = async (req: ScriptedRequest): Promise<ScriptedTurn> => {
	// The conversation's own requests offer tools; the title omp asks for does not.
	if (req.tools.length === 0) return { text: "A title" };
	began.resolve();
	if (hold) await hold;
	return { text: "Main answer." };
};

beforeAll(async () => {
	agent = await startScriptedStub(script);
	s = await startTestServer(0, {}, { login: false });
	writeFileSync(
		join(s.agentDir, "models.yml"),
		`providers:\n  cb:\n    baseUrl: ${agent.url}\n    api: openai-completions\n    apiKey: ${agent.apiKey}\n    models:\n      - id: stub-model\n`,
	);
	writeFileSync(
		join(s.agentDir, "config.yml"),
		["modelRoles:", ...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: cb/stub-model`), ""].join(
			"\n",
		),
	);
}, 120_000);

afterAll(async () => {
	await s?.stop();
	await agent?.stop();
});

/** Polls the real server for what a real omp process makes of the request (no event says when it is done; the deadline is the bound). */
async function until<T>(what: string, look: () => Promise<T | false | undefined>, ms = 90_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const found = await look();
		if (found) return found;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

/** A conversation of this test's page: its socket, its process, and what it asks the server. */
async function conversation() {
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: s.work, mode: "full", approvalMode: "yolo", args: ["--model", "cb/stub-model"] },
	});
	const lives = () => request<LiveListing[]>(ws, { t: "list_lives" });
	/** The processes that run this conversation's session file now. */
	const running = async (file: string) => (await lives()).filter((l) => !l.exited && l.sessionFile === file);
	const prompt = (liveId: string, message: string) =>
		request(ws, { t: "rpc", liveId, command: { type: "prompt", message } });
	/**
	 * The conversation is idle as a switch sees it: omp says nothing runs or is left to wake it (its `get_state` is answered
	 * after every frame of the turn, which the server has then read), and the server holds nothing for it. A listing that is
	 * not streaming may be from before the turn's start reached the server, and a turn that has ended may still have omp's
	 * own work after it: on a loaded machine a switch asked for then waits ("pending"), which is the next test's case.
	 */
	const idle = async (liveId: string) => {
		const reply = await request<unknown>(ws, { t: "rpc", liveId, command: { type: "get_state" } });
		const state = isRecord(reply) && isRecord(reply.data) ? reply.data : reply;
		if (!isRecord(state) || state.isStreaming !== false || state.isSettled !== true) return false;
		const info = (await lives()).find((l) => l.liveId === liveId);
		return info !== undefined && !info.busy && !info.continuing ? info : false;
	};
	/** Send `message` and wait for the turn it starts to end (the model has been asked for it, and has answered). */
	const turn = async (liveId: string, message: string) => {
		await prompt(liveId, message);
		await until("the model to be asked", async () =>
			agent.requests.some((r) => r.tools.length > 0 && r.text.includes(message)),
		);
		return until("the turn to end and the conversation to be idle", () => idle(liveId));
	};
	return { ws, live, lives, running, prompt, turn };
}

/** The tools the model was offered in its newest request of the conversation. */
const offered = () => agent.requests.filter((r) => r.tools.length > 0).at(-1)?.tools ?? [];

test("an idle conversation is restarted in the other mode at once and resumed from its own session file", async () => {
	hold = null;
	const c = await conversation();
	try {
		expect(c.live).toMatchObject({ mode: "full" });
		const idle = await c.turn(c.live.liveId, "FIRST-PROBE in Full");
		const file = idle.sessionFile as string;
		expect(file).toBeTruthy();
		// Full has every tool of omp's; Light has the allowlist.
		expect(offered()).toContain("task");

		const reply = await request<ModeSwitchReply>(c.ws, { t: "set_mode", liveId: c.live.liveId, mode: "light" });
		expect(reply.state).toBe("switched");
		const now = await until("the conversation to run in Light", async () => {
			const [only] = await c.running(file);
			return only?.mode === "light" ? only : false;
		});
		expect(now).toMatchObject({ mode: "light", lightModels: "yours", sessionFile: file });
		expect(reply).toEqual({ state: "switched", liveId: now.liveId });
		expect(now.liveId).not.toBe(c.live.liveId);
		// The old process is gone, and says it was the switch that ended it.
		const old = (await c.lives()).find((l) => l.liveId === c.live.liveId);
		expect(old === undefined || old.exited).toBe(true);
		if (old?.exit) expect(old.exit.reason).toBe("modeSwitch");

		// The conversation goes on where it stopped, on the person's own model, with the allowlist of tools.
		await c.turn(now.liveId, "SECOND-PROBE in Light");
		expect(offered().sort()).toEqual([...CORE_TOOLS].sort());
		const last = agent.requests.filter((r) => r.tools.length > 0).at(-1) as ScriptedRequest;
		expect(last.text).toContain("FIRST-PROBE in Full");
		expect(last.text).toContain("SECOND-PROBE in Light");

		// The mode it has is the mode it asks for: nothing to do.
		expect(await request<ModeSwitchReply>(c.ws, { t: "set_mode", liveId: now.liveId, mode: "light" })).toEqual({
			state: "unchanged",
		});
		// And back to Full, as often as wanted.
		const back = await request<ModeSwitchReply>(c.ws, { t: "set_mode", liveId: now.liveId, mode: "full" });
		expect(back.state).toBe("switched");
		const full = await until("the conversation to run in Full again", async () => {
			const [only] = await c.running(file);
			return only?.mode === "full" ? only : false;
		});
		expect(full.sessionFile).toBe(file);
		expect(full.lightModels).toBeUndefined();
	} finally {
		c.ws.close();
	}
}, 240_000);

test("a conversation that works waits for the turn to end, says so, and switches then", async () => {
	hold = null;
	const c = await conversation();
	try {
		const idle = await c.turn(c.live.liveId, "WARM-UP probe");
		const file = idle.sessionFile as string;

		// The second turn is under way, and the model does not answer yet.
		const release = Promise.withResolvers<void>();
		hold = release.promise;
		began = Promise.withResolvers<void>();
		await c.prompt(c.live.liveId, "LONG-TURN probe");
		await began.promise;

		const reply = await request<ModeSwitchReply>(c.ws, { t: "set_mode", liveId: c.live.liveId, mode: "light" });
		expect(reply).toEqual({ state: "pending", mode: "light" });
		// Every page is told: the process is the same, still working, with the switch it is waiting to make.
		const waiting = (await c.lives()).find((l) => l.liveId === c.live.liveId) as LiveInfo;
		expect(waiting).toMatchObject({ mode: "full", streaming: true, modeSwitch: { to: "light" } });
		expect(waiting.exited).toBe(false);

		// Asking for the mode it has takes the switch back.
		expect(await request<ModeSwitchReply>(c.ws, { t: "set_mode", liveId: c.live.liveId, mode: "full" })).toEqual({
			state: "unchanged",
		});
		expect(((await c.lives()).find((l) => l.liveId === c.live.liveId) as LiveInfo).modeSwitch).toBeUndefined();
		expect(await request<ModeSwitchReply>(c.ws, { t: "set_mode", liveId: c.live.liveId, mode: "light" })).toEqual({
			state: "pending",
			mode: "light",
		});

		// The turn ends, and the switch is made: the same session file is run by a Light process, whose model has seen the turn.
		release.resolve();
		const now = await until("the conversation to run in Light", async () => {
			const [only] = await c.running(file);
			return only?.mode === "light" ? only : false;
		});
		expect(now.liveId).not.toBe(c.live.liveId);
		expect(now.modeSwitch).toBeUndefined();
		await c.turn(now.liveId, "AFTER-SWITCH probe");
		const last = agent.requests.filter((r) => r.tools.length > 0).at(-1) as ScriptedRequest;
		expect(last.text).toContain("LONG-TURN probe");
		expect(last.text).toContain("Main answer.");
		expect(last.text).toContain("AFTER-SWITCH probe");
	} finally {
		hold = null;
		c.ws.close();
	}
}, 240_000);
