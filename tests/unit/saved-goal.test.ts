import { expect, test } from "bun:test";
import type { SessionEntry } from "../../shared/protocol.ts";
import { savedGoal } from "../../web/src/lib/saved-goal.ts";

/** The goal a saved transcript leaves a conversation in: what the web UI shows before omp runs for it. */

let n = 0;
const entry = (fields: Record<string, unknown>): SessionEntry => ({
	id: `e${++n}`,
	parentId: null,
	timestamp: "2026-10-18T00:00:00.000Z",
	type: "message",
	...fields,
});
const goal = (status: string) => ({
	id: "g1",
	objective: "Ship it",
	status,
	tokenBudget: 50_000,
	tokensUsed: 1234,
	timeUsedSeconds: 60,
});
const mode = (m: string, status?: string) =>
	entry({ type: "mode_change", mode: m, ...(status ? { data: { goal: goal(status) } } : {}) });
const message = entry({ message: { role: "user", content: "hi" } });

test("a goal paused in the terminal is the conversation's goal, with its budget and use", () => {
	expect(savedGoal([message, mode("goal", "active"), mode("goal_paused", "paused"), message])).toEqual({
		id: "g1",
		objective: "Ship it",
		status: "paused",
		tokenBudget: 50_000,
		tokensUsed: 1234,
		timeUsedSeconds: 60,
		createdAt: undefined,
		updatedAt: undefined,
	});
});

test("a goal left active comes back paused: nothing works on it until it is resumed", () => {
	expect(savedGoal([message, mode("goal", "active")])?.status).toBe("paused");
});

test("a goal whose budget was spent is still the conversation's goal, and reads as spent: omp reopens it that way", () => {
	expect(savedGoal([message, mode("goal", "active"), mode("goal", "budget-limited"), message])).toEqual({
		id: "g1",
		objective: "Ship it",
		status: "budget-limited",
		tokenBudget: 50_000,
		tokensUsed: 1234,
		timeUsedSeconds: 60,
		createdAt: undefined,
		updatedAt: undefined,
	});
	// Pausing it afterwards (omp accepts that) is a paused goal again.
	expect(savedGoal([mode("goal", "budget-limited"), mode("goal_paused", "paused")])?.status).toBe("paused");
});

test("a goal that was dropped, completed or ended by a later mode change is no goal", () => {
	expect(savedGoal([mode("goal", "active"), mode("none")])).toBeNull();
	expect(savedGoal([mode("goal", "complete")])).toBeNull();
	expect(savedGoal([mode("goal", "dropped")])).toBeNull();
	expect(savedGoal([message])).toBeNull();
	expect(savedGoal([mode("goal")])).toBeNull();
});
