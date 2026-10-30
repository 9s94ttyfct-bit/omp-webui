import { finite } from "@shared/guards.ts";
import type { SessionEntry, SubagentFile } from "@shared/protocol.ts";
import { isOverStatus, isWorkingStatus } from "@shared/subagent-status.ts";
import type { SubagentState } from "../store/live.ts";
import { type ContextUsage, progressContext } from "./context-usage.ts";
import { blocks, messageOf } from "./messages.ts";
import { taskItemsOf } from "./subagent-assignment.ts";
import type { UsageParts } from "./totals.ts";

/**
 * One list of subagents for every place that shows them (the Agents tab, the jobs block under the transcript, the
 * task cards, the totals): the transcripts on disk and the frames of a running omp merged by id, with the ones
 * still running first.
 */

/**
 * What this page calls a subagent it saw running that omp stopped listing, whose end it missed: over, how unknown (it
 * may have completed, failed or been cancelled). Not one of omp's words.
 */
export const ENDED = "ended";

/** omp's words for a subagent that is over (and `ENDED`); anything else (started, running, pending…) is still going. */
export function isOver(status: string): boolean {
	return status === ENDED || isOverStatus(status);
}

export function isRunning(status: string): boolean {
	return !isOver(status);
}

/** The subagent is doing something now (not over, not waiting between runs): what Stop ends. */
export function isWorking(status: string): boolean {
	return status !== ENDED && isWorkingStatus(status);
}

export interface AgentRow {
	/** omp's id; a nested subagent's starts with its parent's: `Features.QuotaPill`. */
	id: string;
	/** The last part of the id: the name the agent was given. */
	name: string;
	/** 0 for the conversation's own subagents, one more per level of nesting. */
	depth: number;
	agent?: string;
	status: string;
	running: boolean;
	/** Its transcript, as omp or the server names it. */
	file?: string;
	live?: SubagentState;
	stat?: SubagentFile;
	/** On this browser's clock for a live subagent; the transcript's header for one only known from disk. */
	startedAt?: number;
	finishedAt?: number;
}

function row(id: string, from: Partial<AgentRow> & { status: string }): AgentRow {
	const parts = id.split(".");
	return { ...from, id, name: parts[parts.length - 1], depth: parts.length - 1, running: isRunning(from.status) };
}

/**
 * Every subagent a conversation has: its transcripts (all finished, as far as the disk can tell) overlaid with
 * what the live process says, running ones first with the newest start at the top. The rest keep the order they
 * always had: transcripts by modification time, then subagents only the process knows.
 */
export function agentRows(
	files: SubagentFile[] | undefined,
	live: Record<string, SubagentState> | undefined,
): AgentRow[] {
	const rows = new Map<string, AgentRow>();
	for (const f of files ?? []) {
		rows.set(f.id, row(f.id, { status: "completed", file: f.file, stat: f, startedAt: f.startedAt }));
	}
	for (const s of Object.values(live ?? {})) {
		const cur = rows.get(s.id);
		rows.set(
			s.id,
			row(s.id, {
				...cur,
				agent: s.agent,
				status: s.status,
				file: s.sessionFile ?? cur?.file,
				live: s,
				startedAt: s.startedAt ?? cur?.startedAt,
				finishedAt: s.finishedAt,
			}),
		);
	}
	const all = [...rows.values()];
	// Ties by id: a row's place must not depend on the order frames, the registry and transcripts arrived in (#640).
	const running = all
		.filter((r) => r.running)
		.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || (a.id > b.id ? 1 : -1));
	return [...running, ...all.filter((r) => !r.running)];
}

/**
 * What the agent waits on: the running subagents, and the finished ones its tool call started alongside them (so a
 * batch does not shrink as its members finish). Nothing while nothing runs.
 */
export function jobRows(subagents: Record<string, SubagentState> | undefined): AgentRow[] {
	const all = agentRows(undefined, subagents);
	const running = all.filter((r) => r.running);
	if (!running.length) return [];
	const batches = new Set(running.flatMap((r) => (r.live?.parentToolCallId ? [r.live.parentToolCallId] : [])));
	const settled = all
		.filter((r) => !r.running && r.live?.parentToolCallId && batches.has(r.live.parentToolCallId))
		.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
	return [...running, ...settled];
}

