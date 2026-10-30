/**
 * The Changes view of the Files tab: what the server tells the page about how the folder a conversation works in differs
 * from the last commit of its repository (`/api/folder/changes`) and how one file differs (`/api/folder/diff`). Read only:
 * the page can look at a change and nothing else, there is no stage, commit, restore or discard. Every path is relative to
 * the conversation's folder, written with `/`, and is one `git` itself named for that folder.
 */

/** How a file differs from the last commit. */
export type ChangeState = "modified" | "added" | "deleted" | "renamed" | "typechange" | "untracked" | "conflict";

export interface ChangedFile {
	path: string;
	/** A renamed file: the path it had in the last commit. */
	from?: string;
	state: ChangeState;
	/** Some of the change is in the index already (`git add`ed): it is part of the difference from the last commit all the same. */
	staged: boolean;
	/** Lines added and removed; absent for a binary or very large file, and for an untracked one (its lines are not counted). */
	added?: number;
	removed?: number;
	/** Not text, or larger than `CHANGES_LIMITS.fileBytes`: git does not diff it. */
	binary?: true;
	/** The file's mode changed (`100644` to `100755`). */
	mode?: { from: string; to: string };
}

/**
 * Whether the folder could be looked at. `none`: it is not in a repository (or git is missing). `unsafe`: the repository's own
 * settings name a program git would run, or send git to another work tree, so it is not looked at (see `vetRepository`).
 * `slow`: git did not answer in time. `unreadable`: it answered with an error (an object it needs is missing, say).
 */
export type ChangesState = "ok" | "none" | "unsafe" | "slow" | "unreadable";

export interface FolderChanges {
	/** The conversation's folder, as the server resolved it. */
	root: string;
	state: ChangesState;
	/** The branch (the short commit of a detached HEAD; "" when there is no commit yet), when `state` is `ok`. */
	branch: string;
	/** Changed files first, then new ones, each by path. */
	files: ChangedFile[];
	/** More files changed than `CHANGES_LIMITS.files`, or than the server reads of git's answer: `files` is the first of them. */
	truncated: boolean;
	/** Changed files this page is not shown (it is not on this computer: what is hidden by default or looks like a secret stays unnamed). */
	omitted: number;
	/** The page is not this computer's (see `FolderListing.guarded`). */
	guarded?: true;
}

/** One line of a hunk. A context line has both numbers, an added one the new, a removed one the old. */
export interface DiffRow {
	kind: "ctx" | "add" | "del";
	old?: number;
	new?: number;
	text: string;
	/** The file ends without a newline here (git's `\ No newline at end of file`). */
	noEol?: true;
	/** The line is longer than `CHANGES_LIMITS.rowChars`: `text` is its start. */
	clipped?: true;
}

export interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	/** What git prints after the second `@@` (the function the hunk is in), "" when it prints nothing. */
	section: string;
	rows: DiffRow[];
}

/**
 * A file's difference. `view` says what there is to show: `text` hunks (the first of them when `truncated`), `binary` a file git
 * does not diff, `empty` a change with no lines (a new mode, an empty file), `unreadable` a new file that cannot be shown (a
 * link, or one that is not a regular file; `reason` says which).
 */
export interface FileDiff {
	path: string;
	from?: string;
	state: ChangeState;
	view: "text" | "binary" | "empty" | "unreadable";
	hunks: DiffHunk[];
	added: number;
	removed: number;
	truncated: boolean;
	mode?: { from: string; to: string };
	reason?: "link" | "notFile";
}

export const CHANGES_LIMITS = {
	/** Files listed. */
	files: 500,
	/** The most text of git's answer read for the list. */
	listBytes: 4 * 1024 * 1024,
	/** The largest file git diffs (bigger ones are binary for it, see `core.bigFileThreshold`): the Files tab's text limit. */
	fileBytes: 1024 * 1024,
	/** The most text of a file's diff read from git. */
	diffBytes: 2 * 1024 * 1024,
	/** Rows of a diff sent: the rest is cut and the page says so. */
	rows: 5000,
	/** Characters of a row kept. */
	rowChars: 4000,
	/** Lines of context around a change. */
	context: 3,
} as const;
