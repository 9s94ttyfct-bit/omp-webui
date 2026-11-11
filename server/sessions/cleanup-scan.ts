import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GitRisk } from "../../shared/delete-cleanup.ts";
import { childEnv } from "../env.ts";
import type { Run } from "../git.ts";
import { safeGit } from "../git-changes.ts";
import { run } from "../omp/run.ts";
import { dependencyCandidate } from "./cleanup-rules.ts";

/**
 * The looks at the disk a delete's preview and its moves need (docs/superpowers/specs/2026-11-11-delete-session-folder-design.md):
 * the dependency folders in a folder, sizes, and what git has there that the move would take away. Git is run the way
 * the status line runs it (`safeGit`, and not at all in a repository whose configuration names a command).
 */

/** How deep the search for dependency folders goes, and how many it lists at most. */
const DEP_DEPTH = 4;
const DEP_MAX = 50;
/** How many folders the search looks into at most (a home-sized tree is not walked whole). */
const DIRS_MAX = 5000;
/** How long one git command may take. */
export const GIT_MS = 5000;

/** `realpathSync`, null when the path is not there. */
export function realOf(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/** Whether `path` is a folder (a link to one counts: what it names is what would move). */
export function isFolder(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

const runGit: Run = async (cmd, cwd, timeoutMs, env) => {
	try {
		const { code, stdout } = await run(cmd, { cwd, base: env, timeoutMs });
		return { code, stdout };
	} catch {
		return null;
	}
};

const gitEnv = (): Record<string, string | undefined> => childEnv({ GIT_TERMINAL_PROMPT: "0" });

/**
 * The check that a repository's own configuration cannot run anything, loaded on first use with the rest of git's
 * (`git-lazy.ts`): an idle server holds none of it.
 */
const vetted = async (path: string, env: Record<string, string | undefined>) =>
	(await import("../git-vet.ts")).vetRepository(runGit, path, GIT_MS, env);

/** Which of `paths` (inside `folder`) git ignores; none where `folder` is not in a repository git may look at. */
export async function gitIgnored(folder: string, paths: string[]): Promise<Set<string>> {
	if (paths.length === 0) return new Set();
	const env = gitEnv();
	if (!(await vetted(folder, env)).ok) return new Set();
	// Exit 0: some are ignored, 1: none; anything else (not a repository) says nothing.
	const r = await runGit(safeGit("check-ignore", "--", ...paths), folder, GIT_MS, env);
	if (r === null || (r.code !== 0 && r.code !== 1)) return new Set();
	const ignored = new Set<string>();
	for (const line of r.stdout.split("\n")) {
		const p = line.trim();
		if (p) ignored.add(resolve(folder, p));
	}
	return ignored;
}

/**
 * The dependency folders in `folder` (`dependencyCandidate`), to a depth of 4 and at most 50, not looking into `.git`, a
 * found one, or a link. One that counts only when git ignores it is listed only if it does.
 */
export async function listDependencies(folder: string): Promise<{ path: string; kind: string }[]> {
	const found: { path: string; kind: string; needsIgnored: boolean }[] = [];
	let looked = 0;
	const walk = (dir: string, depth: number): void => {
		if (depth > DEP_DEPTH || found.length >= DEP_MAX || looked >= DIRS_MAX) return;
		looked++;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const names = new Set(entries.map((e) => e.name));
		for (const e of entries) {
			if (!e.isDirectory() || e.name === ".git") continue;
			const path = join(dir, e.name);
			const candidate = dependencyCandidate(
				e.name,
				(n) => names.has(n),
				(n) => existsSync(join(path, n)),
			);
			if (candidate) {
				if (found.length < DEP_MAX) found.push({ path, ...candidate });
				continue;
			}
			walk(path, depth + 1);
		}
	};
	walk(folder, 1);
	const needIgnore = found.filter((f) => f.needsIgnored).map((f) => f.path);
	const ignored = await gitIgnored(folder, needIgnore);
	return found.filter((f) => !f.needsIgnored || ignored.has(f.path)).map(({ path, kind }) => ({ path, kind }));
}

/** The size of what is at `path` in bytes (`du -sk`); null when it was not measured within `budgetMs`. */
export async function sizeOf(path: string, budgetMs: number): Promise<number | null> {
	try {
		const r = await run(["du", "-sk", path], { timeoutMs: budgetMs });
		const kb = Number(r.stdout.trim().split(/\s+/)[0]);
		return Number.isFinite(kb) && r.stdout.trim() ? kb * 1024 : null;
	} catch {
		return null;
	}
}

/**
 * What git has under `path` that moving it would take away: changed and untracked files under it, and, where `path` is
 * the top of a repository or a worktree, the commits not pushed (those of a branch without an upstream that no remote
 * has). Null: not in a repository, or nothing at risk. Null counts: git could not be asked (a repository whose
 * configuration names a command is not run in).
 */
export async function gitRisk(path: string): Promise<GitRisk | null> {
	const env = gitEnv();
	const vet = await vetted(path, env);
	if (!vet.ok) return vet.slow || vet.refused ? { uncommitted: null, unpushed: null } : null;
	const status = await runGit(
		safeGit("status", "--porcelain=v2", "--ignore-submodules=all", "--untracked-files=all", "--", "."),
		path,
		GIT_MS,
		env,
	);
	const uncommitted =
		status === null || status.code !== 0 ? null : status.stdout.split("\n").filter((l) => /^[12u?] /.test(l)).length;
	let unpushed: number | null = 0;
	const top = await runGit(safeGit("rev-parse", "--show-toplevel"), path, GIT_MS, env);
	if (top === null) unpushed = null;
	else if (top.code === 0 && realOf(top.stdout.trim()) === realOf(path)) {
		const hasHead = await runGit(safeGit("rev-parse", "--verify", "-q", "HEAD"), path, GIT_MS, env);
		if (hasHead === null) unpushed = null;
		else if (hasHead.code === 0) {
			const upstream = await runGit(safeGit("rev-list", "--count", "@{u}..HEAD"), path, GIT_MS, env);
			const counted =
				upstream?.code === 0
					? upstream
					: await runGit(safeGit("rev-list", "--count", "HEAD", "--not", "--remotes"), path, GIT_MS, env);
			unpushed = counted?.code === 0 && /^\d+$/.test(counted.stdout.trim()) ? Number(counted.stdout.trim()) : null;
		}
	}
	if (uncommitted === 0 && unpushed === 0) return null;
	return { uncommitted, unpushed };
}

/** Whether `path` is the top of a linked git worktree (its git folder is not the repository's own). */
export async function isWorktreeTop(path: string): Promise<boolean> {
	const env = gitEnv();
	if (!(await vetted(path, env)).ok) return false;
	const r = await runGit(
		safeGit("rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"),
		path,
		GIT_MS,
		env,
	);
	if (r === null || r.code !== 0) return false;
	const [top, gitDir, common] = r.stdout.trim().split("\n");
	return realOf(top ?? "") === realOf(path) && realOf(gitDir ?? "") !== realOf(common ?? "");
}

/**
 * Whether `now` has more work at risk than `then`, what the dialog showed. A count the dialog showed as unknown was
 * accepted as such; one that was known and can no longer be read counts as more.
 */
export function moreAtRisk(now: GitRisk | null, then: GitRisk | null): boolean {
	if (now === null) return false;
	const more = (a: number | null, b: number | null | undefined) => {
		if (b === null) return false;
		return a === null || a > (b ?? 0);
	};
	return more(now.uncommitted, then?.uncommitted) || more(now.unpushed, then?.unpushed);
}
