/**
 * The GitHub Actions runs of a conversation's folder, as the side panel's CI tab shows them. Read only: the server asks the
 * person's own GitHub CLI (`gh run list`, `gh run view --json jobs`, see `server/gh-runs.ts`) and never writes to GitHub.
 * One look is shared by every page that asks within its interval, and the interval follows the runs (`ciPollMs`).
 */

import type { IssuesProblem } from "./github.ts";

/**
 * A run's or a job's state, from GitHub's `status` and `conclusion`: waiting to start (`queued`: queued, waiting, pending,
 * requested), `running`, or finished as `success`, `failure` (also timed out, a startup failure, action required),
 * `cancelled` or `skipped` (also neutral, stale).
 */
export type CiState = "queued" | "running" | "success" | "failure" | "cancelled" | "skipped";

/** Which runs a list holds: the folder's current branch, or every branch. */
export type CiScope = "branch" | "all";
export const CI_SCOPES: readonly CiScope[] = ["branch", "all"];

export interface CiRun {
	/** GitHub's id of the run (`databaseId`): what its jobs are asked by. */
	id: number;
	/** The workflow's name. */
	workflow: string;
	/** The commit's or pull request's title, as GitHub shows it for the run. */
	title: string;
	branch: string;
	/** What started it: `push`, `pull_request`, `schedule`, `workflow_dispatch`… */
	event: string;
	/** The commit it ran on (full hash). */
	sha: string;
	state: CiState;
	/** GitHub's own conclusion word when it is finished (`timed_out` reads as `failure` in `state`). */
	conclusion?: string;
	/** ISO 8601. `startedAt` is absent while it has not started. */
	createdAt: string;
	startedAt?: string;
	updatedAt: string;
	/** Its page on GitHub (only an http(s) address is kept: the page links to it). */
	url: string;
}

export interface CiJob {
	id: number;
	name: string;
	state: CiState;
	startedAt?: string;
	completedAt?: string;
	/** The job's page on GitHub, which is where its log is. */
	url: string;
	/** The first step that failed, when the job did. */
	failedStep?: string;
}

export interface CiRuns {
	scope: CiScope;
	/** The folder's current branch; null on a detached HEAD (then the list holds every branch's runs). */
	branch: string | null;
	/** Newest first, as GitHub lists them; at most `CI_RUN_LIMIT`. */
	runs: CiRun[];
}

/**
 * Why there is nothing to show: the Issues tab's reasons (`IssuesProblem`), and `rate-limited` when GitHub's API limit was
 * reached (the look is tried again later, `ciPollMs`).
 */
export type CiProblem = IssuesProblem | "rate-limited";

/** An answer of `/api/github/runs` or `/api/github/run`, with when the page should ask again (`nextMs`). */
export type CiAnswer<T> = ({ ok: true; value: T } | { ok: false; problem: CiProblem; message?: string }) & {
	/** When the page may ask again and get a newer look: the shared look's age subtracted from its interval. */
	nextMs: number;
};

/** The most runs one list holds. */
export const CI_RUN_LIMIT = 20;

/** How often a list is looked at again: while a run is queued or running, and when every run is finished. */
export const CI_ACTIVE_MS = 10_000;
export const CI_IDLE_MS = 60_000;
/** After a failed look: the first wait, doubled for each failure in a row up to `CI_MAX_BACKOFF_MS`. */
export const CI_ERROR_MS = 60_000;
/** After GitHub said its rate limit was reached: the first wait, doubled likewise. */
export const CI_RATE_LIMITED_MS = 5 * 60_000;
export const CI_MAX_BACKOFF_MS = 15 * 60_000;

export const isActive = (state: CiState): boolean => state === "queued" || state === "running";

/**
 * How long a look is good for. `failures`: the looks that failed in a row, this one included (0 for a list). A list with a
 * run that is queued or running is looked at every 10 s, one where every run is finished every 60 s; a failure waits a
 * minute (a rate limit five), doubled for each failure in a row, at most 15 minutes.
 */
export function ciPollMs(
	answer: { ok: true; value: CiRuns } | { ok: false; problem: CiProblem },
	failures = 0,
): number {
	if (answer.ok) return answer.value.runs.some((r) => isActive(r.state)) ? CI_ACTIVE_MS : CI_IDLE_MS;
	const base = answer.problem === "rate-limited" ? CI_RATE_LIMITED_MS : CI_ERROR_MS;
	const doubled = base * 2 ** Math.max(0, Math.min(failures - 1, 10));
	return Math.min(CI_MAX_BACKOFF_MS, doubled);
}

/** The state of the badge on the CI tab: of the latest commit's runs on the current branch. */
export type CiBadge = "running" | "failed" | "passed";

/**
 * What the tab's badge says of a branch's list: the runs of its latest commit (a push starts one run per workflow): one
 * queued or running is `running`, else one that failed is `failed`, else one that succeeded is `passed`. Nothing for a
 * list of every branch, an empty one, or a commit whose runs were all cancelled or skipped.
 */
export function ciBadge(runs: CiRuns | null): CiBadge | null {
	if (runs?.scope !== "branch" || runs.branch === null || runs.runs.length === 0) return null;
	const sha = runs.runs[0].sha;
	const latest = runs.runs.filter((r) => r.sha === sha);
	if (latest.some((r) => isActive(r.state))) return "running";
	if (latest.some((r) => r.state === "failure")) return "failed";
	if (latest.some((r) => r.state === "success")) return "passed";
	return null;
}

/** The runs that were queued or running in `before` and are finished in `after` (the same run, by id). */
export function finishedRuns(before: readonly CiRun[], after: readonly CiRun[]): CiRun[] {
	const wasActive = new Set(before.filter((r) => isActive(r.state)).map((r) => r.id));
	return after.filter((r) => wasActive.has(r.id) && !isActive(r.state));
}

/** How long a run or a job took, or has taken so far (`now`), in ms; null when it has not started. */
export function ciDurationMs(
	startedAt: string | undefined,
	endedAt: string | undefined,
	active: boolean,
	now: number,
): number | null {
	const start = startedAt ? Date.parse(startedAt) : Number.NaN;
	if (!Number.isFinite(start)) return null;
	const end = active ? now : endedAt ? Date.parse(endedAt) : Number.NaN;
	if (!Number.isFinite(end)) return null;
	return Math.max(0, end - start);
}
