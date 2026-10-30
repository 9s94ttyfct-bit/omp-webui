import { isRecord } from "@shared/guards.ts";
import type { SessionEntry } from "@shared/protocol.ts";
import type { AgentRow } from "./subagents.ts";

/**
 * What a subagent was told, in omp's own words. omp hands a subagent two texts: its task, as the first user message
 * (`Complete assignment thoroughly:` and the task), and the context its parent gave every subagent of the call, in the
 * `§ Context` section that omp's subagent template appends to the system prompt. Both are recorded at the head of the
 * subagent's transcript, in its `session_init` record, so a subagent that is over, or from an earlier run, still has
 * them. The task call's own arguments carry the same two texts (`context`, and `task` of each item), so the call's card
 * has them before the subagent exists. The progress frames of a running omp carry the task alone.
 */

export interface Assignment {
	task: string;
	/** What the parent gave every subagent of its call; absent when it gave none or the text is not to be found. */
	context?: string;
}

/** One subagent a `task` call starts. */
export interface TaskItem {
	/** Its id when the call's result has it (omp numbers a name that was taken), else the name the call gave. */
	name?: string;
	agent?: string;
	assignment: Assignment;
}

/** The line omp's user prompt puts before the task (`subagent-user-prompt.md`). */
const PROMPT_LEAD = "Complete assignment thoroughly:\n\n";

/** The task a subagent's first user message carries; a message without omp's lead line is the task as it stands. */
export function taskOfPrompt(prompt: string): string {
	return prompt.startsWith(PROMPT_LEAD) ? prompt.slice(PROMPT_LEAD.length) : prompt;
}

/**
 * The sections of omp's subagent template that bound the context (`subagent-system-prompt.md`): `§ Context`, then the
 * plan the subagent executes (only for one that does, and it always begins with this sentence), then `§ Coop`. The
 * context is text of the parent's own and may contain a line that looks like a section, so it ends at the last `§ Coop`
 * (nothing after the context contains one) or at the plan that precedes it.
 */
const CONTEXT_HEAD = "\n§ Context\n";
const PLAN_HEAD = "\n§ Plan\nThis session is executing an approved plan";
const COOP_HEAD = "\n§ Coop\n";

function contextIn(block: string): string | undefined {
	const coop = block.lastIndexOf(COOP_HEAD);
	const head = block.indexOf(CONTEXT_HEAD);
	if (coop < 0 || head < 0 || head > coop) return undefined;
	const plan = block.lastIndexOf(PLAN_HEAD, coop);
	return block.slice(head + CONTEXT_HEAD.length, plan > head ? plan : coop).trimEnd();
}

/** The shared context of a subagent's system prompt (the blocks omp sent, or one string in files from before blocks were kept). */
export function contextOfSystemPrompt(systemPrompt: unknown): string | undefined {
	const blocks = typeof systemPrompt === "string" ? [systemPrompt] : Array.isArray(systemPrompt) ? systemPrompt : [];
	// The subagent's own block is appended last: look from the end.
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		const context = typeof block === "string" ? contextIn(block) : undefined;
		if (context) return context;
	}
	return undefined;
}

/**
 * The assignment its transcript opens with: the first `session_init`, the one it was spawned with (a revived subagent
 * writes another after its conversation). omp writes it before the first message, so a message ends the search.
 */
export function assignmentOfInit(entries: readonly SessionEntry[]): Assignment | undefined {
	for (const e of entries) {
		if (e.type === "message") return undefined;
		if (e.type !== "session_init") continue;
		if (typeof e.task !== "string") return undefined;
		const task = taskOfPrompt(e.task);
		return task.trim() ? { task, context: contextOfSystemPrompt(e.systemPrompt) } : undefined;
	}
	return undefined;
}

/** The text of a field with its edges trimmed, or undefined when it is not a string or has nothing but space (omp trims what it sends). */
const trimmed = (v: unknown): string | undefined => (typeof v === "string" ? v.trim() || undefined : undefined);

/**
 * What the Agents tab shows of a subagent's assignment: its transcript's record once that is read (task and context),
 * until then what the progress frames of a running omp say (the task alone; the frames carry no context).
 */
export function assignmentOfRow(row: AgentRow, initial: Assignment | undefined): Assignment | undefined {
	if (initial) return initial;
	const live = row.live;
	const task =
		trimmed(live?.progress?.assignment) ?? trimmed(live?.assignment) ?? trimmed(live?.task && taskOfPrompt(live.task));
	return task ? { task } : undefined;
}

/** The ids omp gave the subagents of a call, by the index of their item, from the call's result (`progress` while it runs, `results` once it ended). */
function idsOf(details: unknown): Map<number, string> {
	const ids = new Map<number, string>();
	if (!isRecord(details)) return ids;
	for (const list of [details.results, details.progress]) {
		if (!Array.isArray(list)) continue;
		list.forEach((e: unknown, position) => {
			if (isRecord(e) && typeof e.id === "string" && e.id)
				ids.set(typeof e.index === "number" ? e.index : position, e.id);
		});
	}
	return ids;
}

/**
 * The subagents a `task` call starts, each with its own task and the call's shared context: the items of `tasks`, or the
 * one spawn the call itself describes. `details` is the call's result, when there is one, for the ids of subagents the
 * call did not name. Reads what has arrived of a call that is still being written, and `id` and `assignment` where there is no `name`
 * or `task` (the fields this UI read before it read omp's).
 */
export function taskItemsOf(args: unknown, details?: unknown): TaskItem[] {
	if (!isRecord(args)) return [];
	const context = trimmed(args.context);
	const ids = idsOf(details);
	const item = (raw: unknown, index: number): TaskItem[] => {
		if (!isRecord(raw)) return [];
		const task = trimmed(raw.task) ?? trimmed(raw.assignment) ?? "";
		const given = trimmed(raw.name) ?? trimmed(raw.id);
		if (!task && !given) return [];
		return [{ name: ids.get(index) ?? given, agent: trimmed(raw.agent), assignment: { task, context } }];
	};
	return Array.isArray(args.tasks) ? args.tasks.flatMap(item) : item(args, 0);
}
