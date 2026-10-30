/**
 * omp's `AIError.Flag.UsageLimit` (pi-ai), set in the `errorId` of a failed assistant message and of the
 * `auto_retry_start` that follows it: the provider refused because the account's usage (a 5-hour or weekly quota, a
 * spend cap) is used up, so the retry waits for the quota to reset.
 */
export const USAGE_LIMIT_FLAG = 0x80000;

/** Whether an `errorId` says the failure was a usage limit. */
export function isUsageLimitError(errorId: unknown): boolean {
	return typeof errorId === "number" && (errorId & USAGE_LIMIT_FLAG) !== 0;
}

/**
 * How long past its announced time omp may take to start the retry before the page says it has not (the wait is a
 * timer inside omp's process; this covers its own latency and a sleep that wakes late).
 */
export const RETRY_OVERDUE_MS = 30_000;
