import "../unit/browser-globals.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Goal, goalHeld } from "../../shared/goal.ts";

import type { LiveAttached, SessionEntry } from "../../shared/protocol.ts";
import { attentionChanges } from "../../web/src/lib/attention.ts";
import { createGoal, type GoalWait, goalOp, goalWait } from "../../web/src/lib/goal.ts";
import { savedGoal } from "../../web/src/lib/saved-goal.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { attachLive, openLive, refreshState, setPaused, useApp } from "../../web/src/store/app.ts";
import type { LiveState } from "../../web/src/store/live.ts";
import { type PageStore, pageStore, viewLive } from "../support/page-store.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";
import { installGlobals, restoreGlobals } from "../unit/browser-globals.ts";

/**
 * Goal mode against the real omp and the page's own store: what the store holds of the goal, and when it says a run is
 * finished, against what omp says (`goal get`) and does. No model call: a scripted provider plays the model (it makes
 * the main agent run a tool, complete the goal or just answer), and the real server relays everything, so these pin
 * the frames and answers of the omp that is installed, as the page folds them.
 */

let server: TestServer;
let backend: StubScripted;
let ws: WebSocket;
let page: PageStore;

/** What the model does for its n-th request of the test (requests of the main agent, not titles). */
let plan: (n: number) => ScriptedTurn = () => ({ text: "Done." });
let modelRequests = 0;

const bash = (n: number): ScriptedTurn => ({ call: { name: "bash", args: { command: `echo step-${n}`, timeout: 5 } } });
/** What omp's prompt to a subagent says of itself (and the main agent's does not). */
const SUBAGENT_PROMPT = "You are operating on a piece of work assigned to you by the main agent";

beforeAll(async () => {
	installGlobals();
	// No titles: they are a model request of their own.

	backend = await startScriptedStub((req) => {
		// Titles and other helper requests offer no `read` tool.
		if (!req.tools.includes("read")) return { text: "A title" };
		// A subagent (its prompt says so) answers at once; only the main agent follows the test's plan.
		if (req.text.includes(SUBAGENT_PROMPT)) return { text: "ECHO-DONE" };
		return plan(++modelRequests);
	});
	server = await startTestServer(0, {}, { login: false });
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
	ws = await connect(server);
	page = pageStore(ws);
}, 120_000);

afterAll(async () => {
	page?.stop();
	ws?.close();
	await server?.stop();
	await backend?.stop();
	restoreGlobals();
});

let liveId = "";
let stopWatching = () => {};

interface Conversation {
	live(): LiveState;
	rpc<T = Record<string, unknown>>(command: Record<string, unknown>): Promise<T>;
	/** How many runs the page was told finished. */
	finished(): number;
	/** What the goal bar would say of the goal's activity over time (`goalWait`), each value once while it lasts. */
	waits(): (GoalWait | null)[];
	/** omp's own goal, as `goal get` answers it. */
	goal(): Promise<Goal | null>;
	/** The goal omp holds as the page shows it: a goal that ended is none. */
	shown(): Goal | null;
	/** The records of the conversation's saved file. */
	records(): SessionEntry[];
	/** Until omp has said the session is done (`session_settled`): a goal run's end, one frame after its last turn. */
	settled(): Promise<void>;
}

