import { isRecord } from "../../shared/guards.ts";
import type { OmpFrame } from "../../shared/protocol.ts";
import { callProgress, type QueuedSubagent } from "../../shared/subagent-concurrency.ts";
import { isOverStatus } from "../../shared/subagent-status.ts";

/**
 * How long a change of what waits is held before the pages are told. Every subagent of a `task` call is `pending` for the
 * moment it takes omp to give it a slot: with room for all of them that is a few milliseconds, and such a subagent is
 * never shown as queued.
 */
export const QUEUED_SETTLE_MS = 250;

/** What separates the agent that made a call from the call's id in a key (no id holds it). */
const SEP = "\u0000";

/**
 * The subagents a process's omp has queued under `task.maxConcurrency` (see `shared/subagent-concurrency.ts`), worked out
 * from omp's own records: each `task` call's progress (`details.progress`, in `tool_execution_update` and
 * `tool_execution_end` frames, and in a subagent's `subagent_event` frames for the calls it makes) says which of its
 * subagents are `pending`, and omp goes on sending it for the subagents it runs in the background after the call returned.
 * One leaves the list when its call says it is no longer pending, when omp says it started (`subagent_lifecycle`), when the
 * subagent that made its call is over, when omp says nothing can wake the session any more (`session_settled`: no
 * background job waits), and when the process ends.
 *
 * The server keeps it, not the page: a page that attaches while subagents wait has missed the frames that said so, and the
 * frames say nothing new until one of them starts.
 */
export class QueuedSubagents {
	/** By the call that spawned them (the agent that made it, `""` for the main one, and the call's id): who waits. */
	private readonly calls = new Map<string, Map<string, QueuedSubagent>>();
	/** What the pages were last told, as the ids in order. */
	private told = "";
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		/** The list changed (after `settleMs`): the pages are to be told. */
		private readonly changed: (queued: QueuedSubagent[]) => void,
		private readonly settleMs = QUEUED_SETTLE_MS,
		private readonly now: () => number = Date.now,
	) {}

	/** Who waits now, the longest waiting first. */
	get list(): QueuedSubagent[] {
		return [...this.calls.values()]
			.flatMap((call) => [...call.values()])
			.sort((a, b) => a.since - b.since || (a.index ?? 0) - (b.index ?? 0) || (a.id > b.id ? 1 : -1));
	}

	/** Take what `frame` says of the subagents that wait. */
	frame(frame: OmpFrame): void {
		switch (frame.type) {
			case "tool_execution_update":
			case "tool_execution_end":
				this.call("", frame);
				return;
			case "subagent_event": {
				const p = frame.payload;
				if (isRecord(p) && typeof p.id === "string" && isRecord(p.event)) this.call(p.id, p.event);
				return;
			}
			case "subagent_lifecycle": {
				const p = frame.payload;
				if (!isRecord(p) || typeof p.id !== "string") return;
				if (p.status === "started") this.started(p.id);
				else if (typeof p.status === "string" && isOverStatus(p.status)) this.ownerOver(p.id);
				return;
			}
			case "session_settled":
				this.sweep();
				return;
		}
	}

	/** The process is gone: nothing waits, and the pages are told now. */
	end(): void {
		clearTimeout(this.timer ?? undefined);
		this.timer = null;
		this.calls.clear();
		this.tell();
	}

	/** One frame of a call (`event`), made by `owner` (`""`: the main agent): a `task` call's progress replaces what it said. */
	private call(owner: string, event: Record<string, unknown>): void {
		if (event.toolName !== "task" || typeof event.toolCallId !== "string") return;
		const result = isRecord(event.partialResult) ? event.partialResult : isRecord(event.result) ? event.result : null;
		const progress = callProgress(result?.details);
		// A frame without progress (an error, a result of another shape) says nothing of who waits.
		if (progress.length === 0) return;
		const key = `${owner}${SEP}${event.toolCallId}`;
		const before = this.calls.get(key);
		const waiting = new Map<string, QueuedSubagent>();
		for (const p of progress) {
			if (!p.pending) continue;
			waiting.set(
				p.id,
				before?.get(p.id) ?? {
					id: p.id,
					parentToolCallId: event.toolCallId,
					...(p.index !== undefined ? { index: p.index } : {}),
					...(p.agent ? { agent: p.agent } : {}),
					...(p.assignment ? { assignment: p.assignment } : {}),
					since: this.now(),
				},
			);
		}
		if (waiting.size > 0) this.calls.set(key, waiting);
		else if (!this.calls.delete(key)) return;
		this.schedule();
	}

	/** omp started `id`: it no longer waits, whichever call it was in. */
	private started(id: string): void {
		let gone = false;
		for (const [key, call] of this.calls) {
			if (!call.delete(id)) continue;
			gone = true;
			if (call.size === 0) this.calls.delete(key);
		}
		if (gone) this.schedule();
	}

	/** The subagent `owner` is over: what its own calls queued goes with it. */
	private ownerOver(owner: string): void {
		let gone = false;
		for (const key of [...this.calls.keys()]) {
			if (!key.startsWith(`${owner}${SEP}`)) continue;
			this.calls.delete(key);
			gone = true;
		}
		if (gone) this.schedule();
	}

	/** Nothing can wake the session (no background job waits): nothing is queued either. */
	private sweep(): void {
		if (this.calls.size === 0) return;
		this.calls.clear();
		this.schedule();
	}

	private schedule(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.tell();
		}, this.settleMs);
	}

	private tell(): void {
		const list = this.list;
		const said = list.map((q) => `${q.parentToolCallId}${SEP}${q.id}`).join("\n");
		if (said === this.told) return;
		this.told = said;
		this.changed(list);
	}
}
