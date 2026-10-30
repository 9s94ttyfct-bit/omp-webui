import { expect, test } from "bun:test";
import type { LiveInfo, LiveRetry } from "../../shared/protocol.ts";
import { RETRY_OVERDUE_MS, USAGE_LIMIT_FLAG } from "../../shared/retry.ts";
import { type RetryWait, retryLeftMs, retryPhase, waitFromFrame, waitFromInfo } from "../../web/src/lib/retry-wait.ts";
import { noteServerTime, serverOffsetMs } from "../../web/src/lib/server-clock.ts";
import { applyFrame, initialLive, reconcileRetry } from "../../web/src/store/live.ts";

/**
 * The page's view of omp's own retry backoff: the countdown, when it is over, and when omp is overdue (the time is up
 * by more than RETRY_OVERDUE_MS and omp has neither started the retried turn nor ended the retry).
 */

const info = (extra: Partial<LiveInfo> = {}): LiveInfo => ({
	liveId: "L1",
	pid: 1,
	cwd: "/w",
	sessionFile: null,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 0,
	pausedAt: null,
	mode: "full",
	...extra,
});

const START = 1_000_000;
const start = (extra: Record<string, unknown> = {}) =>
	waitFromFrame(
		{
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 60_000,
			errorId: USAGE_LIMIT_FLAG | 0x1000,
			...extra,
		},
		START,
	);

test("a wait counts down, is due when the time is up, and overdue only after the grace past it", () => {
	const wait = start();
	expect(wait.usageLimit).toBe(true);
	expect(retryPhase(wait, START)).toBe("counting");
	expect(retryLeftMs(wait, START + 15_000)).toBe(45_000);
	expect(retryPhase(wait, START + 59_999)).toBe("counting");
	expect(retryPhase(wait, START + 60_000)).toBe("counting");
	expect(retryPhase(wait, START + 60_001)).toBe("due");
	expect(retryLeftMs(wait, START + 90_000)).toBe(0);
	expect(retryPhase(wait, START + 60_000 + RETRY_OVERDUE_MS)).toBe("due");
	expect(retryPhase(wait, START + 60_000 + RETRY_OVERDUE_MS + 1)).toBe("overdue");
});

test("a retry the failure of which was not the usage limit says so", () => {
	expect(start({ errorId: 0x1000 }).usageLimit).toBe(false);
	expect(start({ errorId: undefined }).usageLimit).toBe(false);
});

test("a paused conversation is frozen, so it is never overdue; omp running the retried turn is never either", () => {
	const wait = start();
	const late = START + 60_000 + RETRY_OVERDUE_MS + 10_000;
	expect(retryPhase(wait, late, true)).toBe("due");
	expect(retryPhase({ ...wait, resumed: true }, late)).toBe("running");
});

test("agent_start after the wait is omp's retried turn: resumed, never overdue; auto_retry_end clears it", () => {
	let s = initialLive(info());
	s = applyFrame(s, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorId: USAGE_LIMIT_FLAG });
	expect(s.retry).toMatchObject({ phase: "waiting", usageLimit: true, resumed: false });
	s = applyFrame(s, { type: "agent_start" });
	expect(s.retry).toMatchObject({ phase: "waiting", resumed: true });
	if (s.retry?.phase !== "waiting") throw new Error("no wait");
	expect(retryPhase(s.retry, s.retry.startedAt + 24 * 3600_000)).toBe("running");
	s = applyFrame(s, { type: "auto_retry_end", success: true, attempt: 1 });
	expect(s.retry).toBeNull();
});

