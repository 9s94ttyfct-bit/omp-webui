import type { OmpFrame } from "@shared/protocol.ts";
import { isAgentMessage } from "../lib/messages.ts";
import { type RetryWait, waitFromFrame } from "../lib/retry-wait.ts";
import { serverOffsetMs } from "../lib/server-clock.ts";
import { ENDED, isOver, isRunning } from "../lib/subagents.ts";
import type { SubagentProgress, SubagentState, ToolExec } from "./live.ts";

/**
 * How omp's subagent frames (`subagent_lifecycle`, `subagent_progress`, `subagent_event`) and the
 * `get_subagents` snapshot become state: when each subagent started and ended, what it is writing, and what its
 * tools print. Pure, so the panel's order and clocks can be tested without a browser.
 */

type Subagents = Record<string, SubagentState>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** omp's lifecycle frames say "started" where its registry and progress say "running". */
const named = (status: string): string => (status === "started" ? "running" : status);

/** What the frames of one subagent say about it, whichever frame carried it. */
function described(p: Record<string, unknown>, cur: SubagentState | undefined): Partial<SubagentState> {
	return {
		agent: str(p.agent) ?? cur?.agent,
		index: num(p.index) ?? cur?.index,
		description: str(p.description) ?? cur?.description,
		task: str(p.task) ?? cur?.task,
		assignment: str(p.assignment) ?? cur?.assignment,
		detached: typeof p.detached === "boolean" ? p.detached : cur?.detached,
		sessionFile: str(p.sessionFile) ?? cur?.sessionFile,
		parentToolCallId: str(p.parentToolCallId) ?? cur?.parentToolCallId,
	};
}

/** Finished tools a subagent keeps: the transcript has the rest, and a long run must not pile up their output. */
const KEEP_DONE_TOOLS = 20;

/** A tool the page heard of after it began (see `ToolExec.late`): what the frame that told of it says. */
export function unseen(id: string, f: Record<string, unknown>, now: number = Date.now()): ToolExec {
	return {
		toolCallId: id,
		toolName: str(f.toolName) ?? "tool",
		args: f.args,
		intent: str(f.intent),
		done: false,
		startedAt: now,
		late: true,
	};
}

/**
 * Forget the oldest finished tools beyond `keep`; the ones still running are never forgotten. The oldest is the one that
 * came first in the record: a tool keeps its place when it is updated, and two that start in one millisecond have the
 * same `startedAt`.
 */
export function trimTools(tools: Record<string, ToolExec>, keep = KEEP_DONE_TOOLS): Record<string, ToolExec> {
	const done = Object.values(tools).filter((t) => t.done);
	if (done.length <= keep) return tools;
	const next = { ...tools };
	for (const t of done.slice(0, done.length - keep)) delete next[t.toolCallId];
	return next;
}

/** A run that is over keeps nothing it was in the middle of: open tools are closed as failed, the stream is dropped. */
function settled(s: SubagentState): SubagentState {
	// A run that is over waits for nothing.
	const base = s.retry ? { ...s, retry: null } : s;
	const open = Object.values(s.tools ?? {}).filter((t) => !t.done);
	if (!open.length && !s.streaming) return base;
	const tools = { ...s.tools };
	for (const t of open) tools[t.toolCallId] = { ...t, done: true, isError: true, args: undefined, partial: undefined };
	return { ...base, tools: trimTools(tools), streaming: null };
}

/**
 * The wait omp's progress record of a subagent describes (`retryState`): for a tab that attached while it was backing
 * off, which missed the frames that said so. The wait the events told of is kept when it is the same one: it knows the
 * usage-limit flag, which the record does not carry. omp stamps its own clock (the server's), as for `LiveRetry`.
 */
function waitFromProgress(progress: unknown, known: RetryWait | null | undefined): RetryWait | undefined {
	const r = rec(rec(progress).retryState);
	const attempt = num(r.attempt);
	const delayMs = num(r.delayMs);
	const startedAtMs = num(r.startedAtMs);
	if (attempt === undefined || delayMs === undefined || startedAtMs === undefined) return undefined;
	if (known && known.attempt === attempt && known.delayMs === delayMs) return known;
	return {
		phase: "waiting",
		attempt,
		maxAttempts: num(r.maxAttempts) ?? attempt,
		delayMs,
		startedAt: startedAtMs - serverOffsetMs(),
		usageLimit: false,
		resumed: false,
		errorMessage: str(r.errorMessage),
	};
}

