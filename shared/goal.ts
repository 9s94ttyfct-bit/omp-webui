/**
 * omp goal mode as the RPC `goal` and the `goal_updated` frame report it (omp 18.12: `goal` ops answer
 * `{ goal, state }`; every change, the agent's own `goal` tool included, is a `goal_updated` frame).
 */

import { isRecord } from "./guards.ts";

/**
 * `active`: omp works on it (or waits for the user, see `GoalBar`). `paused`: held until `resume`. `budget-limited`: the
 * token budget is spent; omp tells the model to wrap up and goal mode stays on, so the goal still exists (it cannot be
 * resumed, and `create` is refused until it is dropped). `complete` and `dropped` are only ever seen in the frame that
 * ends a goal: afterwards omp answers `goal: null`.
 */
export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed?: number;
	timeUsedSeconds?: number;
	createdAt?: number;
	updatedAt?: number;
}

/** The statuses of a goal omp still holds: with one of them omp refuses a new goal (`A goal is already active`). */
export type HeldStatus = Exclude<GoalStatus, "complete" | "dropped">;

const HELD: readonly string[] = ["active", "paused", "budget-limited"];

/** Whether omp still holds this goal: it shows, it can be dropped, and no other can be set beside it. */
export function goalHeld<G extends { status?: unknown }>(
	goal: G | null | undefined,
): goal is G & { status: HeldStatus } {
	return typeof goal?.status === "string" && HELD.includes(goal.status);
}

const optionalNumber = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/**
 * The goal in what omp (or a record the server wrote) says of one: the goal when it is one omp still holds, else null
 * (none, one that ended, something else). `get_state` reports goal mode as `{ enabled, mode, goal }`, not the goal.
 */
export function heldGoal(value: unknown): Goal | null {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.objective !== "string") return null;
	const held = { status: value.status };
	if (!goalHeld(held)) return null;
	return {
		id: value.id,
		objective: value.objective,
		status: held.status,
		tokenBudget: optionalNumber(value.tokenBudget),
		tokensUsed: optionalNumber(value.tokensUsed),
		timeUsedSeconds: optionalNumber(value.timeUsedSeconds),
		createdAt: optionalNumber(value.createdAt),
		updatedAt: optionalNumber(value.updatedAt),
	};
}
