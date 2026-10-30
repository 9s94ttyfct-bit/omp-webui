import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProbe } from "../../server/git.ts";
import { countChanges, parseWorktrees } from "../../server/git-worktrees.ts";

/**
 * The Worktrees tab (#698): the worktrees of a conversation's repository, what is not committed in each and how many of its
 * commits the main branch lacks, read from a real repository made here; and nothing is looked at in a repository whose own
 * settings name a command.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "ompw-worktrees-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
};

const repo = join(root, "repo");
Bun.spawnSync(["mkdir", "-p", repo]);
git(repo, "init", "-q", "-b", "main");
writeFileSync(join(repo, "a.txt"), "a\n");
git(repo, "add", "a.txt");
git(repo, "commit", "-q", "-m", "first");
const feature = join(root, "repo-feature");
git(repo, "worktree", "add", "-q", "-b", "feature", feature);
writeFileSync(join(feature, "b.txt"), "b\n");
git(feature, "add", "b.txt");
git(feature, "commit", "-q", "-m", "on feature");
git(feature, "commit", "-q", "--allow-empty", "-m", "again");
// Uncommitted in the feature worktree: one change staged, one new file.
writeFileSync(join(feature, "b.txt"), "b2\n");
git(feature, "add", "b.txt");
writeFileSync(join(feature, "new.txt"), "n\n");
const detached = join(root, "repo-detached");
git(repo, "worktree", "add", "-q", "--detach", detached, "HEAD");

const probe = () => new GitProbe({ env });

test("every worktree is listed with its branch, its uncommitted changes and its commits the main branch lacks", async () => {
	const list = await probe().worktrees(feature);
	expect(list.state).toBe("ok");
	expect(list.mainBranch).toBe("main");
	const by = Object.fromEntries(list.worktrees.map((w) => [w.path, w]));
	expect(by[repo]).toMatchObject({ branch: "main", main: true, current: false, ahead: 0 });
	expect(by[repo].changes).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
	// The conversation's folder is in the feature worktree.
	expect(by[feature]).toMatchObject({ branch: "feature", main: false, current: true, ahead: 2 });
	expect(by[feature].changes).toEqual({ staged: 1, unstaged: 0, untracked: 1 });
	expect(by[detached]).toMatchObject({ branch: null, ahead: 0 });
	expect(by[detached].head).toMatch(/^[0-9a-f]{7}$/);
});

test("a folder in no repository has none, and one whose repository's settings name a command is not looked at", async () => {
	const plain = join(root, "plain");
	Bun.spawnSync(["mkdir", "-p", plain]);
	expect((await probe().worktrees(plain)).state).toBe("none");
	const risky = join(root, "risky");
	Bun.spawnSync(["mkdir", "-p", risky]);
	git(risky, "init", "-q");
	git(risky, "config", "core.fsmonitor", "./run-me");
	const list = await probe().worktrees(risky);
	expect(list).toMatchObject({ state: "unsafe", worktrees: [] });
});

test("git's porcelain list and status are read as git writes them", () => {
	const listed = parseWorktrees(
		"worktree /r\nHEAD 0123456789abcdef\nbranch refs/heads/main\n\nworktree /r-wt\nHEAD fedcba9876543210\ndetached\nlocked reason\n\nworktree /gone\nHEAD 1111111111111111\nbranch refs/heads/x/y\nprunable gitdir file points to non-existent location\n",
	);
	expect(listed).toEqual([
		{ path: "/r", head: "0123456", branch: "main", bare: false, locked: false, prunable: false },
		{ path: "/r-wt", head: "fedcba9", branch: null, bare: false, locked: true, prunable: false },
		{ path: "/gone", head: "1111111", branch: "x/y", bare: false, locked: false, prunable: true },
	]);
	expect(countChanges("1 M. N... a\n1 .M N... b\n1 MM N... c\nu UU N... d\n? e\n? f\n")).toEqual({
		staged: 2,
		unstaged: 3,
		untracked: 2,
	});
});