/**
 * What omp's registry says of a subagent's wait, which is the truth about it: the record carries `retryState` while omp
 * waits and drops it when the retry ends, so a listed subagent whose record has none is not waiting, whatever the page
 * held (it missed the frame that said the retry ended, or the parent's retry or a resume got omp past it). A listing
 * with no progress record at all (an omp that does not send one) says nothing, and the page's own view stands.
 */
function registered(
	progress: unknown,
	held: RetryWait | null | undefined,
	passed: SubagentState["retryPassed"],
): RetryWait | null | undefined {
	if (!progress || typeof progress !== "object") return held;
	const wait = waitFromProgress(progress, held);
	// The wait the subagent already got past (it wrote or ran something since): omp drops it only when that turn ends.
	if (wait && passed && wait.attempt === passed.attempt && wait.delayMs === passed.delayMs) return null;
	return wait ?? (held === undefined ? undefined : null);
}

/** The state of a subagent that begins a run now: nothing it wrote or ran before counts. */
function fresh(id: string, now: number): SubagentState {
	return { id, status: "running", startedAt: now, streaming: null, streamEnded: false, tools: {}, updatedAt: now };
}

function lifecycle(cur: SubagentState | undefined, p: Record<string, unknown>, id: string, now: number): SubagentState {
	const status = named(str(p.status) ?? cur?.status ?? "running");
	// A start after the end of a run (or of nothing) is a new run; a repeated start of a running one is not.
	const base = str(p.status) === "started" && (!cur || isOver(cur.status)) ? fresh(id, now) : (cur ?? fresh(id, now));
	const next: SubagentState = {
		...base,
		...described(p, base),
		id,
		status,
		// Its end is all this frame tells of a subagent seen for the first time: when it began is not known.
		startedAt: !cur && isOver(status) ? undefined : base.startedAt,
		finishedAt: isOver(status) ? (base.finishedAt ?? now) : undefined,
		updatedAt: now,
	};
	return isOver(status) ? settled(next) : next;
}

function progress(cur: SubagentState | undefined, p: Record<string, unknown>, id: string, now: number): SubagentState {
	const prog = rec(p.progress) as unknown as SubagentProgress;
	const status = named(prog.status ?? cur?.status ?? "running");
	const base = cur ?? fresh(id, now);
	// omp's own clock fixes the start better than the first frame's arrival. Once, the first time omp says it: the Agents
	// list is ordered by it, and re-deriving it per frame moves a row by the milliseconds each frame took, and omp's
	// rounding of the elapsed time (#640).
	const elapsed = base.progress ? undefined : num(prog.durationMs);
	const over = isOver(status);
	const next: SubagentState = {
		...base,
		...described({ ...p, description: prog.description ?? p.description }, base),
		id,
		status,
		progress: { ...base.progress, ...prog },
		startedAt: !over && elapsed !== undefined ? now - elapsed : base.startedAt,
		finishedAt: over ? (base.finishedAt ?? now) : undefined,
		retry: registered(p.progress, base.retry, base.retryPassed),
		updatedAt: now,
	};
	return over ? settled(next) : next;
}

/** Tool events of a subagent, folded like the conversation's own (see `applyFrame`). */
function tools(prev: Record<string, ToolExec>, ev: Record<string, unknown>, now: number): Record<string, ToolExec> {
	const id = str(ev.toolCallId);
	if (!id) return prev;
	const cur = prev[id];
	if (ev.type === "tool_execution_start") {
		return {
			...prev,
			[id]: {
				toolCallId: id,
				toolName: str(ev.toolName) ?? "tool",
				args: ev.args,
				intent: str(ev.intent),
				done: false,
				startedAt: now,
			},
		};
	}
	if (ev.type === "tool_execution_update" || ev.type === "tool_stream_update") {
		if (!cur || cur.done) return prev;
		return { ...prev, [id]: { ...cur, partial: ev.partialResult ?? ev.partial ?? ev.update } };
	}
	if (ev.type === "tool_execution_end") {
		const base: ToolExec = cur ?? unseen(id, ev, now);
		// What it printed on the way and what it was called with are not needed once it is over.
		const ended: ToolExec = {
			...base,
			done: true,
			endedAt: now,
			result: ev.result,
			isError: Boolean(ev.isError),
			args: undefined,
			partial: undefined,
		};
		return trimTools({ ...prev, [id]: ended });
	}
	return prev;
}

