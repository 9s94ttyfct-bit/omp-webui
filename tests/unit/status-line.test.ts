import { describe, expect, test } from "bun:test";
import type { GoalStatus } from "../../shared/goal.ts";
import type { LiveInfo, SessionEntry } from "../../shared/protocol.ts";
import { statusItems } from "../../web/src/lib/status-line.ts";
import { activeMs } from "../../web/src/lib/turn-stats.ts";
import { initialLive, type LiveState } from "../../web/src/store/live.ts";
import type { TurnClock } from "../../web/src/store/turn-clock.ts";

/**
 * What the chat's status line says, from the live process and how long the saved entries say the agent has worked
 * (the TUI's bottom line: working time, the model and its thinking level, the goal, the context window). The running
 * agents and the cost come from the conversation's totals, not from here.
 */

const info: LiveInfo = {
	liveId: "L1",
	pid: 1,
	cwd: "/work",
	sessionFile: null,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};
const base = initialLive(info);
const live = (over: Partial<LiveState>): LiveState => ({ ...base, ...over });

const t0 = Date.UTC(2026, 0, 5, 10, 0, 0);
/** One earlier turn, 90 s long. */
const saved = activeMs([
	{
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: new Date(t0).toISOString(),
		message: { role: "user", content: "go", attribution: "user", timestamp: t0 },
	},
	{
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: new Date(t0 + 90_000).toISOString(),
		message: { role: "assistant", content: [] },
	},
] as SessionEntry[]);

describe("how long the agent has worked", () => {
	test("a conversation nobody is running says what its entries say", () => {
		expect(saved).toBe(90_000);
		expect(statusItems(undefined, saved, null, t0 + 1e9).activeMs).toBe(90_000);
		expect(statusItems(undefined, 0, null, t0).activeMs).toBe(0);
	});

	test("a turn running goes on from the clock the page took when it began", () => {
		const clock: TurnClock = { startedAt: 50_000, activeBefore: 90_000 };
		const running = live({ streaming: true });
		expect(statusItems(running, saved, clock, 50_000 + 12_000).activeMs).toBe(102_000);
		// A page that opened mid-turn has no clock: this browser's time says nothing about the saved timestamps (they are
		// the machine omp runs on's), so the turn counts up to its last saved entry, however late it is here.
		expect(statusItems(running, saved, null, t0 + 600_000).activeMs).toBe(90_000);
	});

	test("a clock left from an earlier turn is ignored once nothing is streaming", () => {
		const clock: TurnClock = { startedAt: 50_000, activeBefore: 90_000 };
		expect(statusItems(live({ streaming: false }), saved, clock, 99_999_999).activeMs).toBe(90_000);
	});
});

describe("the model", () => {
	const model = { id: "claude-opus-5-5", name: "Opus 5.5", provider: "anthropic" };
	const state = (extra: Record<string, unknown>) =>
		({
			isStreaming: false,
			isCompacting: false,
			steeringMode: "",
			followUpMode: "",
			interruptMode: "",
			messageCount: 0,
			queuedMessageCount: 0,
			...extra,
		}) as LiveState["state"];
	const items = (extra: Record<string, unknown>) => statusItems(live({ state: state(extra) }), 0, null, 0);

	test("is named as the model picker names it, with its thinking level", () => {
		expect(items({ model, thinkingLevel: "high" }).model).toEqual({ name: "Opus 5.5", thinking: "high" });
		const unnamed = { id: "gpt-x", provider: "openai" };
		expect(items({ model: unnamed }).model).toEqual({ name: "gpt-x" });
	});

	test("says nothing of thinking when it is off, and nothing of a model that is not known yet", () => {
		expect(items({ model, thinkingLevel: "off" }).model?.thinking).toBeUndefined();
		expect(items({}).model).toBeUndefined();
		expect(statusItems(live({ state: null }), 0, null, 0).model).toBeUndefined();
		expect(statusItems(undefined, 0, null, 0).model).toBeUndefined();
	});

	test("reports the context window once omp has measured it", () => {
		const contextUsage = { tokens: 390_000, contextWindow: 1_000_000, percent: 39 };
		expect(items({ contextUsage }).context).toEqual(contextUsage);
		expect(items({}).context).toBeUndefined();
	});
});

describe("the goal", () => {
	const goal = (status: GoalStatus, extra: Record<string, unknown> = {}) => ({
		id: "g",
		objective: "Ship it",
		status,
		...extra,
	});

	test("is shown while it is active, paused or out of budget, with what it has used of its budget", () => {
		const active = statusItems(
			live({ goal: goal("active", { tokenBudget: 1_500_000, tokensUsed: 420_000 }) }),
			0,
			null,
			0,
		);
		expect(active.goal).toEqual({ objective: "Ship it", used: 420_000, budget: 1_500_000, status: "active" });
		const paused = statusItems(live({ goal: goal("paused", { tokensUsed: 5 }) }), 0, null, 0);
		expect(paused.goal).toEqual({ objective: "Ship it", used: 5, budget: undefined, status: "paused" });
		// omp keeps goal mode on once the budget is spent (the goal is still its goal): the line must not drop it.
		const spent = statusItems(
			live({ goal: goal("budget-limited", { tokenBudget: 100, tokensUsed: 1640 }) }),
			0,
			null,
			0,
		);
		expect(spent.goal).toEqual({ objective: "Ship it", used: 1640, budget: 100, status: "budget-limited" });
	});

	test("is not shown once it is over, or when there is none", () => {
		for (const status of ["complete", "dropped"] as const) {
			expect(statusItems(live({ goal: goal(status) }), 0, null, 0).goal).toBeUndefined();
		}
		expect(statusItems(live({ goal: null }), 0, null, 0).goal).toBeUndefined();
	});
});
