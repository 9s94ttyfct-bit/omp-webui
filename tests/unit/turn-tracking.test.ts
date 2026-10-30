import { expect, test } from "bun:test";
import {
	armTurn,
	beingWorked,
	disarmTurn,
	isBusy,
	NO_TURN,
	nextTurn,
	PROMPT_GRACE_S,
	pollTurn,
	type TurnPoll,
	type TurnState,
} from "../../scripts/lib/turn-tracking.ts";

/**
 * What the soak harness knows of a conversation's turn, and when it may record the turn's time.
 *
 * The harness's own timing was the subject of issue #471: over a three-hour run the "Send until omp is idle again"
 * median rose from ~3 s to ~6.1 s for every kind of turn. The turns were not slower — the harness lost the marker of
 * the turns it had seen working, and reported them as prompts that had never started, whose time is the 6 s grace.
 */

const idle: TurnPoll = { streaming: false, holding: null };
const working: TurnPoll = { streaming: true, holding: "working" };
const asking: TurnPoll = { streaming: false, holding: "asking" };
/** The conversation is idle (the name the tests use for it). */
const idlePoll = idle;

/** The harness's poll loop, as the turn-tracking module sees it. */
function poll(state: TurnState, p: TurnPoll, now: number): { state: TurnState; update: ReturnType<typeof pollTurn> } {
	return { state: nextTurn(state, p, now), update: pollTurn(state, p, now) };
}

test("a prompt that was sent and is seen working ends when omp is idle again", () => {
	let state = armTurn(NO_TURN, 100);
	const started = poll(state, working, 100.5);
	// The turn began: the harness may record how long omp took to start.
	expect(started.update.started).toBe(true);
	state = started.state;
	expect(state.seenWorking).toBe(true);

	const done = poll(state, idle, 102.5);
	expect(done.update.ended).toBe(true);
	expect(done.update.endedUnseen).toBe(false);
	expect(done.state.sentAt).toBe(0);
});

test("a prompt that was sent and never seen working is taken for over only after the grace", () => {
	const state = armTurn(NO_TURN, 100);
	// Still inside the grace: the turn may begin, so it is not over.
	const early = poll(state, idle, 100 + PROMPT_GRACE_S - 0.1);
	expect(early.update.ended).toBe(false);

	// Past the grace: omp never started on it, so the turn is over and counted apart.
	const late = poll(state, idle, 100 + PROMPT_GRACE_S);
	expect(late.update.ended).toBe(true);
	expect(late.update.endedUnseen).toBe(true);
});

test("sending a prompt does not clear the marker of a turn that was already seen working", () => {
	// The harness's own bug (#471): the send step ends with a reset of the turn's marker, and a poll that has
	// already seen omp working loses it. The turn is then reported as one that never started, and its time is the
	// 6 s grace instead of the time it took.
	let state = armTurn(NO_TURN, 100);
	state = poll(state, working, 100.2).state;
	expect(state.seenWorking).toBe(true);
	expect(state.workingSince).toBe(100.2);

	// The harness's send step: another prompt is sent while the turn is in flight.
	state = armTurn(state, 100.3);
	expect(state.seenWorking).toBe(true);
	expect(state.workingSince).toBe(100.2);

	// The turn ends: the harness records the time it took, not the grace.
	const done = poll(state, idle, 102.5);
	expect(done.update.ended).toBe(true);
	expect(done.update.endedUnseen).toBe(false);
});

test("working that no prompt of the harness started is counted apart", () => {
	// omp began working on its own: a background job or a subagent finished.
	const seen = poll(NO_TURN, working, 50);
	expect(seen.state.onItsOwn).toBe(true);
	expect(seen.state.sentAt).toBe(0);

	const done = poll(seen.state, idle, 52);
	expect(done.update.ended).toBe(true);
	expect(done.update.endedOnItsOwn).toBe(true);
	expect(done.update.endedUnseen).toBe(false);
});