function event(cur: SubagentState | undefined, p: Record<string, unknown>, id: string, now: number): SubagentState {
	const ev = rec(p.event);
	const base = cur ?? fresh(id, now);
	let { streaming, streamEnded } = base;
	const assistant = (m: unknown) => (isAgentMessage(m) && m.role === "assistant" ? m : null);
	if (ev.type === "message_start") {
		const m = assistant(ev.message);
		if (m) {
			streaming = m;
			streamEnded = false;
		}
	} else if (ev.type === "message_update") {
		const m = assistant(rec(ev.assistantMessageEvent).partial);
		if (m) {
			streaming = m;
			streamEnded = false;
		}
	} else if (ev.type === "message_end") {
		const m = assistant(ev.message);
		if (m) {
			streaming = m;
			streamEnded = true;
		}
	} else if (ev.type === "agent_end" && streaming) {
		streamEnded = true;
	}
	let retry = base.retry;
	let retryPassed = base.retryPassed;
	if (ev.type === "auto_retry_start") {
		retry = waitFromFrame(ev, now);
		retryPassed = undefined;
	} else if (ev.type === "auto_retry_end") retry = null;
	// The retried turn starting ends the wait; omp's end of the retry itself comes when that turn does.
	else if (ev.type === "agent_start" && retry && !retry.resumed) retry = { ...retry, resumed: true };
	// Once the retried turn writes (text or thinking) or runs a tool, it is under way: it is no longer "Retrying…",
	// although omp says the retry ended only when that turn does.
	else if (
		retry &&
		((ev.type === "message_start" && assistant(ev.message)) ||
			(ev.type === "message_update" && assistant(rec(ev.assistantMessageEvent).partial)) ||
			ev.type === "tool_execution_start")
	) {
		retryPassed = { attempt: retry.attempt, delayMs: retry.delayMs };
		retry = null;
	}
	const next: SubagentState = {
		...base,
		streaming: streaming ?? null,
		streamEnded,
		tools: tools(base.tools ?? {}, ev, now),
		retry,
		retryPassed,
		updatedAt: now,
	};
	// Frames that straggle in after the end do not bring a finished run back to life.
	return isOver(next.status) ? settled(next) : next;
}

/** Fold a subagent frame into the conversation's subagents; other frames leave them as they were. */
export function applySubagentFrame(subagents: Subagents, f: OmpFrame, now = Date.now()): Subagents {
	const p = rec(f.payload);
	const id = f.type === "subagent_progress" ? (str(rec(p.progress).id) ?? str(p.id)) : str(p.id);
	if (!id) return subagents;
	const cur = subagents[id];
	switch (f.type) {
		case "subagent_lifecycle":
			return { ...subagents, [id]: lifecycle(cur, p, id, now) };
		case "subagent_progress":
			return { ...subagents, [id]: progress(cur, p, id, now) };
		case "subagent_event":
			return { ...subagents, [id]: event(cur, p, id, now) };
		default:
			return subagents;
	}
}

/**
 * Bring what the conversation knows up to `get_subagents`, omp's registry of the subagents that are running now.
 * A subagent we had as running that the registry no longer lists has ended and its end frame was missed (the socket
 * dropped, or this tab attached late). How it ended is not known: it may have failed or been cancelled as well as
 * completed, so it is shown as `ended`, not as completed.
 */
export function mergeSnapshot(current: Subagents, list: unknown[], now = Date.now()): Subagents {
	const next: Subagents = { ...current };
	const listed = new Set<string>();
	for (const raw of list) {
		const r = rec(raw);
		const id = str(r.id);
		if (!id) continue;
		listed.add(id);
		const cur = next[id];
		const prog = r.progress ? (rec(r.progress) as unknown as SubagentProgress) : undefined;
		const status = named(str(r.status) ?? cur?.status ?? "running");
		const elapsed = cur?.progress ? undefined : num(prog?.durationMs);
		const merged: SubagentState = {
			...(cur ?? fresh(id, now)),
			...described(r, cur),
			id,
			status,
			progress: prog ? { ...cur?.progress, ...prog } : cur?.progress,
			startedAt: !isOver(status) && elapsed !== undefined ? now - elapsed : (cur?.startedAt ?? now),
			finishedAt: isOver(status) ? (cur?.finishedAt ?? now) : undefined,
			retry: registered(r.progress, cur?.retry, cur?.retryPassed),
			updatedAt: now,
		};
		next[id] = isOver(status) ? settled(merged) : merged;
	}
	for (const [id, cur] of Object.entries(next)) {
		if (!listed.has(id) && isRunning(cur.status))
			next[id] = settled({ ...cur, status: ENDED, finishedAt: now, updatedAt: now });
	}
	return next;
}

/** The conversation's process is gone: whatever it was running is over. */
export function endAll(subagents: Subagents, now = Date.now()): Subagents {
	const next: Subagents = {};
	for (const [id, cur] of Object.entries(subagents)) {
		next[id] = isRunning(cur.status) ? settled({ ...cur, status: "aborted", finishedAt: now, updatedAt: now }) : cur;
	}
	return next;
}
