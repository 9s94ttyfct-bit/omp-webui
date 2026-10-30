/** What `/api/git` tells the status line about the folder a conversation works in. */

/** The working tree's state: the branch and how many files differ from it, as `git status --porcelain=v2 --branch` counts. */
export interface GitStatus {
	/** The branch's name; for a detached HEAD, its short commit id (`detached` is then true). */
	branch: string;
	detached: boolean;
	/** Files with a change in the index. */
	staged: number;
	/** Files with a change in the working tree, merge conflicts included. */
	unstaged: number;
	untracked: number;
}

/** The open pull request of the checked-out branch, from `gh pr view`. */
export interface PullRequest {
	number: number;
	url: string;
}

/**
 * `git` is null where the folder is not in a repository, git is missing or did not answer in time. `pr` is only
 * there when it was asked for: null means no pull request, or no `gh` to look it up with.
 */
export interface GitReport {
	git: GitStatus | null;
	pr?: PullRequest | null;
}

/** One worktree of the repository (`git worktree list --porcelain`), with how it stands (#698). */
export interface Worktree {
	/** Its folder, absolute. */
	path: string;
	/** The branch checked out there; null for a detached HEAD (then `head` says where it is) or a bare repository. */
	branch: string | null;
	/** The short id of its HEAD commit; empty for a bare repository or one with no commit yet. */
	head: string;
	/** The repository's main worktree (the first git lists). */
	main: boolean;
	/** The conversation's folder is in it. */
	current: boolean;
	locked: boolean;
	/** git says it can be pruned: its folder is gone. */
	prunable: boolean;
	/** What is not committed there; null where it was not looked at (its folder is gone, not vetted, or git was slow). */
	changes: { staged: number; unstaged: number; untracked: number } | null;
	/** Commits of its HEAD that the main branch does not have; null where there is no main branch to count against. */
	ahead: number | null;
}

/**
 * The worktrees of the repository a conversation's folder is in (`/api/git/worktrees`). `state`: `ok`, or why there is no
 * list: `none` (not a repository), `unsafe` (its configuration names a command, see `vetRepository`), `slow` (git did not
 * answer in time).
 */
export interface WorktreeList {
	state: "ok" | "none" | "unsafe" | "slow";
	/** The branch the commits are counted against (`origin/HEAD`'s, else `main` or `master`); null when there is none. */
	mainBranch: string | null;
	worktrees: Worktree[];
	/** More worktrees than are looked at: the rest are listed without their changes. */
	truncated: boolean;
}