test("a dialog the user must answer keeps the conversation busy", () => {
	expect(beingWorked(asking)).toBe(true);
	expect(beingWorked(working)).toBe(true);
	expect(beingWorked(idle)).toBe(false);
});

test("a turn that was seen working is not taken for over by the grace", () => {
	// The grace is for a prompt that has not started: a turn that omp was seen working on ends when omp is idle.
	const state = armTurn(NO_TURN, 100);
	const seen = poll(state, working, 100.1).state;
	const done = poll(seen, idle, 100.2);
	expect(done.update.ended).toBe(true);
	expect(done.update.endedUnseen).toBe(false);
});

test("a prompt within its grace stays armed, so a turn that begins later is still timed", () => {
	// The prompt was sent and omp has not started on it yet: the grace runs, and the prompt is still in flight.
	let state = armTurn(NO_TURN, 100);
	const idle = poll(state, idlePoll, 100.5);
	expect(idle.update.ended).toBe(false);
	state = idle.state;
	expect(state.sentAt).toBe(100);

	// omp starts on it inside the grace: the turn is timed from the send.
	const begun = poll(state, working, 101.2);
	expect(begun.update.started).toBe(true);
	state = begun.state;
	expect(state.seenWorking).toBe(true);

	// And it ends when omp is idle again, with the time the turn took.
	const done = poll(state, idlePoll, 103.4);
	expect(done.update.ended).toBe(true);
	expect(done.update.endedUnseen).toBe(false);
});

test("the time a turn is recorded with stays within the turn, over a long run of turns (#471)", () => {
	// The bound the issue asks for: the time the harness records for a turn follows the turn, in the first and the
	// last ten minutes alike. A turn that was seen working is recorded with the time it took — never with the
	// grace, and never with a time that grows with the number of turns before it.
	const recorded: number[] = [];
	let state: TurnState = { ...NO_TURN };
	// The turns of a three-hour run: 400 of them, two seconds each, every two seconds.
	for (let turn = 1; turn <= 400; turn++) {
		const sentAt = turn * 2;
		state = armTurn(state, sentAt);
		// The turn is seen working, and it ends.
		const seen = poll(state, working, sentAt + 0.4);
		expect(seen.update.started).toBe(true);
		state = seen.state;
		const done = poll(state, idle, sentAt + 2.4);
		expect(done.update.ended).toBe(true);
		expect(done.update.endedUnseen).toBe(false);
		recorded.push((sentAt + 2.4 - state.sentAt) * 1000);
		state = done.state;
	}
	const first = recorded.slice(0, 100);
	const last = recorded.slice(-100);
	const median = (a: number[]): number => {
		const s = [...a].sort((x, y) => x - y);
		return s[Math.floor(s.length / 2)];
	};
	// Every turn is recorded with about the time it took (2.4 s: from the send to the poll that saw the end), in
	// the first and in the last hundred alike.
	expect(median(first)).toBeCloseTo(2400, -2);
	expect(median(last)).toBeCloseTo(2400, -2);
	// And none of them is the grace.
	expect(recorded.filter((ms) => ms >= PROMPT_GRACE_S * 1000)).toEqual([]);
});

test("a turn omp started on its own keeps the conversation busy (#517)", () => {
	// omp began working with no prompt of the harness in flight: a background job or a subagent finished. The
	// conversation is busy all the same: the harness must not send it a prompt or a goal, and the watcher must
	// keep looking at it every 300 ms.
	const seen = poll(NO_TURN, working, 50);
	expect(seen.state.onItsOwn).toBe(true);
	expect(seen.state.seenWorking).toBe(true);
	// Its `sentAt` stays 0: no prompt of the harness is in flight, so the turn is not the harness's.
	expect(seen.state.sentAt).toBe(0);
	// The conversation is busy all the same.
	expect(isBusy(seen.state)).toBe(true);
});

