import { expect, test } from "bun:test";
import type { OmpFrame } from "../../shared/protocol.ts";
import { USAGE_LIMIT_FLAG } from "../../shared/retry.ts";
import { retryPhase } from "../../web/src/lib/retry-wait.ts";
import { noteServerTime } from "../../web/src/lib/server-clock.ts";
import { applySubagentFrame, mergeSnapshot } from "../../web/src/store/subagents-live.ts";

/**
 * A subagent that hits the provider's usage limit sits in omp's backoff for hours, like the conversation itself
 * (omp's `retry.waitForUsageReset` holds subagent turns too): its `auto_retry_*` frames arrive inside `subagent_event`,
 * and its progress record carries the wait for a tab that attached meanwhile.
 */

const NOW = 5_000_000;
const event = (e: Record<string, unknown>): OmpFrame => ({
	type: "subagent_event",
	payload: { id: "Scout", event: e },
});
const start: OmpFrame = event({
	type: "auto_retry_start",
	attempt: 2,
	maxAttempts: 10,
	delayMs: 3_600_000,
	errorId: USAGE_LIMIT_FLAG,
});

test("a subagent's backoff is its wait: counting, then the retried turn, then nothing", () => {
	let subs = applySubagentFrame({}, start, NOW);
	expect(subs.Scout.retry).toMatchObject({
		phase: "waiting",
		attempt: 2,
		usageLimit: true,
		resumed: false,
		startedAt: NOW,
	});
	if (subs.Scout.retry?.phase !== "waiting") throw new Error("no wait");
	expect(retryPhase(subs.Scout.retry, NOW + 1000)).toBe("counting");

	subs = applySubagentFrame(subs, event({ type: "agent_start" }), NOW + 3_600_000);
	expect(subs.Scout.retry).toMatchObject({ resumed: true });
	subs = applySubagentFrame(subs, event({ type: "auto_retry_end", success: true, attempt: 2 }), NOW + 3_700_000);
	expect(subs.Scout.retry).toBeNull();

	// An agent_start with no wait pending marks nothing; a run that ends waits for nothing.
	expect(applySubagentFrame({}, event({ type: "agent_start" }), NOW).Scout.retry).toBeUndefined();
	const over = applySubagentFrame(
		applySubagentFrame({}, start, NOW),
		{ type: "subagent_lifecycle", payload: { id: "Scout", status: "aborted" } },
		NOW + 1000,
	);
	expect(over.Scout.retry).toBeNull();
});

test("a tab that attaches mid-wait gets it from the subagent's progress; the wait the events told of keeps its usage-limit flag", () => {
	const progress = (extra: Record<string, unknown> = {}) => ({
		id: "Scout",
		status: "running",
		progress: {
			id: "Scout",
			status: "running",
			retryState: { attempt: 2, maxAttempts: 10, delayMs: 3_600_000, startedAtMs: NOW - 60_000, ...extra },
		},
	});
	const attached = mergeSnapshot({}, [progress()], NOW);
	expect(attached.Scout.retry).toMatchObject({
		phase: "waiting",
		attempt: 2,
		maxAttempts: 10,
		delayMs: 3_600_000,
		startedAt: NOW - 60_000,
	});

	// Frames and the snapshot describe the same wait: the frames' (with the flag) stands.
	const seen = applySubagentFrame({}, start, NOW - 60_000);
	expect(mergeSnapshot(seen, [progress()], NOW).Scout.retry).toBe(seen.Scout.retry);

	// omp stamps its own clock, which is the server's: read on this page's.
	try {
		noteServerTime(NOW + 600_000, NOW);
		expect(mergeSnapshot({}, [progress()], NOW).Scout.retry).toMatchObject({ startedAt: NOW - 60_000 - 600_000 });
	} finally {
		noteServerTime(0, 0);
	}

	// A subagent the registry no longer lists has ended, and waits for nothing.
	expect(mergeSnapshot(attached, [], NOW + 1000).Scout.retry).toBeNull();
});

test("omp's registry is the truth about a wait: a subagent it lists with no retryState is not waiting, whatever the page held", () => {
	// The page saw the wait begin and never saw it end (the socket dropped, a retry omp reported only in its record).
	const seen = applySubagentFrame({}, start, NOW);
	expect(seen.Scout.retry).toMatchObject({ phase: "waiting" });
	const running = { id: "Scout", status: "running", progress: { id: "Scout", status: "running" } };
	expect(mergeSnapshot(seen, [running], NOW + 4_000_000).Scout.retry).toBeNull();

	// A registry entry with no progress record says nothing about waits (older omp): what the page held stands.
	expect(mergeSnapshot(seen, [{ id: "Scout", status: "running" }], NOW + 4_000_000).Scout.retry).toBe(seen.Scout.retry);

	// A wait the registry does describe is kept as it was (same attempt and delay), and a new attempt replaces it.
	const waiting = (attempt: number) => ({
		...running,
		progress: { ...running.progress, retryState: { attempt, maxAttempts: 10, delayMs: 3_600_000, startedAtMs: NOW } },
	});
	expect(mergeSnapshot(seen, [waiting(2)], NOW + 1000).Scout.retry).toBe(seen.Scout.retry);
	expect(mergeSnapshot(seen, [waiting(3)], NOW + 1000).Scout.retry).toMatchObject({ attempt: 3 });
});

test("the retried turn that writes or runs a tool is no longer Retrying, though omp ends the retry only with that turn", () => {
	const thinking = event({
		type: "message_update",
		assistantMessageEvent: {
			type: "thinking_delta",
			partial: { role: "assistant", content: [{ type: "thinking", thinking: "Let me look" }], timestamp: NOW },
		},
	});
	const resumed = applySubagentFrame(
		applySubagentFrame({}, start, NOW),
		event({ type: "agent_start" }),
		NOW + 3_600_000,
	);
	expect(resumed.Scout.retry).toMatchObject({ resumed: true });
	// Its first thought ends the label, before any tool call and before omp's auto_retry_end.
	const writing = applySubagentFrame(resumed, thinking, NOW + 3_601_000);
	expect(writing.Scout.retry).toBeNull();
	// omp's record still carries the wait it got past until the turn ends: a progress frame does not bring it back.
	const progress: OmpFrame = {
		type: "subagent_progress",
		payload: {
			id: "Scout",
			progress: {
				id: "Scout",
				status: "running",
				retryState: { attempt: 2, maxAttempts: 10, delayMs: 3_600_000, startedAtMs: NOW },
			},
		},
	};
	expect(applySubagentFrame(writing, progress, NOW + 3_602_000).Scout.retry).toBeNull();
	expect(mergeSnapshot(writing, [progress.payload as never], NOW + 3_602_000).Scout.retry).toBeNull();
	// A tool call ends it the same way, and a new wait (another failure) is a wait again.
	const tool = event({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
	expect(applySubagentFrame(resumed, tool, NOW + 3_601_000).Scout.retry).toBeNull();
	const again = applySubagentFrame(writing, start, NOW + 3_700_000);
	expect(again.Scout.retry).toMatchObject({ phase: "waiting", attempt: 2 });
	expect(applySubagentFrame(again, progress, NOW + 3_700_500).Scout.retry).toMatchObject({ phase: "waiting" });
});
