import type { OmpFrame } from "../shared/protocol.ts";

/** How long a subagent's newest message update is held back for the next one to replace it. */
export const SUBAGENT_UPDATE_MS = 100;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** The subagent a frame belongs to, if it is one of omp's subagent frames. */
function subagentOf(frame: OmpFrame): string | null {
	if (frame.type !== "subagent_lifecycle" && frame.type !== "subagent_progress" && frame.type !== "subagent_event")
		return null;
	const p = rec(frame.payload);
	const id = frame.type === "subagent_progress" ? (rec(p.progress).id ?? p.id) : p.id;
	return typeof id === "string" ? id : null;
}

/**
 * A subagent streaming text sends a whole message snapshot (`assistantMessageEvent.partial`) for every token, and
 * each is only the latest state of the same message. This is the one kind of frame that is safe to merge.
 */
function isUpdate(frame: OmpFrame): boolean {
	if (frame.type !== "subagent_event") return false;
	const ev = rec(rec(frame.payload).event);
	const partial = rec(ev.assistantMessageEvent).partial;
	return ev.type === "message_update" && typeof partial === "object" && partial !== null;
}

export interface Timers {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const REAL: Timers = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Passes frames on, except a subagent's message updates: of those only the newest per subagent is kept, and sent
 * when `SUBAGENT_UPDATE_MS` have passed since the first one held (so a stream becomes about ten frames a second).
 * Nothing is lost that a reader of the latest state would see: any other frame of that subagent (a tool starting,
 * the message ending, its status changing) is sent after the held update, in the order omp sent them.
 */
export class SubagentCoalescer {
	private readonly held = new Map<string, OmpFrame>();
	private timer: unknown = null;

	constructor(
		private readonly send: (frame: OmpFrame) => void,
		private readonly timers: Timers = REAL,
	) {}

	push(frame: OmpFrame): void {
		const id = subagentOf(frame);
		if (id === null) {
			this.send(frame);
			return;
		}
		if (isUpdate(frame)) {
			this.held.set(id, frame);
			this.timer ??= this.timers.set(() => this.flush(), SUBAGENT_UPDATE_MS);
			return;
		}
		this.flush(id);
		this.send(frame);
	}

	/** Send what is held: that of one subagent, or of all of them. */
	flush(id?: string): void {
		if (id === undefined) {
			if (this.timer !== null) this.timers.clear(this.timer);
			this.timer = null;
			const all = [...this.held.values()];
			this.held.clear();
			for (const f of all) this.send(f);
			return;
		}
		const frame = this.held.get(id);
		if (!frame) return;
		this.held.delete(id);
		if (!this.held.size && this.timer !== null) {
			this.timers.clear(this.timer);
			this.timer = null;
		}
		this.send(frame);
	}
}