/** A conversation the page has open, the way it opens one (`openLive`). */
async function conversation(): Promise<Conversation> {
	modelRequests = 0;
	liveId = await openLive({ kind: "new", cwd: server.work });
	const file = useApp.getState().lives[liveId]?.info.sessionFile ?? null;
	viewLive(liveId, file);
	let finished = 0;
	const stopFinished = useApp.subscribe((state, prev) => {
		finished += attentionChanges(prev.lives, state.lives).finished.length;
	});
	const waits: (GoalWait | null)[] = [];
	const stopWaits = useApp.subscribe((state) => {
		const wait = goalWait(state.lives[liveId]);
		if (waits.at(-1) !== wait) waits.push(wait);
	});
	// Counted from omp's own frame, after the page's listener has folded it into the store.
	let settledFrames = 0;
	const onFrame = (ev: MessageEvent) => {
		const m = JSON.parse(String(ev.data)) as { t?: string; liveId?: string; frame?: { type?: string } };
		if (m.t === "frame" && m.liveId === liveId && m.frame?.type === "session_settled") settledFrames++;
	};
	ws.addEventListener("message", onFrame);
	stopWatching = () => {
		stopFinished();
		stopWaits();
		ws.removeEventListener("message", onFrame);
	};
	return {
		live: () => {
			const live = useApp.getState().lives[liveId];
			if (!live) throw new Error("the page holds no such conversation");
			return live;
		},
		rpc: <T = Record<string, unknown>>(command: Record<string, unknown>) =>
			request<T>(ws, { t: "rpc", liveId, command }),
		finished: () => finished,
		waits: () => waits,
		goal: async () =>
			(await request<{ goal: Goal | null }>(ws, { t: "rpc", liveId, command: { type: "goal", op: "get" } })).goal,
		shown: () => {
			const g = useApp.getState().lives[liveId]?.goal;
			return goalHeld(g) ? g : null;
		},
		records: (): SessionEntry[] =>
			readFileSync(String(useApp.getState().lives[liveId]?.info.sessionFile), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as SessionEntry)
				.filter((r) => typeof r.id === "string"),
		settled: () => pollUntil(() => settledFrames > 0, "omp to settle", 30_000),
	};
}

afterEach(async () => {
	stopWatching();
	const pid = useApp.getState().lives[liveId]?.info.pid;
	if (liveId) await request(ws, { t: "close", liveId }).catch(() => {});
	liveId = "";
	// Close leaves a working omp to finish its turn, and a goal's turn goes on to the next: its requests would be counted as
	// the next test's (`modelRequests`), whose plan then starts at its second step. It is ended here, and is gone before the
	// next test starts counting.
	if (typeof pid === "number" && processExists(pid)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone in between
		}
		await pollUntil(() => !processExists(pid), "the closed conversation's omp to end");
	}
});

test("a goal whose budget is spent: omp keeps it (and refuses another), and the page keeps showing it", async () => {
	plan = () => ({ text: "Wrapping up." });
	const c = await conversation();
	await createGoal(liveId, "Say hello", 5);
	await c.settled();

	// omp's own answer: the goal is there, spent, and goal mode is on: nothing else can be created beside it.
	const omp = await c.goal();
	expect(omp).toMatchObject({ status: "budget-limited", tokenBudget: 5 });
	expect(omp?.tokensUsed).toBeGreaterThan(5);
	await expect(c.rpc({ type: "goal", op: "create", objective: "Another" })).rejects.toThrow(/already active/);
	// `resume` accepts only a paused goal: here it answers success and changes nothing, with no frame to say so.
	expect((await c.rpc<{ goal: Goal }>({ type: "goal", op: "resume" })).goal.status).toBe("budget-limited");

	// The page holds that very goal, and treats it as one omp holds (the bar, the refusal of a second one).
	expect(c.live().goal).toEqual(omp);
	expect(c.shown()).toEqual(omp);

	// omp journals it, and what the transcript leaves is the spent goal (what a reopened conversation shows).
	await pollUntil(
		() => savedGoal(c.records())?.status === "budget-limited",
		"the saved transcript to say the budget is spent",
	);
	expect(savedGoal(c.records())).toMatchObject({ objective: "Say hello", tokenBudget: 5 });

	// Pause is accepted (omp answers a paused goal), and Drop ends it for both.
	await socket.act(liveId, { type: "goal", op: "pause" });
	expect(c.shown()?.status).toBe("paused");
	expect(c.shown()).toEqual(await c.goal());
	await socket.act(liveId, { type: "goal", op: "drop" });
	expect(await c.goal()).toBeNull();
	expect(c.shown()).toBeNull();
}, 90_000);

