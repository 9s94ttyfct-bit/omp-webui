import { expect, test } from "bun:test";
import type { LiveInfo, OmpFrame, SessionEntry } from "../../shared/protocol.ts";
import { messageOf } from "../../web/src/lib/messages.ts";
import { applyFrame, initialLive, type LiveState } from "../../web/src/store/live.ts";

/** What the chat shows of omp's retries, compactions and command output, folded from the frames omp sends. */

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

const failed = (id: string): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 slow down" },
});

const retryStart: OmpFrame = {
	type: "auto_retry_start",
	attempt: 1,
	maxAttempts: 3,
	delayMs: 4000,
	errorMessage: "429 slow down",
};

test("command output loses the terminal escape sequences omp writes into it", () => {
	const s = fold([{ type: "command_output", text: "Used \u001b[38;2;0;180;255m11%\u001b[39m of the window" }]);
	expect(s.commandOutput.map((c) => c.text)).toEqual(["Used 11% of the window"]);
});

test("a retry waits with its attempt, limit and delay until omp reports how it ended", () => {
	const s = fold([retryStart]);
	expect(s.retry).toMatchObject({
		phase: "waiting",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 4000,
		errorMessage: "429 slow down",
		startedAt: expect.any(Number),
	});
});

test("a retry that recovered marks the failed message as recovered, so it renders as a note and not as an error", () => {
	const recovery = { kind: "auto-retry", status: "recovered", attempt: 1, note: "rate-limited; retried" };
	const before = { ...initialLive(info), entries: [failed("a"), failed("b")] };
	const end: OmpFrame = {
		type: "auto_retry_end",
		success: true,
		attempt: 1,
		retryErrors: [{ entryId: "b", note: "rate-limited; retried", retryRecovery: recovery }],
	};
	const s = fold([retryStart, end], before);
	expect(s.retry).toBeNull();
	expect(messageOf(s.entries[1])?.retryRecovery).toEqual(recovery);
	// The other failure, and the entry object itself, are left alone.
	expect(messageOf(s.entries[0])?.retryRecovery).toBeUndefined();
	expect(s.entries[0]).toBe(before.entries[0]);
});

test("a retry that gave up or was cancelled says so until the next turn starts", () => {
	const s = fold([retryStart, { type: "auto_retry_end", success: false, attempt: 3, finalError: "Retry cancelled" }]);
	expect(s.retry).toEqual({ phase: "failed", attempt: 3, finalError: "Retry cancelled" });
	expect(fold([{ type: "agent_start" }], s).retry).toBeNull();
});

test("compaction is in progress between its start and end frames", () => {
	const started = fold([{ type: "auto_compaction_start", reason: "threshold", action: "context-full" }]);
	expect(started.compacting).toEqual({ reason: "threshold", action: "context-full" });
	const ended = fold([{ type: "auto_compaction_end", action: "context-full", aborted: false }], started);
	expect(ended.compacting).toBeNull();
});

test("when omp settles, a retry or compaction whose end frame never arrived is not left showing", () => {
	const stuck = fold([retryStart, { type: "auto_compaction_start", reason: "threshold", action: "context-full" }]);
	const settled = fold([{ type: "session_settled" }], stuck);
	expect(settled.retry).toBeNull();
	expect(settled.compacting).toBeNull();
});

/**
 * What omp 18.12.2 sent when the failures of two turns overlapped (two messages queued during a usage-limit wait, then
 * `abort_retry` ran them one after another), measured against the real process: the first wait is cancelled, both
 * turns fail, the second failure's handler resets the first's counter, omp says it is idle, and then announces a wait
 * (attempt 0) it sleeps through and never keeps: at its end `agent.continue skipped … should-continue-false`, no request,
 * no `auto_retry_end`.
 */
const lostRetry: OmpFrame[] = [
	{
		type: "auto_retry_start",
		attempt: 1,
		maxAttempts: 10,
		delayMs: 139_952,
		errorId: 659_456,
		errorMessage: "429 limit",
	},
	{ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
	{ type: "agent_end", isTerminal: false },
	{ type: "agent_start" },
	{
		type: "auto_retry_start",
		attempt: 1,
		maxAttempts: 10,
		delayMs: 131_321,
		errorId: 659_456,
		errorMessage: "429 limit",
	},
	{ type: "agent_start" },
	{ type: "auto_retry_end", success: false, attempt: 2, finalError: "429 limit retry-after-ms=131321" },
	{ type: "agent_end", isTerminal: true },
	{ type: "session_settled" },
	{
		type: "auto_retry_start",
		attempt: 0,
		maxAttempts: 10,
		delayMs: 130_895,
		errorId: 659_456,
		errorMessage: "429 limit",
	},
];

test("a wait omp announces after it reported itself idle is not counted down to: it lost the retry, and says the turn failed", () => {
	const s = fold(lostRetry);
	expect(s.retry).toEqual({ phase: "failed", attempt: 2, finalError: "429 limit retry-after-ms=131321" });
	// The next turn clears what is left of it, as after any retry that gave up.
	expect(fold([{ type: "agent_start" }], s).retry).toBeNull();
});

test("a wait announced after a turn started is kept, whatever omp reported before it", () => {
	const s = fold([
		{ type: "session_settled" },
		{ type: "agent_start" },
		{ type: "agent_end", isTerminal: false },
		retryStart,
	]);
	expect(s.settled).toBe(false);
	expect(s.retry).toMatchObject({ phase: "waiting", attempt: 1 });
});

const failedReply: OmpFrame = {
	type: "message_end",
	messageId: "m1",
	message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 bad key" },
};
const promptFailed = (message: string): OmpFrame => ({ type: "prompt_result", status: "error", error: { message } });

test("a failure that is already on screen as the failed message does not get a second box", () => {
	expect(fold([failedReply, promptFailed("401 bad key")]).lastError).toBeNull();
	// The same once the failed message is in the saved entries and no longer in the stream.
	const saved = { ...initialLive(info), entries: [failed("a")] };
	expect(fold([promptFailed("429 slow down")], saved).lastError).toBeNull();
});

test("a failure that left no message, or says something else, still gets its box", () => {
	expect(fold([promptFailed("No API key for anthropic")]).lastError).toBe("No API key for anthropic");
	expect(fold([failedReply, promptFailed("something else")]).lastError).toBe("something else");
	// A message that went well is no explanation for a failure.
	const fine: OmpFrame = { ...failedReply, message: { role: "assistant", content: [], stopReason: "stop" } };
	expect(fold([fine, promptFailed("401 bad key")]).lastError).toBe("401 bad key");
});
