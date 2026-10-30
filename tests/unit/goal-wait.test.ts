import "./browser-globals.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { GoalStatus } from "../../shared/goal.ts";
import type { LiveInfo, OmpFrame } from "../../shared/protocol.ts";
import { goalWait } from "../../web/src/lib/goal.ts";
import { applyFrame, initialLive, type LiveState, type RpcState } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * "Working on goal" must be true: an active goal omp has stopped continuing (after a turn with nothing new done, or
 * while every open todo is blocked) reads as waiting for the user, once omp says it is settled.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info: LiveInfo = {
	liveId: "L1",
	pid: 1,
	cwd: "/",
	sessionFile: "/sessions/a.jsonl",
	sessionId: "a",
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};

const goal = (status: GoalStatus) => ({ id: "g", objective: "Ship it", status });
const live = (extra: Partial<LiveState> = {}): LiveState => ({ ...initialLive(info), goal: goal("active"), ...extra });
const todos = (...statuses: string[]): Pick<RpcState, "todoPhases"> => ({
	todoPhases: [{ name: "Build", tasks: statuses.map((status, i) => ({ content: `task ${i}`, status })) }],
});
const state = (extra: Partial<RpcState> = {}): RpcState =>
	({ messageCount: 2, queuedMessageCount: 0, ...extra }) as RpcState;
const fold = (s: LiveState, ...frames: OmpFrame[]) => frames.reduce(applyFrame, s);

test("an active goal that omp has settled on waits for the user", () => {
	expect(goalWait(live({ settled: true }))).toBe("idle");
});

test("nothing is said while a turn runs, is about to start, or omp has not said it is settled", () => {
	expect(goalWait(live({ settled: true, streaming: true }))).toBeNull();
	// Between two turns of a goal run.
	expect(goalWait(live({ settled: true, continuing: true }))).toBeNull();
	expect(goalWait(live({ settled: false }))).toBeNull();
});

test("only an active goal waits: a paused one, a spent one and none at all do not", () => {
	for (const status of ["paused", "budget-limited", "complete", "dropped"] as const) {
		expect(goalWait(live({ settled: true, goal: goal(status) })), status).toBeNull();
	}
	expect(goalWait(live({ settled: true, goal: null }))).toBeNull();
	expect(goalWait(undefined)).toBeNull();
});

test("when every open todo is blocked omp stops continuing, and the wait says so", () => {
	const wait = (...statuses: string[]) => goalWait(live({ settled: true, state: state(todos(...statuses)) }));
	expect(wait("blocked")).toBe("blocked");
	// Finished tasks are not open ones.
	expect(wait("completed", "abandoned", "blocked", "blocked")).toBe("blocked");
	// A task that can still be worked on keeps omp going: a wait then is the plain one.
	expect(wait("blocked", "pending")).toBe("idle");
	expect(wait("blocked", "in_progress")).toBe("idle");
	expect(wait("completed")).toBe("idle");
});

test("a goal that has just become active is not yet waiting: omp starts its turn a moment later", () => {
	// An idle conversation (omp said it is settled) gets a goal: the frame comes before the turn's `agent_start`.
	const idle = live({ settled: true, goal: null });
	const created = fold(idle, { type: "goal_updated", goal: goal("active") });
	expect(goalWait(created)).toBeNull();
	// The turn runs and omp ends it without continuing: now it waits.
	const ended = fold(
		created,
		{ type: "agent_start" },
		{ type: "agent_end", isTerminal: true },
		{ type: "session_settled" },
	);
	expect(goalWait(ended)).toBe("idle");
	// Resuming a paused goal is the same.
	const resumed = fold({ ...ended, goal: goal("paused") }, { type: "goal_updated", goal: goal("active") });
	expect(goalWait(resumed)).toBeNull();
	// A token count of a goal that was active already changes nothing.
	expect(goalWait(fold(ended, { type: "goal_updated", goal: goal("active") }))).toBe("idle");
});
