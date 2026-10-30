/**
 * omp's words for the state of a subagent (`get_subagents`, `subagent_lifecycle`), as the page and the server both read them.
 */

/** The words for a subagent whose run is over. Anything else (started, running, pending…) is still going. */
const OVER: Record<string, true> = {
	completed: true,
	done: true,
	aborted: true,
	failed: true,
	error: true,
	cancelled: true,
};

/** A kept-alive subagent between two runs: it holds nothing up and has nothing for Stop to end. */
const BETWEEN_RUNS: Record<string, true> = { idle: true, parked: true };

/** The subagent's run is over (its transcript may still be revived by a message). */
export function isOverStatus(status: string): boolean {
	return OVER[status] === true;
}

/** The subagent is doing something now: not over, and not waiting between runs. Stop ends these. */
export function isWorkingStatus(status: string): boolean {
	return !isOverStatus(status) && BETWEEN_RUNS[status] !== true;
}
