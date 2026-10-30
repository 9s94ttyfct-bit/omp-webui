import type { OmpFrame, ServerMessage } from "@shared/protocol.ts";

/**
 * Streamed tokens arrive as one `message_update` frame each, tens of times a second, and each used to be a store write
 * and a render. `FrameBatcher` holds them back until the page is about to paint and delivers what came in as one
 * batch: runs of deltas of one block are joined into a single frame, so a batch of N tokens is one store write.
 *
 * What is delivered, and in what order, does not change:
 * - the frames of a conversation reach the listeners in the order they arrived; a frame that is not a `message_update`
 *   (an end of message, a tool call, a state change, a reply) first delivers everything held, so nothing overtakes a token;
 * - nothing is dropped: a joined frame is the first frame of its run with all the run's text in its delta.
 */

/** When held frames are delivered; the unit tests drive it by hand. */
export interface BatchClock {
	/** Run `fn` before the next paint; returns what cancels it. */
	frame(fn: () => void): () => void;
	/** Run `fn` after `ms`, paint or not. */
	timeout(fn: () => void, ms: number): () => void;
}

/** A hidden tab does not paint: what is held goes out after this long anyway (the browser may delay a timer further). */
export const HIDDEN_FLUSH_MS = 100;

/** About one frame at 60 Hz, for when there is no `requestAnimationFrame` (a test, a worker). */
const FRAME_MS = 16;

export const browserClock: BatchClock = {
	frame(fn) {
		if (typeof requestAnimationFrame === "function") {
			const id = requestAnimationFrame(fn);
			return () => cancelAnimationFrame(id);
		}
		const id = setTimeout(fn, FRAME_MS);
		return () => clearTimeout(id);
	},
	timeout(fn, ms) {
		const id = setTimeout(fn, ms);
		return () => clearTimeout(id);
	},
};

/** The kinds of `assistantMessageEvent` whose frames add to the one before them. */
const JOINS: Record<string, true> = { text_delta: true, thinking_delta: true, toolcall_delta: true };

type Held = { frame: OmpFrame; deltas: string[] | null };

function eventOf(frame: OmpFrame): Record<string, unknown> | null {
	const ev = frame.assistantMessageEvent;
	return ev && typeof ev === "object" ? (ev as Record<string, unknown>) : null;
}

/**
 * `b` continues `a`: the same block of the same message, a delta in both. A frame with a `partial` snapshot (omp
 * before the delta projection) is a full state, not an addition: those are never joined.
 */
function continues(a: OmpFrame, b: OmpFrame): boolean {
	const x = eventOf(a);
	const y = eventOf(b);
	return (
		x !== null &&
		y !== null &&
		typeof a.messageId === "string" &&
		a.messageId === b.messageId &&
		typeof x.type === "string" &&
		JOINS[x.type] === true &&
		x.type === y.type &&
		typeof x.contentIndex === "number" &&
		x.contentIndex === y.contentIndex &&
		typeof x.delta === "string" &&
		typeof y.delta === "string" &&
		x.partial === undefined &&
		y.partial === undefined
	);
}

function joined({ frame, deltas }: Held): OmpFrame {
	return deltas ? { ...frame, assistantMessageEvent: { ...eventOf(frame), delta: deltas.join("") } } : frame;
}

export class FrameBatcher {
	/** The held frames of each conversation, in arrival order. The conversations do not depend on each other. */
	private held = new Map<string, Held[]>();
	private cancel: (() => void)[] = [];
	/** Conversations that just began a message: its first update is not held, because the turn clock times the first token by when it arrives. */
	private leading = new Set<string>();

	constructor(
		private readonly deliver: (msg: ServerMessage) => void,
		private readonly clock: BatchClock = browserClock,
	) {}

	/** Take one message from the server: hold it if it is a streamed update, otherwise deliver it after everything held. */
	push(msg: ServerMessage): void {
		if (msg.t !== "frame" || msg.frame.type !== "message_update") {
			this.flush();
			if (msg.t === "frame" && msg.frame.type === "message_start") this.leading.add(msg.liveId);
			this.deliver(msg);
			return;
		}
		// Nothing of this conversation is held at this point: the message_start that set `leading` delivered everything.
		if (this.leading.delete(msg.liveId)) {
			this.deliver(msg);
			return;
		}
		const list = this.held.get(msg.liveId);
		const last = list?.at(-1);
		if (last && continues(last.frame, msg.frame)) {
			last.deltas ??= [String(eventOf(last.frame)?.delta)];
			last.deltas.push(String(eventOf(msg.frame)?.delta));
		} else if (list) {
			list.push({ frame: msg.frame, deltas: null });
		} else {
			this.held.set(msg.liveId, [{ frame: msg.frame, deltas: null }]);
		}
		if (!this.cancel.length) {
			this.cancel = [this.clock.frame(() => this.flush()), this.clock.timeout(() => this.flush(), HIDDEN_FLUSH_MS)];
		}
	}

	/** Deliver what is held now. Every listener sees every frame, also when one of them throws; the first error is thrown at the end. */
	flush(): void {
		// Called for every message that is not a streamed update (a terminal's output, say): nothing to do must cost nothing.
		if (this.cancel.length) for (const stop of this.cancel.splice(0)) stop();
		if (!this.held.size) return;
		const batch = this.held;
		this.held = new Map();
		let failure: { error: unknown } | null = null;
		for (const [liveId, list] of batch) {
			for (const held of list) {
				try {
					this.deliver({ t: "frame", liveId, frame: joined(held) });
				} catch (error) {
					failure ??= { error };
				}
			}
		}
		if (failure) throw failure.error;
	}
}
