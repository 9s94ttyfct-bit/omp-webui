import type { TodoTask } from "../store/live.ts";
import type { TodoPhase } from "./todos.ts";

/**
 * Editing omp's todo list. The edits are pure functions of the list omp reported (`todoPhases` of `get_state`); the
 * result is written as omp's Markdown checklist (what `/todo edit` shows and `/todo import` reads), and omp is the
 * one that parses it, applies its one-task-in-progress rule and records the edit. What the page shows afterwards is
 * what omp then reports, not what was sent.
 */

export const TODO_STATUSES = ["pending", "in_progress", "completed", "blocked", "abandoned"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** The marker omp writes for each state in `- [ ] task`. */
const MARKERS: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	blocked: "!",
	abandoned: "-",
};

export const isTodoStatus = (status: string): status is TodoStatus => Object.hasOwn(MARKERS, status);

/** Text as omp's Markdown can hold it: one line, and none of the comment delimiters a blocker's reason rides in. */
export function oneLine(text: string): string {
	return text
		.replace(/<!--|-->/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** omp's Markdown for `phases`; an empty list is no text at all (omp's own `# Todos` would make a phase of it). */
export function todosToMarkdown(phases: TodoPhase[]): string {
	if (phases.length === 0) return "";
	const out: string[] = [];
	phases.forEach((phase, i) => {
		if (i > 0) out.push("");
		out.push(`# ${oneLine(phase.name) || "Todos"}`);
		for (const task of phase.tasks) {
			const status: TodoStatus = isTodoStatus(task.status) ? task.status : "pending";
			// A blocked task's reason rides in a trailing comment, invisible in rendered Markdown (omp parses it back).
			const reason = status === "blocked" && task.blocker ? oneLine(task.blocker) : "";
			out.push(`- [${MARKERS[status]}] ${oneLine(task.content)}${reason ? ` <!-- blocker: ${reason} -->` : ""}`);
		}
	});
	return `${out.join("\n")}\n`;
}

const copy = (phases: TodoPhase[]): TodoPhase[] =>
	phases.map((p) => ({ name: p.name, tasks: p.tasks.map((t) => ({ ...t })) }));

/** Whether the list still has `content` at that place: an edit made on a list that has since moved on is not applied. */
export function taskIs(phases: TodoPhase[], p: number, t: number, content: string): boolean {
	return phases[p]?.tasks[t]?.content === content;
}

export function phaseIs(phases: TodoPhase[], p: number, name: string): boolean {
	return phases[p]?.name === name;
}

/** A copy of the list with the task at `p`/`t` changed by `change`. */
function withTask(phases: TodoPhase[], p: number, t: number, change: (task: TodoTask) => void): TodoPhase[] {
	const next = copy(phases);
	const task = next[p]?.tasks[t];
	if (!task) throw new Error("No such task");
	change(task);
	return next;
}

export function setStatus(phases: TodoPhase[], p: number, t: number, status: TodoStatus, reason = ""): TodoPhase[] {
	return withTask(phases, p, t, (task) => {
		task.status = status;
		const blocker = oneLine(reason);
		if (status === "blocked" && blocker) task.blocker = blocker;
		else delete task.blocker;
	});
}

export function setContent(phases: TodoPhase[], p: number, t: number, content: string): TodoPhase[] {
	const text = oneLine(content);
	if (!text) throw new Error("A task needs some text");
	return withTask(phases, p, t, (task) => {
		task.content = text;
	});
}

/** The task goes at the end of phase `p`; with no phase yet it starts omp's own default one, `Todos`. */
export function addTask(phases: TodoPhase[], p: number, content: string): TodoPhase[] {
	const text = oneLine(content);
	if (!text) throw new Error("A task needs some text");
	const next = copy(phases);
	if (next.length === 0) next.push({ name: "Todos", tasks: [] });
	const phase = next[p] ?? next[next.length - 1];
	phase.tasks.push({ content: text, status: "pending" });
	return next;
}

export function addPhase(phases: TodoPhase[], name: string): TodoPhase[] {
	const text = oneLine(name);
	if (!text) throw new Error("A phase needs a name");
	return [...copy(phases), { name: text, tasks: [] }];
}

export function renamePhase(phases: TodoPhase[], p: number, name: string): TodoPhase[] {
	const text = oneLine(name);
	if (!text) throw new Error("A phase needs a name");
	const next = copy(phases);
	if (!next[p]) throw new Error("No such phase");
	next[p].name = text;
	return next;
}

export function removeTask(phases: TodoPhase[], p: number, t: number): TodoPhase[] {
	const next = copy(phases);
	if (!next[p]?.tasks[t]) throw new Error("No such task");
	next[p].tasks.splice(t, 1);
	return next;
}

export function removePhase(phases: TodoPhase[], p: number): TodoPhase[] {
	const next = copy(phases);
	if (!next[p]) throw new Error("No such phase");
	next.splice(p, 1);
	return next;
}

/** Swap with the neighbour `by` places away (-1 up, 1 down) in the same phase; the first and last stay put. */
export function moveTask(phases: TodoPhase[], p: number, t: number, by: -1 | 1): TodoPhase[] {
	const next = copy(phases);
	const tasks = next[p]?.tasks;
	if (!tasks?.[t]) throw new Error("No such task");
	const to = t + by;
	if (to < 0 || to >= tasks.length) return next;
	[tasks[t], tasks[to]] = [tasks[to], tasks[t]];
	return next;
}

export function movePhase(phases: TodoPhase[], p: number, by: -1 | 1): TodoPhase[] {
	const next = copy(phases);
	if (!next[p]) throw new Error("No such phase");
	const to = p + by;
	if (to < 0 || to >= next.length) return next;
	[next[p], next[to]] = [next[to], next[p]];
	return next;
}

/** What a click on a task's state icon does: finish it, or take it up again when it is over. */
export function toggledStatus(status: string): TodoStatus {
	return status === "completed" || status === "abandoned" ? "pending" : "completed";
}
