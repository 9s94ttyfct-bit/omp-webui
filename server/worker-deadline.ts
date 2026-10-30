/**
 * What a worker host does with a job its worker does not answer: the worker is terminated and the job fails with this, so a
 * request that waited for it gets an answer (`503`, see `family.ts`) and the next job starts a worker of its own.
 */
export class WorkerDeadlineError extends Error {
	constructor(who: string, ms: number) {
		super(
			`${who} gave no answer within ${ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`} and was stopped; try again`,
		);
		this.name = "WorkerDeadlineError";
	}
}

/** A deadline in milliseconds from an environment variable: unset, empty, not a number or not positive is `fallback`. */
export function deadlineFromEnv(value: string | undefined, fallback: number): number {
	const ms = Number(value);
	return value?.trim() && Number.isFinite(ms) && ms > 0 ? ms : fallback;
}
