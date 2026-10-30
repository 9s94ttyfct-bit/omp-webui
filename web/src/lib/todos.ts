import type { TodoTask } from "../store/live.ts";

/** omp's todo list (`todoPhases` of `get_state`), summed up the way the TUI's TODO panel does. */

export interface TodoPhase {
	name: string;
	tasks: TodoTask[];
}

export interface TodoSummary {
	/** Phases with at least one task (the TUI skips an empty one). */
	phases: { name: string; tasks: TodoTask[]; done: number }[];
	total: number;
	/** Completed and abandoned: nothing more to do about them. */
	done: number;
	blocked: number;
	/** The task being worked on: the first one in progress, else the first pending, as the TUI picks it. */
	current: { phase: string; task: TodoTask } | null;
	/** The first blocked task, for a list that has nothing in progress or pending. */
	firstBlocked: { phase: string; task: TodoTask } | null;
}

export const isDone = (task: TodoTask): boolean => task.status === "completed" || task.status === "abandoned";

/** Keys for rows that may repeat (two tasks of one wording, two phases of one name): the text and which time it appears. */
export function withKeys<T>(items: T[], textOf: (item: T) => string): { key: string; item: T }[] {
	const seen = new Map<string, number>();
	return items.map((item) => {
		const text = textOf(item);
		const n = seen.get(text) ?? 0;
		seen.set(text, n + 1);
		return { key: `${text}\u0000${n}`, item };
	});
}
export function summarizeTodos(phases: TodoPhase[] | undefined): TodoSummary {
	const kept = (phases ?? []).filter((p) => p.tasks.length > 0);
	let current: TodoSummary["current"] = null;
	let pending: TodoSummary["current"] = null;
	let firstBlocked: TodoSummary["firstBlocked"] = null;
	let blocked = 0;
	for (const p of kept) {
		for (const task of p.tasks) {
			if (task.status === "in_progress") current ??= { phase: p.name, task };
			else if (task.status === "pending") pending ??= { phase: p.name, task };
			else if (task.status === "blocked") {
				blocked++;
				firstBlocked ??= { phase: p.name, task };
			}
		}
	}
	const summary = kept.map((p) => ({ ...p, done: p.tasks.filter(isDone).length }));
	return {
		phases: summary,
		total: summary.reduce((n, p) => n + p.tasks.length, 0),
		done: summary.reduce((n, p) => n + p.done, 0),
		blocked,
		current: current ?? pending,
		firstBlocked,
	};
}