test("a page that attaches during the wait shows it from what the server holds, and one that missed an end drops it", () => {
	const held = info({
		retry: { attempt: 2, maxAttempts: 5, delayMs: 600_000, startedAt: START, usageLimit: true, resumed: false },
	});
	expect(waitFromInfo(held, 0)).toMatchObject({
		phase: "waiting",
		attempt: 2,
		delayMs: 600_000,
		startedAt: START,
		resumed: false,
	});
	expect(waitFromInfo(info(), 0)).toBeNull();
	// omp reports a turn in progress for the whole backoff: that is not the retried turn, the wait is still going on.
	expect(waitFromInfo({ ...held, streaming: true }, 0)?.resumed).toBe(false);
	expect(retryPhase(waitFromInfo({ ...held, streaming: true }, 0) as RetryWait, START + 1000)).toBe("counting");
	// What the server says is the retried turn is.
	const running = { ...held, retry: { ...(held.retry as LiveRetry), resumed: true } };
	expect(waitFromInfo(running, 0)?.resumed).toBe(true);

	const attached = initialLive(held);
	expect(attached.retry).toMatchObject({ phase: "waiting", usageLimit: true });
	// Frames missed meanwhile: the server says omp is not backing off any more.
	expect(reconcileRetry(attached, info()).retry).toBeNull();
	// Or says it began to, and the page never heard.
	expect(reconcileRetry(initialLive(info()), held).retry).toMatchObject({ phase: "waiting", attempt: 2 });
	// What the page saw by frames is kept while the server agrees.
	const seen = applyFrame(attached, { type: "agent_start" });
	expect(reconcileRetry(seen, running)).toBe(seen);
	// The server says the retried turn has started, which the page missed.
	expect(reconcileRetry(attached, running).retry).toMatchObject({ phase: "waiting", resumed: true });
	// A retry that gave up is the page's to show until the next turn: the server holds no wait for it.
	const failed = applyFrame(attached, {
		type: "auto_retry_end",
		success: false,
		attempt: 2,
		finalError: "Retry cancelled",
	});
	expect(reconcileRetry(failed, info())).toBe(failed);
});

/** What the server holds of a backoff that began at `startedAt` on its own clock. */
const holding = (extra: Partial<LiveRetry>, streaming = true): LiveInfo =>
	info({
		streaming,
		retry: {
			attempt: 1,
			maxAttempts: 3,
			delayMs: 60_000,
			startedAt: START,
			usageLimit: false,
			resumed: false,
			...extra,
		},
	});

test("a reconnect that missed the next attempt replaces the page's stale one with the server's, which is not overdue", () => {
	// The page saw attempt 1 begin, then lost the connection; attempt 2 began and its backoff is still running.
	const stale = applyFrame(initialLive(info()), {
		type: "auto_retry_start",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 60_000,
	});
	if (stale.retry?.phase !== "waiting") throw new Error("no wait");
	const later = stale.retry.startedAt + 120_000;
	expect(retryPhase(stale.retry, later)).toBe("overdue");

	const fresh = holding({ attempt: 2, startedAt: later - 5_000 });
	const healed = reconcileRetry(stale, fresh, 0);
	if (healed.retry?.phase !== "waiting") throw new Error("no wait");
	expect(healed.retry).toMatchObject({ attempt: 2, delayMs: 60_000, startedAt: later - 5_000 });
	expect(retryPhase(healed.retry, later)).toBe("counting");
	expect(retryLeftMs(healed.retry, later)).toBe(55_000);

	// The same attempt begun again (the wait of attempt 1 ended and omp's next saga began at 1): a different start, so a different wait.
	const again = holding({ startedAt: later - 5_000 });
	expect(reconcileRetry(stale, again, 0).retry).toMatchObject({ attempt: 1, startedAt: later - 5_000 });
	// Another delay is another wait too.
	expect(reconcileRetry(stale, holding({ delayMs: 120_000, startedAt: stale.retry.startedAt }), 0).retry).toMatchObject(
		{
			delayMs: 120_000,
		},
	);

	// What the server and the page agree is one wait stays as the page has it: the delivery of a frame is no difference.
	const agreed = holding({ startedAt: stale.retry.startedAt + 800 });
	expect(reconcileRetry(stale, agreed, 0)).toBe(stale);
});