test("the Goal control's adjustments reach omp: pause, resume and drop change what `goal get` answers, and nothing else does", async () => {
	plan = () => ({ text: "Looking at it." });
	const c = await conversation();
	await createGoal(liveId, "Tidy the release notes", 1_000_000);
	await c.settled();
	const created = await c.goal();
	expect(created).toMatchObject({ objective: "Tidy the release notes", status: "active", tokenBudget: 1_000_000 });

	// The panel shows what the page holds; it is what omp holds.
	expect(c.shown()).toEqual(created);

	// Pause: omp holds a paused goal with the same objective and budget, and the page shows it.
	await goalOp(liveId, "pause");
	expect(await c.goal()).toMatchObject({
		id: created?.id,
		objective: created?.objective,
		status: "paused",
		tokenBudget: 1_000_000,
	});
	expect(c.shown()).toEqual(await c.goal());

	// Resume: active again, and omp starts working on it (a request of the model); wait for that turn to end.
	const requests = modelRequests;
	await goalOp(liveId, "resume");
	expect(await c.goal()).toMatchObject({ id: created?.id, status: "active" });
	await pollUntil(() => modelRequests > requests && goalWait(c.live()) === "idle", "the resumed goal to run and wait");
	expect(c.shown()).toEqual(await c.goal());

	// There is no op for the objective or the budget: the panel does not offer them, and omp would refuse them.
	await expect(c.rpc({ type: "goal", op: "update", objective: "Something else" })).rejects.toThrow(/Unknown goal op/);
	await expect(c.rpc({ type: "goal", op: "set_budget", token_budget: 5 })).rejects.toThrow(/Unknown goal op/);
	expect(await c.goal()).toMatchObject({ objective: "Tidy the release notes", tokenBudget: 1_000_000 });

	// Drop ends it for omp and for the page; resume then has nothing to act on and says so.
	await goalOp(liveId, "drop");
	expect(await c.goal()).toBeNull();
	expect(c.shown()).toBeNull();
	await expect(goalOp(liveId, "resume")).rejects.toThrow(/No paused goal to resume/);
}, 90_000);

test("a goal run of several turns is one finished run, told once, when omp completes it", async () => {
	// Two tool turns, then the model completes the goal with its tool.
	plan = (n) => {
		if (n === 1 || n === 3) return bash(n);
		if (n === 5) return { call: { name: "goal", args: { op: "complete" } } };
		return { text: `Step ${n} done.` };
	};
	const c = await conversation();
	await createGoal(liveId, "Do three things", undefined);
	await c.settled();

	// omp: three turns (`agent_start`/`agent_end` each) and the goal is over for it; the page agrees.
	expect(modelRequests).toBe(6);
	expect(await c.goal()).toBeNull();
	expect(c.shown()).toBeNull();
	expect(c.live().goal?.status).toBe("complete");
	expect(c.finished()).toBe(1);
	// Between two of its turns the goal is working, never waiting for the user.
	expect(c.waits().filter(Boolean)).toEqual([]);
}, 90_000);

