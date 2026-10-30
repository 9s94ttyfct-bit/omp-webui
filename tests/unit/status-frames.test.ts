import { expect, test } from "bun:test";
import type { LiveInfo, OmpFrame } from "../../shared/protocol.ts";
import { applyFrame, initialLive, type LiveState, type RpcState } from "../../web/src/store/live.ts";

/** The todo reminder and the outcome of an automatic compaction, folded from the frames omp sends (TUI parity). */

const info: LiveInfo = {
	liveId: "L1",
	pid: 1,
	cwd: "/",
	sessionFile: null,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};

const fold = (frames: OmpFrame[], from: LiveState = initialLive(info)): LiveState => frames.reduce(applyFrame, from);

const reminder: OmpFrame = {
	type: "todo_reminder",
	todos: [
		{ content: "Write the tests", status: "in_progress" },
		{ content: "Ship it", status: "pending" },
	],
	attempt: 1,
	maxAttempts: 3,
};

test("a todo reminder keeps the open todos and the attempt; unreadable todos are left out", () => {
	const s = fold([reminder]);
	expect(s.todoReminder).toEqual({
		todos: [
			{ content: "Write the tests", status: "in_progress", blocker: undefined },
			{ content: "Ship it", status: "pending", blocker: undefined },
		],
		attempt: 1,
		maxAttempts: 3,
		resumed: false,
	});
	expect(fold([{ type: "todo_reminder", todos: "nope", attempt: 2, maxAttempts: 3 }]).todoReminder?.todos).toEqual([]);
	expect(fold([{ type: "todo_reminder", todos: [{ status: "pending" }, null] }]).todoReminder?.todos).toEqual([]);
});

test("the reminder lasts through the turn it asks for, whichever way omp orders the frames", () => {
	// The usual order: the stop that was reminded is not the end (isTerminal false), then the turn it asked for runs.
	const asked = fold([reminder, { type: "agent_end", isTerminal: false }, { type: "agent_start" }]);
	expect(asked.todoReminder?.resumed).toBe(true);
	expect(fold([{ type: "agent_end", isTerminal: false }], asked).todoReminder).not.toBeNull();
	expect(fold([{ type: "agent_end" }], asked).todoReminder).toBeNull();
	expect(fold([{ type: "agent_end", isTerminal: true }], asked).todoReminder).toBeNull();
	// A reminder that came before a terminal end waits for the turn it asked for, not for that end.
	const early = fold([reminder, { type: "agent_end", isTerminal: true }]);
	expect(early.todoReminder).not.toBeNull();
	expect(fold([{ type: "agent_start" }, { type: "agent_end" }], early).todoReminder).toBeNull();
});

test("a reminder does not outlive the session going quiet", () => {
	expect(fold([{ type: "session_settled" }], fold([reminder])).todoReminder).toBeNull();
});

test("a list omp cleared is gone from the page at once, with its reminder", () => {
	const state = {
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "immediate",
		messageCount: 1,
		queuedMessageCount: 0,
		todoPhases: [{ name: "Build", tasks: [{ content: "a", status: "completed" }] }],
	} satisfies RpcState;
	const before: LiveState = { ...fold([reminder]), state };
	const s = fold([{ type: "todo_auto_clear" }], before);
	expect(s.state?.todoPhases).toEqual([]);
	expect(s.todoReminder).toBeNull();
	// Before any state has arrived there is nothing to clear, and nothing breaks.
	expect(fold([{ type: "todo_auto_clear" }]).state).toBeNull();
});

const start: OmpFrame = { type: "auto_compaction_start", reason: "overflow", action: "handoff" };
const end = (rest: Record<string, unknown>): OmpFrame => ({
	type: "auto_compaction_end",
	action: "context-full",
	aborted: false,
	willRetry: false,
	...rest,
});
const outcomeOf = (rest: Record<string, unknown>, from?: OmpFrame[]) =>
	fold([...(from ?? []), end(rest)]).compactionOutcome;

test("a compaction names its reason and action while it runs", () => {
	expect(fold([start]).compacting).toEqual({ reason: "overflow", action: "handoff" });
});

test("a compaction that ends leaves how it ended, and a new one clears it", () => {
	const done = fold([start, end({ result: { summary: "s", firstKeptEntryId: "e", tokensBefore: 183_000 } })]);
	expect(done.compacting).toBeNull();
	expect(done.compactionOutcome).toMatchObject({ kind: "completed", action: "context-full", tokensBefore: 183_000 });
	expect(fold([start], done).compactionOutcome).toBeNull();
});

test("the outcome says what the TUI says: cancelled, failed with omp's message, handoff completed", () => {
	expect(outcomeOf({ action: "handoff", aborted: true })).toMatchObject({ kind: "cancelled", action: "handoff" });
	expect(outcomeOf({ errorMessage: "model unavailable" })).toMatchObject({
		kind: "failed",
		message: "model unavailable",
	});
	expect(outcomeOf({ action: "handoff" })).toMatchObject({ kind: "completed", action: "handoff" });
	// A failure with nothing to say carries on without maintenance.
	expect(outcomeOf({ action: "remote" })).toMatchObject({ kind: "failed", action: "remote" });
	expect(outcomeOf({ action: "remote" })?.message).toBeUndefined();
	expect(outcomeOf({})).toMatchObject({ kind: "failed", action: "context-full" });
	// A result is the compaction itself, even when omp also names an error.
	expect(outcomeOf({ result: { summary: "s", firstKeptEntryId: "e", tokensBefore: 5 }, errorMessage: "x" })?.kind).toBe(
		"completed",
	);
});

test("a shake completes, fails with its message, or is skipped without a word", () => {
	expect(outcomeOf({ action: "shake" })).toMatchObject({ kind: "completed", action: "shake" });
	expect(outcomeOf({ action: "shake", errorMessage: "nothing to drop" })).toMatchObject({
		kind: "failed",
		message: "nothing to drop",
	});
	expect(outcomeOf({ action: "shake", skipped: true })).toBeNull();
	expect(outcomeOf({ skipped: true })).toBeNull();
});

test("an outcome is left alone when the process goes quiet", () => {
	const s = fold([start, end({ action: "handoff", aborted: true }), { type: "session_settled" }]);
	expect(s.compactionOutcome?.kind).toBe("cancelled");
});
