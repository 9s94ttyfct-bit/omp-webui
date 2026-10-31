import { isRecord } from "./guards.ts";

/**
 * "Parallel subagents": how many subagents one omp process runs at once. It is omp's own setting `task.maxConcurrency`
 * (omp 18.14: a number, default 32, `0` for no limit), which every `task` call of a session waits on: a subagent beyond the
 * limit is queued by omp itself (a semaphore in its task tool) and starts when a running one ends. omp reads the setting each
 * time a subagent asks for a slot and when one gives its slot back, so a changed value applies to the next one that starts,
 * without a restart.
 *
 * The global value is omp's `config.yml`, as `omp config set` writes it; a conversation's own value is a line in its process's
 * `--config` overlay, which omp reloads by itself (see `server/omp/approval.ts`).
 */

/** omp's setting, by its key. */
export const CONCURRENCY_KEY = "task.maxConcurrency";

/** The most a choice of this page allows; omp itself takes any count. `0` is no limit. */
export const CONCURRENCY_MAX = 16;

/** omp's own default for the setting (its definition in omp 18.14), what a configuration that names none runs with. */
export const OMP_DEFAULT_CONCURRENCY = 32;

/** The counts the rows offer: 1 to `CONCURRENCY_MAX`, then no limit (`0`). */
export const CONCURRENCY_CHOICES: readonly number[] = [...Array.from({ length: CONCURRENCY_MAX }, (_, i) => i + 1), 0];

/** Whether `v` (a record from disk, or a page's request) is a limit this page can set: a whole number from 0 to `CONCURRENCY_MAX`. */
export function isConcurrency(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= CONCURRENCY_MAX;
}

/** `v` as a limit this page can set, or null: a value that is not one is never applied as a guess. */
export function concurrencyOf(v: unknown): number | null {
	return isConcurrency(v) ? v : null;
}

/**
 * omp's configured value as `omp config list --json` resolves it: any whole number from 0 up (`0`, and anything omp's own
 * semaphore reads as not positive, is no limit), or null when it is not one (omp then runs with its default).
 */
export function ompConcurrencyOf(v: unknown): number | null {
	if (typeof v !== "number" || !Number.isFinite(v)) return null;
	return Math.max(0, Math.trunc(v));
}

/**
 * A subagent omp has queued: its `task` call spawned it, and it waits for a slot under `task.maxConcurrency`. omp says so in
 * the progress of the call (`details.progress[i].status` is `pending`), which it goes on sending after the call returned for
 * the subagents it runs in the background; the subagent has no `subagent_lifecycle` frame and is in no `get_subagents` until
 * it starts.
 */
export interface QueuedSubagent {
	/** omp's id of the subagent, as it will start under (`Parent.Child` for one a subagent started). */
	id: string;
	/** The `task` call that spawned it. */
	parentToolCallId: string;
	/** Its place in that call's `tasks`. */
	index?: number;
	/** The agent definition it runs as (`task`, `scout`, …). */
	agent?: string;
	/** What it was asked to do. */
	assignment?: string;
	/** Since when it waits, on the server's clock. */
	since: number;
}

/** omp's word for a subagent of a call that has not started (the call's progress records). */
const PENDING = "pending";

/** One subagent of a `task` call's progress: its id, and whether it waits for a slot. */
export interface CallProgress {
	id: string;
	pending: boolean;
	index?: number;
	agent?: string;
	assignment?: string;
}

/**
 * The subagents a `task` call's details say anything of (`details.progress`, which omp sends while the call's subagents run,
 * and goes on sending for background ones after the call returned), each with whether it waits for a slot. Empty for a
 * result that is not a `task` call's.
 */
export function callProgress(details: unknown): CallProgress[] {
	if (!isRecord(details) || !Array.isArray(details.progress)) return [];
	return details.progress.flatMap((p: unknown): CallProgress[] => {
		if (!isRecord(p) || typeof p.id !== "string" || !p.id) return [];
		const assignment = typeof p.assignment === "string" ? p.assignment.trim() : "";
		return [
			{
				id: p.id,
				pending: p.status === PENDING,
				...(typeof p.index === "number" ? { index: p.index } : {}),
				...(typeof p.agent === "string" && p.agent ? { agent: p.agent } : {}),
				...(assignment ? { assignment } : {}),
			},
		];
	});
}