test("a goal run asks omp for its state once per turn, not once per goal_updated frame", async () => {
	// Three goal turns (a tool turn, a tool turn, the turn that completes the goal), each with its token updates.
	plan = (n) => {
		if (n === 1 || n === 3) return bash(n);
		if (n === 5) return { call: { name: "goal", args: { op: "complete" } } };
		return { text: `Step ${n} done.` };
	};
	const c = await conversation();
	const counts = { ends: 0, goalFrames: 0 };
	const onFrame = (ev: MessageEvent) => {
		const m = JSON.parse(String(ev.data)) as { t?: string; liveId?: string; frame?: { type?: string } };
		if (m.t !== "frame" || m.liveId !== liveId) return;
		if (m.frame?.type === "agent_end") counts.ends++;
		if (m.frame?.type === "goal_updated") counts.goalFrames++;
	};
	ws.addEventListener("message", onFrame);
	const asked = () => page.sent.filter((m) => m.t === "rpc" && m.command.type === "get_state").length;
	try {
		const before = asked();
		await createGoal(liveId, "Do three things", undefined);
		await c.settled();
		// A read asked for now comes after every one the frames started: the page has nothing else in flight.
		await refreshState(liveId);
		// omp told the page of the goal's tokens in several frames per turn: those are not reasons to read the state.
		expect(counts.ends).toBe(3);
		expect(counts.goalFrames).toBeGreaterThan(counts.ends);
		// A read per turn's end, one for the run's end (`session_settled`), and the one just asked for.
		expect(asked() - before).toBeLessThanOrEqual(counts.ends + 2);
	} finally {
		ws.removeEventListener("message", onFrame);
	}
}, 90_000);

test("a goal omp stops continuing is one finished run, told when omp settles, and the goal is still active", async () => {
	// The model answers without using a tool: omp starts no more turns for the goal and waits for the user.
	plan = () => ({ text: "What do you want to do first?" });
	const c = await conversation();
	await createGoal(liveId, "Ask me one question, then wait", undefined);
	await c.settled();

	expect(modelRequests).toBe(1);
	expect(await c.goal()).toMatchObject({ status: "active" });
	expect(c.shown()).toEqual(await c.goal());
	expect(c.finished()).toBe(1);
	// omp stopped continuing: the page says so once omp has said it is settled, not before.
	expect(c.waits().filter(Boolean)).toEqual(["idle"]);
	expect(goalWait(c.live())).toBe("idle");

	// A page that opens it now (a reload) learns the same from omp's state: nothing runs, the goal is active.
	useApp.setState({ lives: {} });
	expect(await attachLive(liveId)).toBe(true);
	expect(c.live().goal?.status).toBe("active");
	expect(goalWait(c.live())).toBe("idle");
	expect(c.finished()).toBe(1);
}, 90_000);

/** The page showing the goal as paused, the way a saved transcript's reading of an active goal does. */
function showGoalPaused(): void {
	useApp.setState((s) => {
		const live = s.lives[liveId];
		if (!live?.goal) return s;
		return { lives: { ...s.lives, [liveId]: { ...live, goal: { ...live.goal, status: "paused" } } } };
	});
}

test("a page that opens a paused conversation shows the goal omp holds, not the one its transcript leaves", async () => {
	plan = () => ({ text: "What do you want to do first?" });
	const c = await conversation();
	await createGoal(liveId, "Ask me one question, then wait", undefined);
	await c.settled();
	expect(await c.goal()).toMatchObject({ status: "active" });
	// What the saved transcript leaves of an active goal is a paused one: omp reopens it that way after a restart.
	await pollUntil(() => savedGoal(c.records()) !== null, "the goal to be journaled");
	expect(savedGoal(c.records())?.status).toBe("paused");

	await setPaused(liveId, true);
	// A frozen omp refuses every read the page makes by itself.
	await expect(c.rpc({ type: "goal", op: "get" })).rejects.toThrow(/paused/);

	// A reload: the page attaches to the frozen process and shows the goal the server heard of, which is omp's.
	useApp.setState({ lives: {} });
	expect(await attachLive(liveId)).toBe(true);
	expect(c.live().info.pausedAt).not.toBeNull();
	expect(c.live().goal).toMatchObject({ status: "active", objective: "Ask me one question, then wait" });

	// Resuming reads the goal from omp again, whatever the page showed.
	showGoalPaused();
	await setPaused(liveId, false);
	await pollUntil(() => c.live().goal?.status === "active", "the page to read the goal again once omp runs");
	expect(c.live().goal).toEqual(await c.goal());
}, 90_000);

