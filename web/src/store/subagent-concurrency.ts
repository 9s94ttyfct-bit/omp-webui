import { sessionActions } from "../lib/api.ts";
import { ompOverride } from "./omp-override.ts";

/**
 * How many subagents run at once ("Parallel subagents": omp's `task.maxConcurrency`, `0`: no limit) — omp's own value and
 * the limits single conversations chose (see `ompOverride`). A conversation's own limit is its overlay's, which omp
 * reloads by itself, so a change applies to the next subagent that starts.
 */
const concurrency = ompOverride<number, number, number | null>({
	get: (file) => sessionActions.concurrency(file),
	setDefault: (limit) => sessionActions.setConcurrency(limit),
	setSession: (file, limit) => sessionActions.setSessionConcurrency(file, limit),
	// null: omp's default again, which the server reads back.
	shownDefault: (limit) => limit ?? undefined,
});

export const useConcurrency = concurrency.use;
/** Set omp's own limit, as `omp config set` does (`0`: no limit); null: omp's default again, which the server reads back. */
export const setConcurrencyDefault = concurrency.setDefault;
/** `limit` null: the conversation follows omp's configuration again. */
export const setConversationConcurrency = concurrency.setConversation;
