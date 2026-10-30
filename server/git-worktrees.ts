import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { Worktree, WorktreeList } from "../shared/git.ts";
import type { Run } from "./git.ts";
import { EMPTY_TREE } from "./git-changes.ts";
import { vetRepository } from "./git-vet.ts";

/**
 * The worktrees of a repository for the right panel's Worktrees tab (#698): each one's branch and HEAD, what is not
 * committed there and how many of its commits the main branch lacks. Only looks: `git worktree list`, `rev-parse`,
 * `rev-list --count` and the status line's own `git status` (no fsmonitor, no hooks, no attributes of the folder, no
 * submodule entered, no index lock taken). A repository whose own configuration names a command is not looked at
 * (`vetRepository`), nor is any worktree whose own is.
 */

/** The worktrees whose changes are counted; the rest are listed without them. */
export const WORKTREES_LOOKED_AT = 24;

interface Listed {
	path: string;
	head: string;
	branch: string | null;
	bare: boolean;
	locked: boolean;
	prunable: boolean;
}

/** `git worktree list --porcelain` (blank-line separated records) read as worktrees, the main one first as git lists it. */
export function parseWorktrees(text: string): Listed[] {
	const out: Listed[] = [];
	for (const block of text.split(/\n\n+/)) {
		const lines = block.split("\n").filter(Boolean);
		const first = lines[0];
		if (!first?.startsWith("worktree ")) continue;
		const w: Listed = {
			path: first.slice("worktree ".length),
			head: "",
			branch: null,
			bare: false,
			locked: false,
			prunable: false,
		};
		for (const line of lines.slice(1)) {
			if (line.startsWith("HEAD ")) w.head = line.slice(5, 12);
			else if (line.startsWith("branch ")) w.branch = line.slice(7).replace(/^refs\/heads\//, "");
			else if (line === "bare") w.bare = true;
			else if (line === "locked" || line.startsWith("locked ")) w.locked = true;
			else if (line === "prunable" || line.startsWith("prunable ")) w.prunable = true;
		}
		out.push(w);
	}
	return out;
}

/** The status line's look at a folder: nothing the repository names is run (see `GitProbe.#status`). */
const STATUS = [
	"git",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=/dev/null",
	`--attr-source=${EMPTY_TREE}`,
	"--no-optional-locks",
	"status",
	"--porcelain=v2",
	"--ignore-submodules=all",
];

/** Change counts of `git status --porcelain=v2` (as `parseStatus` counts them). */
export function countChanges(text: string): { staged: number; unstaged: number; untracked: number } {
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("1 ") || line.startsWith("2 ")) {
			if (line[2] !== ".") staged++;
			if (line[3] !== ".") unstaged++;
		} else if (line.startsWith("u ")) unstaged++;
		else if (line.startsWith("? ")) untracked++;
	}
	return { staged, unstaged, untracked };
}

const real = (p: string): string => {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
};

/** Whether `dir` is `root` or inside it. */
const within = (dir: string, root: string): boolean =>
	dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);

/** The branch commits are counted against: `origin/HEAD`'s, else a local `main` or `master`. */
async function mainBranch(run: Run, dir: string, timeoutMs: number, env: Record<string, string | undefined>) {
	const remote = await run(
		["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
		dir,
		timeoutMs,
		env,
	);
	if (remote === null) return { slow: true, name: null };
	if (remote.code === 0 && remote.stdout.trim()) return { slow: false, name: remote.stdout.trim() };
	for (const name of ["main", "master"]) {
		const local = await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${name}`], dir, timeoutMs, env);
		if (local === null) return { slow: true, name: null };
		if (local.code === 0) return { slow: false, name };
	}
	return { slow: false, name: null };
}

/** The worktrees of the repository `dir` is in; `slow` when git did not answer in time somewhere. */
export async function listWorktrees(
	run: Run,
	dir: string,
	timeoutMs: number,
	env: Record<string, string | undefined>,
): Promise<{ value: WorktreeList; slow: boolean }> {
	const empty = (state: WorktreeList["state"]): WorktreeList => ({
		state,
		mainBranch: null,
		worktrees: [],
		truncated: false,
	});
	const vetting = await vetRepository(run, dir, timeoutMs, env);
	if (!vetting.ok) {
		return { value: empty(vetting.slow ? "slow" : vetting.refused ? "unsafe" : "none"), slow: vetting.slow };
	}
	const listed = await run(["git", "worktree", "list", "--porcelain"], dir, timeoutMs, env);
	if (listed === null) return { value: empty("slow"), slow: true };
	if (listed.code !== 0) return { value: empty("none"), slow: false };
	const main = await mainBranch(run, dir, timeoutMs, env);
	const here = real(dir);
	const all = parseWorktrees(listed.stdout);
	// The innermost worktree that holds the folder is the conversation's (a worktree may sit inside the main one).
	const holders = all.filter((w) => within(here, real(w.path)));
	const current = holders.sort((a, b) => b.path.length - a.path.length)[0]?.path;
	let slow = main.slow;
	const worktrees = await Promise.all(
		all.map(async (w, i): Promise<Worktree> => {
			const row: Worktree = {
				path: w.path,
				branch: w.bare ? null : w.branch,
				head: w.head,
				main: i === 0,
				current: w.path === current,
				locked: w.locked,
				prunable: w.prunable,
				changes: null,
				ahead: null,
			};
			if (w.bare || w.prunable || i >= WORKTREES_LOOKED_AT) return row;
			// A worktree has configuration of its own (`config.worktree`): it is vetted as the folder was.
			const vetted = await vetRepository(run, w.path, timeoutMs, env);
			if (!vetted.ok) {
				slow ||= vetted.slow;
				return row;
			}
			const [status, ahead] = await Promise.all([
				run(STATUS, w.path, timeoutMs, env),
				main.name && w.head ? run(["git", "rev-list", "--count", `${main.name}..HEAD`], w.path, timeoutMs, env) : null,
			]);
			if (status === null) slow = true;
			else if (status.code === 0) row.changes = countChanges(status.stdout);
			if (main.name && w.head) {
				if (ahead === null) slow = true;
				else if (ahead.code === 0 && /^\d+$/.test(ahead.stdout.trim())) row.ahead = Number(ahead.stdout.trim());
			}
			return row;
		}),
	);
	return {
		value: { state: "ok", mainBranch: main.name, worktrees, truncated: all.length > WORKTREES_LOOKED_AT },
		slow,
	};
}