/** The id of the subagent that started `id` (`Features` for `Features.QuotaPill`), or null for a top-level one. */
export function parentId(id: string): string | null {
	const i = id.lastIndexOf(".");
	return i < 0 ? null : id.slice(0, i);
}

/** The subagents `id` started itself, one level down. */
export function childRows(rows: AgentRow[], id: string): AgentRow[] {
	return rows.filter((r) => parentId(r.id) === id);
}

/** The names a `task` call gave its subagents: `name` of each item of `tasks` (or `id`, as this UI once read it), or the call's own. */
function namedBy(args: unknown): string[] {
	return taskItemsOf(args).flatMap((t) => (t.name ? [t.name] : []));
}

/**
 * The subagents a task card stands for. A live process says which tool call started each one; once it is gone only
 * the call's own arguments remain, which name its subagents (`owner` is the subagent whose transcript the card is in:
 * its children are named after it). A name omp had to number because it was taken (`Alpha-2`) matches when the
 * plain one is not there.
 */
export function subagentsForToolCall(rows: AgentRow[], toolCallId: string, args: unknown, owner = ""): AgentRow[] {
	const reported = rows.filter((r) => r.live?.parentToolCallId === toolCallId);
	if (reported.length) return reported;
	const found = new Map<string, AgentRow>();
	for (const name of namedBy(args)) {
		const id = owner ? `${owner}.${name}` : name;
		const exact = rows.find((r) => r.id === id);
		if (exact) {
			found.set(exact.id, exact);
			continue;
		}
		for (const r of rows) if (r.id.startsWith(`${id}-`) && /^\d+$/.test(r.id.slice(id.length + 1))) found.set(r.id, r);
	}
	return [...found.values()];
}

/** How long a subagent has run (still running: until `now`), or undefined when nothing says when it started. */
export function elapsedMs(row: AgentRow, now: number): number | undefined {
	if (row.running) return row.startedAt === undefined ? undefined : Math.max(0, now - row.startedAt);
	const reported = row.live?.progress?.durationMs;
	if (reported !== undefined) return reported;
	const end = row.finishedAt ?? row.stat?.modifiedAt;
	return row.startedAt !== undefined && end !== undefined ? Math.max(0, end - row.startedAt) : undefined;
}

export interface RowSpend {
	parts: UsageParts;
	/**
	 * Tokens a live subagent reports beyond what its transcript shows. omp counts input, output and cache writes in
	 * `progress.tokens` (not cache reads) and does not say which is which, so they can only be added to the total.
	 */
	pending: number;
}

/**
 * What one subagent has used. Its transcript is exact, but it lags a running subagent and may have been read
 * before the latest requests; the frames are current but coarse. So the transcript's numbers are a floor that the
 * frames can raise, never lower: whichever is ahead wins, and nothing is counted twice.
 */
export function rowSpend(row: AgentRow): RowSpend {
	const u = row.stat?.usage;
	const progress = row.live?.progress;
	const parts: UsageParts = {
		input: finite(u?.input),
		output: finite(u?.output),
		cacheRead: finite(u?.cacheRead),
		cacheWrite: finite(u?.cacheWrite),
		cost: Math.max(finite(u?.cost), finite(progress?.cost)),
	};
	const billed = parts.input + parts.output + parts.cacheWrite;
	return { parts, pending: Math.max(0, finite(progress?.tokens) - billed) };
}

/** What a subagent has used, as its row, its live view and the agent graph show it: tokens of every kind, and cost. */
export function rowTotals(row: AgentRow): { tokens: number; cost: number } {
	const { parts, pending } = rowSpend(row);
	return { tokens: parts.input + parts.output + parts.cacheRead + parts.cacheWrite + pending, cost: parts.cost };
}

/**
 * How full a subagent's context window is, from omp's progress record of it (frames or `get_subagents`), or undefined
 * when nothing says: a subagent known only from its transcript, or one that has not made a request yet.
 */
export function rowContext(row: AgentRow): ContextUsage | undefined {
	return progressContext(row.live?.progress);
}

/** The arguments of the tool call `toolCallId` in a transcript, or undefined when it has no such call. */
export function toolCallArguments(entries: SessionEntry[], toolCallId: string): unknown {
	for (const e of entries) {
		const m = messageOf(e);
		if (m?.role !== "assistant") continue;
		const call = blocks(m).find((b) => b.type === "toolCall" && b.id === toolCallId);
		if (call) return call.arguments;
	}
	return undefined;
}