test("Resume goal on a goal that is already active corrects the bar from omp's answer, which comes with no frame", async () => {
	plan = () => ({ text: "What do you want to do first?" });
	const c = await conversation();
	await createGoal(liveId, "Ask me one question, then wait", undefined);
	await c.settled();
	const omp = await c.goal();
	expect(omp).toMatchObject({ status: "active" });

	// The page shows it as paused (a transcript's reading of it); omp holds it active, and `resume` changes nothing.
	showGoalPaused();
	await goalOp(liveId, "resume");
	expect(c.live().goal).toEqual(omp);
}, 90_000);

test("a reopened conversation's open reply carries the goal omp restored, which no frame announces", async () => {
	plan = () => ({ text: "What do you want to do first?" });
	const c = await conversation();
	await createGoal(liveId, "Ask me one question, then wait", undefined);
	await c.settled();
	await pollUntil(() => savedGoal(c.records()) !== null, "the goal to be journaled");
	const file = String(c.live().info.sessionFile);
	await request(ws, { t: "close", liveId });
	await pollUntil(() => c.live().info.exited, "omp to exit");

	// A new process on the file: omp restores the goal paused (it was active), and the server learns it from the state.
	const reopened = await request<LiveAttached>(ws, { t: "open", target: { kind: "resume", sessionFile: file } });
	try {
		const omp = (
			await request<{ goal: Goal | null }>(ws, {
				t: "rpc",
				liveId: reopened.liveId,
				command: { type: "goal", op: "get" },
			})
		).goal;
		expect(omp).toMatchObject({ status: "paused", objective: "Ask me one question, then wait" });
		expect(reopened.goal).toEqual(omp ?? undefined);
	} finally {
		await request(ws, { t: "close", liveId: reopened.liveId });
	}
}, 90_000);

test("a /new in the same process leaves the goal behind for the page too: it shows what omp now holds", async () => {
	plan = () => ({ text: "What do you want to do first?" });
	const c = await conversation();
	await createGoal(liveId, "Ask me one question, then wait", undefined);
	await c.settled();
	expect(c.shown()).toEqual(await c.goal());
	const before = c.live().info.sessionFile;

	await c.rpc({ type: "new_session" });
	await pollUntil(() => c.live().info.sessionFile !== before, "the page to hear of the new session file");

	// omp: the new session has no goal (the old one was paused in its own file); the page agrees, and shows no bar.
	expect(await c.goal()).toBeNull();
	await pollUntil(() => c.live().goal === null, "the page to drop the goal of the session it left");
	expect(c.shown()).toBeNull();
	expect(goalWait(c.live())).toBeNull();

	// And a goal set in the new session is the page's goal.
	await createGoal(liveId, "A second goal", undefined);
	await pollUntil(() => c.shown()?.objective === "A second goal", "the page to show the new goal");
	expect(c.shown()).toEqual(await c.goal());
}, 90_000);

test("a /new in the same process leaves the subagents behind for the page too", async () => {
	plan = (n) =>
		n === 1
			? {
					call: {
						name: "task",
						args: { context: "Shared background.", tasks: [{ name: "Echo", task: "Reply ECHO-DONE" }] },
					},
				}
			: { text: "The subagent reported." };
	const c = await conversation();
	await c.rpc({ type: "prompt", message: "Send a scout" });
	await c.settled();
	expect(Object.keys(c.live().subagents)).toEqual(["Echo"]);
	const before = c.live().info.sessionFile;

	await c.rpc({ type: "new_session" });
	await pollUntil(() => c.live().info.sessionFile !== before, "the page to hear of the new session file");

	const listed = await c.rpc<{ subagents?: unknown[] }>({ type: "get_subagents" });
	expect(Array.isArray(listed) ? listed : (listed.subagents ?? [])).toEqual([]);
	await pollUntil(
		() => Object.keys(c.live().subagents).length === 0,
		"the page to drop the subagents of the session it left",
	);
}, 90_000);
