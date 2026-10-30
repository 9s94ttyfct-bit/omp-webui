import { expect, test } from "bun:test";
import { stopKindOf } from "../../server/live.ts";
import { isOverStatus, isWorkingStatus } from "../../shared/subagent-status.ts";
import { ENDED, isOver, isWorking } from "../../web/src/lib/subagents.ts";

// What Stop carries through (`Live.stop`) and what it ends: the commands the page sends for it, and the subagents that work.

test("the page's abort commands are Stop, and nothing else that starts with abort is", () => {
	expect(stopKindOf({ type: "abort" })).toBe("turn");
	expect(stopKindOf({ type: "abort_and_restore_queue" })).toBe("turn");
	expect(stopKindOf({ type: "abort_bash" })).toBe("bash");
	// Cancel is the user ending a wait, Retry now and a message that aborts first are other acts: none ends omp's process.
	for (const type of ["abort_retry", "abort_and_prompt", "prompt", "cancel_subagent", "get_state"]) {
		expect(stopKindOf({ type })).toBeNull();
	}
	expect(stopKindOf({})).toBeNull();
});

test("a subagent that runs or waits to retry is working: it is what Stop cancels; one that is over or kept between runs is not", () => {
	for (const status of ["running", "started", "pending", "retrying"]) {
		expect(isWorkingStatus(status)).toBe(true);
		expect(isWorking(status)).toBe(true);
	}
	for (const status of ["completed", "done", "aborted", "failed", "error", "cancelled"]) {
		expect(isOverStatus(status)).toBe(true);
		expect(isWorkingStatus(status)).toBe(false);
		expect(isOver(status)).toBe(true);
	}
	// Between runs nothing is held up, so there is nothing for Stop to end (and cancelling it would only park it).
	for (const status of ["idle", "parked"]) {
		expect(isOverStatus(status)).toBe(false);
		expect(isWorkingStatus(status)).toBe(false);
	}
	// What the page calls a subagent whose end it missed is over for it, though omp never says it.
	expect(isOver(ENDED)).toBe(true);
	expect(isWorking(ENDED)).toBe(false);
});
