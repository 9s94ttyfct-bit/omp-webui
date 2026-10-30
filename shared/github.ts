/**
 * The GitHub issues of a conversation's folder (#653), as the side panel's Issues tab shows them. Read only: the app asks
 * the person's own GitHub CLI (`gh issue list`, `gh issue view`) and never writes to GitHub.
 */

export type IssueState = "open" | "closed";
/** Which issues a list asks for. */
export type IssueFilter = IssueState | "all";
export const ISSUE_FILTERS: readonly IssueFilter[] = ["open", "closed", "all"];

export interface IssueLabel {
	name: string;
	/** Six hex digits, without `#`, as GitHub gives it; absent when it is not that. */
	color?: string;
}

export interface IssueSummary {
	number: number;
	title: string;
	state: IssueState;
	labels: IssueLabel[];
	/** The login of who opened it; absent for a deleted account. */
	author?: string;
	assignees: string[];
	/** ISO 8601. */
	createdAt: string;
	updatedAt: string;
	/** Its page on GitHub (only an http(s) address is kept). */
	url: string;
}

export interface IssueComment {
	author?: string;
	body: string;
	createdAt: string;
}

export interface IssueDetail extends IssueSummary {
	body: string;
	comments: IssueComment[];
}

/**
 * Why there is nothing to show:
 * - `no-gh`: the GitHub CLI is not installed (not on the server's PATH);
 * - `signed-out`: `gh` is not logged in;
 * - `no-repo`: the folder is not a git repository, or none of its remotes is on GitHub;
 * - `unsafe`: the repository's own configuration names a command, so it is not looked at (see `server/git-vet.ts`);
 * - `slow`: `gh` (or git) gave no answer in time;
 * - `failed`: anything else `gh` said, in `message`.
 */
export type IssuesProblem = "no-gh" | "signed-out" | "no-repo" | "unsafe" | "slow" | "failed";

export type IssuesAnswer<T> = { ok: true; value: T } | { ok: false; problem: IssuesProblem; message?: string };

/** The most issues one list holds. */
export const ISSUE_LIST_LIMIT = 100;
/** The longest search the server passes on. */
export const ISSUE_SEARCH_MAX = 200;
