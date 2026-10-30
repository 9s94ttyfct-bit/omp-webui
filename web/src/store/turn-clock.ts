import type { OmpFrame, SessionEntry } from "@shared/protocol.ts";
import { create } from "zustand";
import { activeMs } from "../lib/turn-stats.ts";

/**
 * Marks taken as a turn's frames arrive, on this browser's clock. omp reports how long a request took, and when its
 * first token came, only once the request has ended; these are what the page can show while it streams. They also
 * keep the live figures free of any difference between this browser's clock and the machine omp runs on.
 */
export interface TurnClock {
	/** The turn began: `agent_start` arrived. */
	startedAt: number;
	/** How long the agent had worked in the conversation before this turn, so its total goes on ticking from there. */
	activeBefore: number;
	/** The request in flight: when it began, and when its first token arrived. */
	step?: { messageId: string; startedAt: number; firstTokenAt?: number };
	/** The agent stopped without finishing the turn (`agent_end` with `isTerminal: false`): the next run continues it. */
	continuing?: true;
}

/** The events of a streaming message that carry its first content. */
const CONTENT_EVENT = /^(text|thinking|toolcall)_(start|delta)$/;

function rec(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Fold one frame into a process's clock (null: no turn is running, or the page missed its start). `entries` are the
 * conversation's saved entries, from which a new turn's clock takes what the agent had worked until then.
 */
export function clockFrame(
	clock: TurnClock | null,
	f: OmpFrame,
	now: number,
	entries: SessionEntry[],
): TurnClock | null {
	switch (f.type) {
		case "agent_start":
			// Only a turn the agent stopped partway carries on; a clock left by a turn whose end was missed does not.
			return clock?.continuing
				? { startedAt: clock.startedAt, activeBefore: clock.activeBefore }
				: { startedAt: now, activeBefore: activeMs(entries) };
		case "agent_end":
			return f.isTerminal === false && clock
				? { startedAt: clock.startedAt, activeBefore: clock.activeBefore, continuing: true }
				: null;
		case "session_settled":
			return null;
		case "message_start":
			if (!clock || rec(f.message).role !== "assistant" || typeof f.messageId !== "string") return clock;
			return { ...clock, step: { messageId: f.messageId, startedAt: now } };
		case "message_update": {
			const step = clock?.step;
			if (!clock || !step || step.firstTokenAt !== undefined || f.messageId !== step.messageId) return clock;
			const type = rec(f.assistantMessageEvent).type;
			return typeof type === "string" && CONTENT_EVENT.test(type)
				? { ...clock, step: { ...step, firstTokenAt: now } }
				: clock;
		}
		case "message_end":
			// The request's own figures come from omp now, with the message.
			return clock?.step && clock.step.messageId === f.messageId
				? { startedAt: clock.startedAt, activeBefore: clock.activeBefore }
				: clock;
		default:
			return clock;
	}
}

/** The clock of each live process with a turn running, by live id. */
export const useTurnClocks = create<Record<string, TurnClock>>(() => ({}));

/** Note a frame of a process: the app calls this for every frame it receives, before the frame changes the state. */
export function noteTurnFrame(liveId: string, frame: OmpFrame, entries: SessionEntry[]): void {
	const cur = useTurnClocks.getState()[liveId] ?? null;
	const next = clockFrame(cur, frame, Date.now(), entries);
	// Most frames are streamed tokens and change nothing: they must not wake the components that show a clock.
	if (next === cur) return;
	useTurnClocks.setState((s) => {
		const { [liveId]: _, ...others } = s;
		return next ? { ...others, [liveId]: next } : others;
	}, true);
}

/**
 * Forget a process's clock: a page that attaches again (or whose process has gone) cannot tell which turn boundaries
 * it missed, so a clock left from before would count idle time. The turn then reads as one the page opened in the middle of.
 */
export function clearTurnClock(liveId: string): void {
	if (!(liveId in useTurnClocks.getState())) return;
	useTurnClocks.setState((s) => {
		const { [liveId]: _, ...others } = s;
		return others;
	}, true);
}

/**
 * Start the clock of a turn this page did not see begin (it attached after, or lost its connection and attached again): the
 * server says when the turn began (`LiveInfo.turnStartedAt`: `serverStartedAt` on its clock, `startedAt` on this page's), and the
 * conversation's saved entries from before it say how long the agent had worked until then. Entries are stamped with omp's
 * clock, which is the server's. A turn the page already follows (a frame of it started a clock) is left as it is.
 */
export function seedTurnClock(
	liveId: string,
	startedAt: number,
	serverStartedAt: number,
	entries: SessionEntry[],
): void {
	if (liveId in useTurnClocks.getState()) return;
	const before = entries.filter((e) => {
		const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : Number.NaN;
		return Number.isNaN(at) || at < serverStartedAt;
	});
	useTurnClocks.setState((s) => ({ ...s, [liveId]: { startedAt, activeBefore: activeMs(before) } }), true);
}