test("a turn omp started on its own keeps its marker while it goes on (#517)", () => {
	// A second poll that sees omp still working must not lose the marker of the own turn: it would then be
	// booked as the turn of a prompt (whose `sentAt` is 0, so its time would be the time since the epoch).
	const first = poll(NO_TURN, working, 50);
	const second = poll(first.state, working, 51);
	expect(second.state.onItsOwn).toBe(true);
	expect(second.state.sentAt).toBe(0);

	// And it ends as an own turn, counted apart.
	const done = poll(second.state, idle, 52);
	expect(done.update.ended).toBe(true);
	expect(done.update.endedOnItsOwn).toBe(true);
});

test("a prompt of the harness is not booked as a turn omp started on its own (#517)", () => {
	// omp was working on a turn of its own, and the harness sends a prompt: the prompt's turn is the harness's
	// turn, not omp's own.
	const own = poll(NO_TURN, working, 50).state;
	const armed = armTurn(own, 51);
	expect(armed.onItsOwn).toBe(false);
	expect(armed.seenWorking).toBe(true);
	// And it ends as the harness's turn.
	const done = poll(armed, idle, 53);
	expect(done.update.ended).toBe(true);
	expect(done.update.endedOnItsOwn).toBe(false);
	expect(done.update.endedUnseen).toBe(false);
});

test("a conversation is busy while a prompt of the harness is in flight (#517)", () => {
	const state = armTurn(NO_TURN, 100);
	expect(isBusy(state)).toBe(true);
});

test("a conversation is idle once its turn is over (#517)", () => {
	const seen = poll(NO_TURN, working, 50);
	const done = poll(seen.state, idle, 52);
	expect(done.update.ended).toBe(true);
	expect(isBusy(done.state)).toBe(false);
});

test("a send that did not happen leaves no turn armed (#518)", () => {
	// The harness arms a turn before the prompt is sent, so a poll that sees omp working while the send step is
	// still running does not lose the turn. A send that then fails must not leave the turn armed: nothing was
	// sent, and the harness would book a phantom turn of the grace.
	const before: TurnState = { ...NO_TURN };
	const armed = armTurn(before, 100);
	expect(isBusy(armed)).toBe(true);

	// The send failed: the turn is disarmed, and the conversation is idle again.
	const after = disarmTurn(before);
	expect(after.sentAt).toBe(0);
	expect(isBusy(after)).toBe(false);
});

test("a failed send keeps the marker of a turn that was already seen working (#518)", () => {
	// A turn omp was seen working on keeps its marker: the failed send is about another prompt, and the turn in
	// flight is the one the harness is timing.
	const working2 = poll(NO_TURN, working, 50).state;
	// The prompt is armed (and so the send may be sent into the turn), and the send then fails.
	armTurn(working2, 100);
	const after = disarmTurn(working2);
	expect(after.seenWorking).toBe(true);
	expect(after.onItsOwn).toBe(true);
	expect(isBusy(after)).toBe(true);
});

test("a failed send of a prompt sent into a turn omp started on its own keeps that turn (#518)", () => {
	// The conversation was busy with a turn of omp's own, the harness sent a prompt into it, and the send failed.
	// The own turn is still the conversation's turn: it is not booked as the harness's.
	const own = poll(NO_TURN, working, 50).state;
	const armed = armTurn(own, 100);
	expect(armed.onItsOwn).toBe(false);
	const after = disarmTurn(own);
	expect(after.onItsOwn).toBe(true);
	expect(after.seenWorking).toBe(true);
	expect(isBusy(after)).toBe(true);
});

test("a failed send of a prompt that was never sent books no turn (#518)", () => {
	// The whole cycle: a prompt is armed, the send fails, and the polls that follow find the conversation idle.
	// No turn is booked: the harness would otherwise count a phantom turn of the grace.
	let state: TurnState = { ...NO_TURN };
	const before = { ...state };
	state = armTurn(state, 100);
	state = disarmTurn(before);

	const ended: boolean[] = [];
	for (const now of [100.5, 103, 106, 110, 120]) {
		const p = poll(state, idlePoll, now);
		ended.push(p.update.ended);
		state = p.state;
	}
	expect(ended.every((e) => e === false)).toBe(true);
	expect(isBusy(state)).toBe(false);
});
