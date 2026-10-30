import { type RetryWait, retryLeftMs, retryPhase } from "./retry-wait.ts";

/** A wait this long is a quota's reset, not a backoff: the time it ends at is worth saying, not only the time left. */
const CLOCK_TIME_MS = 10 * 60_000;

/**
 * What the Agents tab says of a subagent's wait at one moment: the countdown with the time omp retries at; that the time
 * is up and omp is on it (`retrying`, also while the retried turn runs); that the conversation is paused, so nothing can
 * run; or that omp is late and has not retried (`overdue`), which is where the tab used to say "Retrying…" for good.
 * `phase` is the stage as `RetryPhase` names it, or `paused`.
 */
export type SubagentWait =
	| {
			phase: "counting";
			usageLimit: boolean;
			attempt: number;
			max: number;
			/** What is left before omp retries, in ms. */
			left: number;
			/** When omp retries (epoch ms, this page's clock), for a wait long enough to be a reset; else null. */
			at: number | null;
	  }
	| { phase: "due" | "running" | "paused" }
	| { phase: "overdue" /** How long past the time omp announced, in ms. */; late: number };

/**
 * The wait of a subagent as of `now`. `paused`: the conversation's process is frozen. `thawedAt`: when the page saw it
 * run again (0: it did not), which is where omp's grace for what came due meanwhile starts (see `retryPhase`).
 */
export function subagentWait(wait: RetryWait, now: number, paused: boolean, thawedAt: number): SubagentWait {
	const phase = retryPhase(wait, now, paused, thawedAt);
	const due = wait.startedAt + wait.delayMs;
	switch (phase) {
		case "counting":
			return {
				phase,
				usageLimit: wait.usageLimit,
				attempt: wait.attempt,
				max: wait.maxAttempts,
				left: retryLeftMs(wait, now),
				at: wait.delayMs >= CLOCK_TIME_MS ? due : null,
			};
		case "overdue":
			return { phase, late: now - due };
		case "due":
			return { phase: paused ? "paused" : "due" };
		default:
			return { phase };
	}
}

/**
 * Whether the tab offers to retry this wait now ("Stop and continue", see `continuePrompt`): the wait of a usage limit
 * (told so by omp, or by its length when the page learned of it late), which is for hours, or one that omp has let
 * pass. A backoff of seconds is left to omp; a retry that is on its way is on its way. Never while the conversation is
 * `paused`, whatever the wait looks like: the view says `paused` only for a wait that is over, while one still counting
 * down shows its countdown, frozen; in both, the main agent that has to bring the subagent back is frozen too.
 */
export function canContinue(view: SubagentWait, paused: boolean): boolean {
	if (paused) return false;
	return view.phase === "overdue" || (view.phase === "counting" && (view.usageLimit || view.at !== null));
}
