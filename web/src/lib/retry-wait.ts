import type { LiveInfo } from "@shared/protocol.ts";
import { isUsageLimitError, RETRY_OVERDUE_MS } from "@shared/retry.ts";

/** omp backing off before it retries a failed turn: what it announced (`auto_retry_start`), and how far the page has seen it go. */
export interface RetryWait {
	phase: "waiting";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	/** When the page was told of the wait (or, for a page that attached meanwhile, the server was, on this page's clock): the countdown runs from here. */
	startedAt: number;
	/** The failure was the provider's usage limit: the wait is for its quota to reset. */
	usageLimit: boolean;
	/** omp has started the retried turn (`agent_start`); the wait is over, its end frame still to come. */
	resumed: boolean;
	errorMessage?: string;
}

/**
 * Where omp's backoff stands, from what the page knows of it: `counting` down; `due`, the time is up and omp has just
 * to start; `running`, omp started the retried turn; or `overdue`, omp is more than `RETRY_OVERDUE_MS` past its own
 * time and has neither started the turn nor ended the retry (a timer that did not fire, a clock that jumped, a
 * stuck process): the page says so and offers to retry now. A paused conversation is frozen, so it is never overdue.
 * omp that was frozen retries what came due meanwhile the moment it runs again: the grace runs from `thawedAt`, when
 * the page saw it resumed, when that is later than the time omp announced.
 */
export type RetryPhase = "counting" | "due" | "running" | "overdue";

export function retryPhase(wait: RetryWait, now: number, paused = false, thawedAt = 0): RetryPhase {
	if (wait.resumed) return "running";
	const due = wait.startedAt + wait.delayMs;
	if (now <= due) return "counting";
	return now - Math.max(due, thawedAt) > RETRY_OVERDUE_MS && !paused ? "overdue" : "due";
}

/** Time left before omp retries, never negative. */
export function retryLeftMs(wait: RetryWait, now: number): number {
	return Math.max(0, wait.delayMs - (now - wait.startedAt));
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** The wait an `auto_retry_start` frame announces, as of `now`. */
export function waitFromFrame(f: Record<string, unknown>, now: number): RetryWait {
	return {
		phase: "waiting",
		attempt: num(f.attempt),
		maxAttempts: num(f.maxAttempts),
		delayMs: num(f.delayMs),
		startedAt: now,
		usageLimit: isUsageLimitError(f.errorId),
		resumed: false,
		errorMessage: typeof f.errorMessage === "string" ? f.errorMessage : undefined,
	};
}

/**
 * The wait the server holds for a process (`LiveInfo.retry`), for a page that attaches while omp is backing off; null
 * when there is none. The server stamped its start on its own clock: `offsetMs` (server's minus this page's, see
 * `serverOffsetMs`) brings it onto this page's, which is what the countdown and the overdue limit are measured on.
 */
export function waitFromInfo(info: LiveInfo, offsetMs: number): RetryWait | null {
	const r = info.retry;
	if (!r) return null;
	return {
		phase: "waiting",
		attempt: r.attempt,
		maxAttempts: r.maxAttempts,
		delayMs: r.delayMs,
		startedAt: r.startedAt - offsetMs,
		usageLimit: r.usageLimit,
		// Not `info.streaming`: omp reports a turn in progress for the whole backoff.
		resumed: r.resumed,
	};
}

/**
 * How far apart the start of the same wait may be as the page heard of it (when its frame arrived) and as the server
 * stamped it (when it did, on a clock corrected by what a `hello` took to arrive): the delivery of a frame and the error
 * of that correction. Waits apart by more than this are two waits.
 */
const SAME_WAIT_MS = 5000;

/** Whether two descriptions of omp's backoff are of the same one: the same attempt, delay, and start (within `SAME_WAIT_MS`). */
export function sameWait(a: RetryWait, b: RetryWait): boolean {
	return (
		a.attempt === b.attempt &&
		a.maxAttempts === b.maxAttempts &&
		a.delayMs === b.delayMs &&
		Math.abs(a.startedAt - b.startedAt) <= SAME_WAIT_MS
	);
}
