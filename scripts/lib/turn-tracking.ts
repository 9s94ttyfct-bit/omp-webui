/**
 * What the soak harness knows of a conversation's turn: when the prompt was sent, whether omp has been seen working
 * on it, and when the turn was over. Pure bookkeeping, so that the harness's own timing can be reasoned about (and
 * tested) without a server, a browser or a model.
 *
 * A turn is one of three things, and the harness has to tell them apart:
 *
 * - **seen working**: omp was seen working on it (the server says it is streaming, or holding "working"/"asking").
 *   The turn is over when omp is idle again, and its time is what it took.
 * - **never seen working**: omp was idle the whole time the prompt was in flight, so the harness cannot say when the
 *   turn began. Its time is then the grace the harness gives a prompt that has not started yet, and the turn is
 *   counted apart ("of which over before omp was seen working").
 * - **started on its own**: omp began working with no prompt of the harness in flight (a background job or a
 *   subagent finished). Its working time is counted apart, not as the turn of a prompt.
 *
 * The rule that makes this work: **the marker of a turn that is in flight is never cleared by the harness's own
 * bookkeeping.** Sending a prompt arms the turn; a poll that sees omp working keeps it armed and remembers when the
 * work began; a poll that sees omp idle ends it. Nothing else may clear it — a turn that was seen working has
 * happened, and clearing its marker loses the time it took and reports the turn as one that never started.
 */

/** How long a prompt may be in flight before the harness takes it for a turn omp never started. */
export const PROMPT_GRACE_S = 6;

/** What the harness knows of a conversation's turn in flight. */
export interface TurnState {
	/** When the prompt was sent (0 when no prompt of the harness is in flight). */
	sentAt: number;
	/** omp was seen working on the prompt: the turn began. */
	seenWorking: boolean;
	/** When omp was first seen working on the turn (0 while it has not been seen). */
	workingSince: number;
	/** The turn began with no prompt of the harness in flight: omp started it on its own. */
	onItsOwn: boolean;
}

/** A turn that is not in flight. */
export const NO_TURN: TurnState = { sentAt: 0, seenWorking: false, workingSince: 0, onItsOwn: false };

/** What a poll of the server said of a conversation. */
export interface TurnPoll {
	/** omp is working on the conversation (a turn is running). */
	streaming: boolean;
	/** What the conversation is busy with: "working", "asking" (a dialog waits for the user), or null when it is idle. */
	holding: "working" | "asking" | "paused" | null;
}

/** Whether the server says the conversation is being worked on. */
export function beingWorked(poll: TurnPoll): boolean {
	return poll.streaming || poll.holding === "working" || poll.holding === "asking";
}

/** What one poll of the server did to the harness's knowledge of the turn. */
export interface TurnUpdate {
	/** The turn is over: the harness may record its time. */
	ended: boolean;
	/** The turn is over and omp was never seen working on it. */
	endedUnseen: boolean;
	/** The turn is over and omp started it on its own. */
	endedOnItsOwn: boolean;
	/** omp has begun working (this poll saw it start). */
	started: boolean;
}

const NOTHING: TurnUpdate = { ended: false, endedUnseen: false, endedOnItsOwn: false, started: false };

/**
 * Fold one poll of the server into what the harness knows of the turn.
 *
 * `now` is the time of the poll (seconds). A prompt that was sent and never seen working is given the grace
 * (`PROMPT_GRACE_S`) before it is taken for over: omp takes about a second to start a turn, and the harness must not
 * call a turn over before omp has had a chance to begin it.
 */
export function pollTurn(state: TurnState, poll: TurnPoll, now: number): TurnUpdate {
	if (beingWorked(poll)) {
		if (state.sentAt === 0 && !state.onItsOwn) {
			// omp began working with no prompt of the harness in flight: it started on its own.
			return { ...NOTHING, started: true };
		}
		return { ...NOTHING, started: !state.seenWorking };
	}
	// The conversation is idle.
	if (state.onItsOwn) return { ended: true, endedUnseen: false, endedOnItsOwn: true, started: false };
	if (state.sentAt !== 0 && !state.seenWorking) {
		// A prompt that was sent and never seen working: the harness waits out the grace before it takes it for over.
		if (now - state.sentAt < PROMPT_GRACE_S) return NOTHING;
		return { ended: true, endedUnseen: true, endedOnItsOwn: false, started: false };
	}
	if (state.seenWorking) return { ended: true, endedUnseen: false, endedOnItsOwn: false, started: false };
	return NOTHING;
}

/** The state after a poll: what the harness knows of the turn now. */
export function nextTurn(state: TurnState, poll: TurnPoll, now: number): TurnState {
	if (beingWorked(poll)) {
		if (state.sentAt === 0 && !state.onItsOwn) {
			// omp began working on its own: the turn it is working on is not the harness's.
			return { sentAt: 0, seenWorking: true, workingSince: state.workingSince || now, onItsOwn: true };
		}
		// A turn that is already marked is kept as it is: an own turn stays the harness's own turn (its marker is
		// what the turn is counted as), and a turn of a prompt of the harness stays that one.
		return {
			sentAt: state.sentAt,
			seenWorking: true,
			workingSince: state.workingSince || now,
			onItsOwn: state.onItsOwn,
		};
	}
	// The conversation is idle: whatever turn was in flight is over — unless a prompt is still within its grace,
	// which may yet begin.
	if (state.sentAt !== 0 && !state.seenWorking && now - state.sentAt < PROMPT_GRACE_S) {
		return { ...state, seenWorking: false, workingSince: 0, onItsOwn: false };
	}
	return { ...NO_TURN };
}

/**
 * Arm the turn of a prompt that was just sent: the harness is waiting for omp to start on it.
 *
 * A turn that was already seen working keeps its marker: the poll that saw omp working knows the turn began, and
 * nothing about sending a prompt may undo that. A turn omp had started **on its own** is the harness's own turn no
 * longer: the prompt the harness sends is a turn of its own, and it is that turn that is timed.
 */
export function armTurn(state: TurnState, sentAt: number): TurnState {
	if (state.seenWorking) return { sentAt, seenWorking: true, workingSince: state.workingSince, onItsOwn: false };
	return { sentAt, seenWorking: false, workingSince: 0, onItsOwn: false };
}

/**
 * Whether the conversation is busy: the harness must not send it a prompt or a goal, and the turn watcher must
 * keep looking at it.
 *
 * A conversation is busy while a prompt of the harness is in flight (`sentAt`), and while omp is working on it
 * (`seenWorking`) — which includes a turn omp started on its own: no prompt of the harness is in flight then
 * (`sentAt` is 0), but omp is working, and the conversation is not free.
 */
export function isBusy(state: TurnState): boolean {
	return state.sentAt !== 0 || state.seenWorking;
}

/**
 * Undo the arming of a prompt that was **not** sent: the send failed, so nothing of it is in flight.
 *
 * `before` is the state the conversation had before the prompt was armed. A turn omp was seen working on keeps
 * its marker (it is the turn the harness is timing, and it is not the failed send's turn); a turn that was only
 * armed goes back to what it was.
 */
export function disarmTurn(before: TurnState): TurnState {
	if (before.seenWorking) return { ...before };
	return { ...before, sentAt: 0 };
}