test("a wait the server stamped is read on the page's own clock: a phone minutes off from the Mac neither shortens the countdown nor says overdue", () => {
	// The server began a one-minute backoff a moment ago. The page's clock is 9 minutes ahead of the server's.
	const AHEAD = 9 * 60_000;
	const held = holding({ delayMs: 60_000, startedAt: START, usageLimit: true });
	const offset = START - (START + AHEAD); // the server's clock minus the page's, as a hello measures it
	const wait = waitFromInfo(held, offset) as RetryWait;
	const now = START + AHEAD + 1_000; // the page's clock, a second after the server's stamp
	expect(retryLeftMs(wait, now)).toBe(59_000);
	expect(retryPhase(wait, now)).toBe("counting");
	// Read without the correction the wait would be 9 minutes over: omp "has not retried" a second into the backoff.
	const raw = waitFromInfo(held, 0) as RetryWait;
	expect(retryLeftMs(raw, now)).toBe(0);
	expect(retryPhase(raw, now)).toBe("overdue");
	// A page behind the server's clock by as much does not count 9 minutes more.
	const behind = waitFromInfo(held, AHEAD) as RetryWait;
	expect(retryLeftMs(behind, START - AHEAD + 1_000)).toBe(59_000);
	expect(retryLeftMs(raw, START - AHEAD + 1_000)).toBe(599_000);

	// The store reads it the same way: a page that attaches, and one that reconciles after a reconnect.
	expect((initialLive(held).retry as RetryWait).startedAt).toBe(START);
	const reconnected = reconcileRetry(initialLive(info()), held, offset);
	expect((reconnected.retry as RetryWait).startedAt).toBe(START + AHEAD);
});

test("a wait the page attaches to is measured on the clock the page has heard the server keep", () => {
	try {
		// The server's clock is ten minutes ahead of this page's as the connection opened.
		noteServerTime(START + 600_000, START);
		expect(serverOffsetMs()).toBe(600_000);
		const wait = initialLive(holding({ startedAt: START + 600_000 })).retry as RetryWait;
		// It began just now, as this page's clock has it.
		expect(wait.startedAt).toBe(START);
		expect(retryPhase(wait, START + 1_000)).toBe("counting");
	} finally {
		noteServerTime(0, 0);
	}
});

test("only omp's own session_settled marks a later wait as lost; idle read from its state on attach does not", () => {
	const retryFrame = { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 60_000, errorMessage: "429" };
	// The page attached to an idle conversation and read get_state.isSettled: a turn can still start and fail after that.
	const attached = { ...initialLive(info()), settled: true };
	expect(applyFrame(attached, retryFrame).retry).toMatchObject({ phase: "waiting" });
	// omp said it settled, then announced a wait without a turn in between: the wait omp 18.12 loses.
	const announced = applyFrame(initialLive(info()), { type: "session_settled" });
	expect(applyFrame(announced, retryFrame).retry).toBeNull();
	// A turn that started after that announcement makes its wait real again.
	const restarted = applyFrame(announced, { type: "agent_start" });
	expect(applyFrame(restarted, retryFrame).retry).toMatchObject({ phase: "waiting" });
});

test("an omp that was frozen gets its grace from the moment it runs again: what came due meanwhile is retried at once, not overdue", () => {
	const wait: RetryWait = start();
	const due = wait.startedAt + wait.delayMs;
	const thawed = due + 3_600_000;
	// Frozen: due, never overdue. Just resumed: still due, as omp retries what is past at once.
	expect(retryPhase(wait, thawed - 1000, true, 0)).toBe("due");
	expect(retryPhase(wait, thawed + 1000, false, thawed)).toBe("due");
	expect(retryPhase(wait, thawed + RETRY_OVERDUE_MS, false, thawed)).toBe("due");
	// It has not retried half a minute after it ran again: now it is overdue.
	expect(retryPhase(wait, thawed + RETRY_OVERDUE_MS + 1, false, thawed)).toBe("overdue");
	// A resume before the time came changes nothing; none at all is the old rule.
	expect(retryPhase(wait, due + RETRY_OVERDUE_MS + 1, false, wait.startedAt)).toBe("overdue");
	expect(retryPhase(wait, due + RETRY_OVERDUE_MS + 1)).toBe("overdue");
});
