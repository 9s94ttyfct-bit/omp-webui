import type { ToolExec } from "../store/live.ts";
import type { AgentMessage } from "./messages.ts";
import type { ToolTimerMode } from "./tool-timer.ts";

/**
 * How long a tool call ran (#657), from what the page holds of it. Pure: the card that shows it passes in what it has.
 *
 * A call that is still running has a start (`since`, on this page's clock) and its time ticks. A call that is over has a
 * length, from the best of what is known, in this order:
 *
 * 1. `details.wallTimeMs` on its result, which omp's `bash` tool measures itself (and sends on its end frame too);
 * 2. the page's own measure, when it saw the call start and end (`ToolExec.startedAt` to `endedAt`);
 * 3. the result's `timestamp` less the `completedAt` of the assistant message that made the call: the saved record of a
 *    call the page did not watch. It is the time from the model finishing writing the call to its result being written, so
 *    for calls that wait for each other it is more than that call's own run: an upper bound, and the only figure a
 *    conversation read from its file has.
 *
 * No figure is made up: a call that has none (a result with no timestamps, a call the page heard only the end of) has no timer.
 */

export type ToolTimer = { state: "running"; since: number } | { state: "done"; ms: number };

/** The tools whose timer shows when only shell commands are wanted (`ompw.toolTimer` = `shell`). */
const SHELL_TOOLS: Readonly<Record<string, true>> = { bash: true };

/** Whether the mode wants a timer on a call of this tool. */
export function timerWanted(mode: ToolTimerMode, tool: string): boolean {
	return mode === "all" || (mode === "shell" && SHELL_TOOLS[tool] === true);
}

const isMs = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** `wallTimeMs` of a result's `details`, when it has a usable one. */
export function wallTimeMs(details: unknown): number | undefined {
	if (typeof details !== "object" || details === null || !("wallTimeMs" in details)) return undefined;
	return isMs(details.wallTimeMs) ? details.wallTimeMs : undefined;
}

export interface ToolTimerInput {
	/** The call's saved result. */
	result?: AgentMessage;
	/** What the page saw of the call run. */
	exec?: ToolExec;
	/** When the assistant message that made the call ended (`completedAt`), on omp's clock. */
	calledAt?: number;
	/** The server's clock minus this page's (`serverOffsetMs`): omp's times are the server's. */
	offsetMs?: number;
}

export function toolTimer({ result, exec, calledAt, offsetMs = 0 }: ToolTimerInput): ToolTimer | null {
	if (result || exec?.done) {
		// The end frame's result is `{ content, details }`, the saved one's `details` is the same.
		const live = exec?.result;
		const wall =
			wallTimeMs(result?.details) ??
			(typeof live === "object" && live !== null && "details" in live ? wallTimeMs(live.details) : undefined);
		if (wall !== undefined) return { state: "done", ms: wall };
		if (exec?.done && !exec.late && exec.endedAt !== undefined && exec.endedAt >= exec.startedAt)
			return { state: "done", ms: exec.endedAt - exec.startedAt };
		const saved = result?.timestamp;
		if (isMs(saved) && isMs(calledAt) && saved >= calledAt) return { state: "done", ms: saved - calledAt };
		return null;
	}
	if (!exec) return null;
	// A call the page did not see start has run since the model's message ended at the latest; the page's first word of it says nothing.
	if (exec.late) return isMs(calledAt) ? { state: "running", since: calledAt - offsetMs } : null;
	return { state: "running", since: exec.startedAt };
}

/**
 * When a call started, on this page's clock (#691): the page's own sight of its start, or else the end of the assistant
 * message that made it (`completedAt`, omp's clock): the moment the model finished writing the call, which is when it was
 * started. A call that has neither (still being written) has no start yet.
 */
export function toolStartedAt({
	exec,
	calledAt,
	offsetMs = 0,
}: Pick<ToolTimerInput, "exec" | "calledAt" | "offsetMs">): number | undefined {
	if (exec && !exec.late) return exec.startedAt;
	return isMs(calledAt) ? calledAt - offsetMs : undefined;
}
