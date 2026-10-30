import { type Goal, goalHeld } from "@shared/goal.ts";
import type { SessionEntry } from "@shared/protocol.ts";
import { Fold } from "./lineage.ts";

/**
 * The goal a conversation's saved transcript leaves it in, as omp would reopen it — so a goal set in the terminal
 * shows before any omp runs here. omp records goal mode as `mode_change` entries (`goal`, `goal_paused`, `none`,
 * with the goal in `data.goal`); the last one on the path counts. A goal that was active comes back paused: nothing
 * works on it until it is resumed (omp reopens it that way too). One whose budget was spent comes back as it was.
 */
export function savedGoal(path: readonly SessionEntry[]): Goal | null {
	const last = lastMode.run(path as SessionEntry[]).entry;
	if (!last) return null;
	// The same goal while the last mode change is the same one: what shows it is not drawn again for each new entry.
	if (!goals.has(last)) goals.set(last, goalOf(last));
	return goals.get(last) ?? null;
}

const goals = new WeakMap<SessionEntry, Goal | null>();

/** The last entry that changed the mode: the only one that says what the goal is. Found going on from where the last call stopped. */
const lastMode = new Fold<SessionEntry, { entry: SessionEntry | null }>(
	() => ({ entry: null }),
	(state, path, from) => {
		let entry = state.entry;
		for (let i = from; i < path.length; i++) if (path[i].type === "mode_change") entry = path[i];
		return entry === state.entry ? state : { entry };
	},
);

/** What a `mode_change` entry leaves of the goal. */
function goalOf(e: SessionEntry): Goal | null {
	if (e.mode !== "goal" && e.mode !== "goal_paused") return null;
	const data = e.data;
	const goal = data && typeof data === "object" && "goal" in data ? data.goal : undefined;
	if (!goal || typeof goal !== "object" || !("id" in goal) || !("objective" in goal)) return null;
	if (typeof goal.id !== "string" || typeof goal.objective !== "string") return null;
	const status = "status" in goal ? goal.status : undefined;
	if (!goalHeld({ status })) return null;
	const fields = new Map(Object.entries(goal));
	const n = (key: string) => {
		const v = fields.get(key);
		return typeof v === "number" ? v : undefined;
	};
	return {
		id: goal.id,
		objective: goal.objective,
		status: status === "budget-limited" ? "budget-limited" : "paused",
		tokenBudget: n("tokenBudget"),
		tokensUsed: n("tokensUsed"),
		timeUsedSeconds: n("timeUsedSeconds"),
		createdAt: n("createdAt"),
		updatedAt: n("updatedAt"),
	};
}
