import type { OmpFrame } from "../../shared/protocol.ts";

/**
 * What a tab that attaches in the middle of a turn has missed, and what lets it tell a page's copy from omp's.
 *
 * omp writes a reply as increments (`text_delta`, `thinking_delta`): a snapshot of the message exists only in
 * `message_start` and `message_end`. A tab that attaches (a reload, a second tab, a reconnect) between them has no way to
 * build the message, and showed it with a hole, or starting mid-sentence, until the block ended (#363). The server keeps
 * the frames of the message in flight, deltas of one block joined, and replays them to a tab that attaches.
 */

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function eventOf(frame: OmpFrame): Record<string, unknown> {
	const ev = frame.assistantMessageEvent;
	return ev && typeof ev === "object" ? (ev as Record<string, unknown>) : {};
}

/** The kinds of `assistantMessageEvent` whose frames add to the one before them (the page shows no arguments being typed). */
const JOINS: Record<string, true> = { text_delta: true, thinking_delta: true };

/** `next` adds to `last`: the same block of the same message, a delta in both. */
function continues(last: OmpFrame, next: OmpFrame): boolean {
	const a = eventOf(last);
	const b = eventOf(next);
	return (
		last.messageId === next.messageId &&
		typeof a.type === "string" &&
		JOINS[a.type] === true &&
		a.type === b.type &&
		typeof a.contentIndex === "number" &&
		a.contentIndex === b.contentIndex &&
		typeof a.delta === "string" &&
		typeof b.delta === "string"
	);
}

/** The message omp is writing now, as the frames that made it so far. */
export class InFlightMessage {
	private id: string | null = null;
	private frames: OmpFrame[] = [];

	/** The id of the message in flight; null when omp is not writing one. */
	get messageId(): string | null {
		return this.id;
	}

	/** Take one frame omp sent. Nothing is changed in `frame`: the tabs hold the same object. */
	note(frame: OmpFrame): void {
		switch (frame.type) {
			case "message_start": {
				const id = str(frame.messageId);
				this.id = id ?? null;
				this.frames = id ? [frame] : [];
				return;
			}
			case "message_update": {
				if (this.id === null || frame.messageId !== this.id) return;
				const ev = eventOf(frame);
				// A snapshot of the whole message (omp without the delta projection) is all there is to replay.
				if (ev.partial !== undefined) {
					this.frames = [frame];
					return;
				}
				// Not shown until the call ends.
				if (ev.type === "toolcall_delta") return;
				const last = this.frames.at(-1);
				if (last && continues(last, frame)) {
					const joined = `${eventOf(last).delta}${ev.delta}`;
					this.frames[this.frames.length - 1] = { ...last, assistantMessageEvent: { ...eventOf(last), delta: joined } };
				} else {
					this.frames.push(frame);
				}
				return;
			}
			// A message ends with its own frame; a turn that is stopped may not say so, and nothing is in flight after it.
			case "message_end":
			case "agent_end":
			case "session_settled":
				this.id = null;
				this.frames = [];
				return;
		}
	}

	/** The frames that bring a tab that missed the message so far up to date, in the order they came. */
	replay(): OmpFrame[] {
		return [...this.frames];
	}
}

/**
 * Frames that cannot change an entry omp already wrote: streamed content, progress, dialogs and the like. Every other
 * frame moves `LiveInfo.revision`, because a rewrite (a failure a retry got past, what a shake shortened, an image
 * dropped) comes with whichever frame its operation sends, and not every operation says what it did.
 */
const NO_REWRITE: Record<string, true> = {
	message_update: true,
	tool_execution_update: true,
	tool_stream_update: true,
	subagent_lifecycle: true,
	subagent_progress: true,
	subagent_event: true,
	btw_record: true,
	btw_delta: true,
	queue_update: true,
	extension_ui_request: true,
	host_tool_call: true,
	host_tool_cancel: true,
	available_commands_update: true,
	notice: true,
};

/** Whether `frame` is one that may come with a change to an entry omp already wrote (see `NO_REWRITE`). */
export function mayRewriteEntries(frame: OmpFrame): boolean {
	return NO_REWRITE[frame.type] !== true;
}
