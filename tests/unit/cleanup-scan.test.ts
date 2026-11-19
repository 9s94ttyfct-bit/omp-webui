import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "../../server/platform/index.ts";
import { gitRisk, listDependencies, moreAtRisk, sizeOf } from "../../server/sessions/cleanup-scan.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ompw-cleanup-scan-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const dir = (...parts: string[]) => {
	const p = join(root, ...parts);
	mkdirSync(p, { recursive: true });
	return p;
};
const file = (path: string, text = "x") => writeFileSync(path, text);
const git = (cwd: string, ...args: string[]) => {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

describe("listDependencies", () => {
	test("finds node_modules and a virtualenv, skips a .venv that is not one, and does not look inside what it found", async () => {
		const app = dir("deps", "app");
		dir("deps", "app", "node_modules", "left-pad", "node_modules");
		dir("deps", "app", "web", ".venv");
		file(join(app, "web", ".venv", "pyvenv.cfg"));
		dir("deps", "app", "py", ".venv");
		const found = await listDependencies(app);
		expect(found.map((f) => f.path).sort()).toEqual([join(app, "node_modules"), join(app, "web", ".venv")]);
	});

	// The folder's name is not ASCII: git quotes such a path (and every Windows path) in what it prints.
	test("a vendor folder beside go.mod is listed only when git ignores it", async () => {
		const repo = dir("vendör-repo");
		git(repo, "init", "-q");
		file(join(repo, "go.mod"), "module x\n");
		dir("vendör-repo", "vendor", "x");
		expect(await listDependencies(repo)).toEqual([]);
		file(join(repo, ".gitignore"), "vendor/\n");
		expect(await listDependencies(repo)).toEqual([{ path: join(repo, "vendor"), kind: "vendor" }]);
	});
});

describe("gitRisk", () => {
	test("a clean repository at its top with nothing unpushed is no risk", async () => {
		const repo = dir("clean");
		git(repo, "init", "-q");
		git(repo, "commit", "-q", "--allow-empty", "-m", "init");
		git(repo, "remote", "add", "origin", repo);
		git(repo, "fetch", "-q", "origin");
		expect(await gitRisk(repo)).toBeNull();
	});

	test("counts untracked files under the folder only, and unpushed commits at the top only", async () => {
		const repo = dir("work");
		git(repo, "init", "-q");
		git(repo, "commit", "-q", "--allow-empty", "-m", "one");
		const sub = dir("work", "sub");
		file(join(sub, "new.txt"));
		file(join(repo, "elsewhere.txt"));
		// No remote: the branch's one commit is on no remote.
		expect(await gitRisk(repo)).toEqual({ uncommitted: 2, unpushed: 1, stashes: 0 });
		expect(await gitRisk(sub)).toEqual({ uncommitted: 1, unpushed: 0, stashes: 0 });
	});

	test("a folder outside any repository is no risk", async () => {
		expect(await gitRisk(dir("plain"))).toBeNull();
	});

	// #355
	test("commits of a branch that is not checked out, and stashes, count when no remote has them", async () => {
		const repo = dir("branches");
		git(repo, "init", "-q", "-b", "main");
		git(repo, "commit", "-q", "--allow-empty", "-m", "one");
		git(repo, "remote", "add", "origin", repo);
		git(repo, "fetch", "-q", "origin");
		expect(await gitRisk(repo)).toBeNull();
		git(repo, "checkout", "-q", "-b", "feature");
		git(repo, "commit", "-q", "--allow-empty", "-m", "two");
		git(repo, "commit", "-q", "--allow-empty", "-m", "three");
		git(repo, "checkout", "-q", "main");
		file(join(repo, "a.txt"));
		git(repo, "add", "a.txt");
		git(repo, "stash", "-q");
		// main is on the remote and its tree is clean: the two commits of `feature` and the stash are all that is at risk.
		expect(await gitRisk(repo)).toEqual({ uncommitted: 0, unpushed: 2, stashes: 1 });
	});

	// #235
	test("repositories inside a folder that is none are added up; a folder holding none is no risk", async () => {
		const ws = dir("ws");
		expect(await gitRisk(ws)).toBeNull();
		const app = dir("ws", "front", "app");
		git(app, "init", "-q");
		git(app, "commit", "-q", "--allow-empty", "-m", "local only");
		file(join(app, "new.txt"));
		const lib = dir("ws", "lib");
		git(lib, "init", "-q");
		file(join(lib, "x.txt"));
		expect(await gitRisk(ws)).toEqual({ uncommitted: 2, unpushed: 1, stashes: 0 });
	});

	test("a dependency folder is not searched for repositories", async () => {
		const app = dir("deps-git", "app");
		const pkg = dir("deps-git", "app", "node_modules", "left-pad");
		git(pkg, "init", "-q");
		file(join(pkg, "x.txt"));
		expect(await gitRisk(app)).toBeNull();
	});
});

describe("moreAtRisk", () => {
	test("more work than the dialog showed, or a count that can no longer be read, stops the move", () => {
		expect(moreAtRisk({ uncommitted: 2, unpushed: 0, stashes: 0 }, { uncommitted: 2, unpushed: 0, stashes: 0 })).toBe(
			false,
		);
		expect(moreAtRisk({ uncommitted: 3, unpushed: 0, stashes: 0 }, { uncommitted: 2, unpushed: 0, stashes: 0 })).toBe(
			true,
		);
		expect(moreAtRisk({ uncommitted: 2, unpushed: 0, stashes: 1 }, { uncommitted: 2, unpushed: 0, stashes: 0 })).toBe(
			true,
		);
		expect(moreAtRisk({ uncommitted: 1, unpushed: 0, stashes: 0 }, null)).toBe(true);
		expect(moreAtRisk({ uncommitted: null, unpushed: 0, stashes: 0 }, null)).toBe(true);
		expect(
			moreAtRisk(
				{ uncommitted: null, unpushed: null, stashes: null },
				{ uncommitted: null, unpushed: null, stashes: null },
			),
		).toBe(false);
		expect(moreAtRisk(null, { uncommitted: 4, unpushed: 1, stashes: 0 })).toBe(false);
	});
});

test("sizeOf measures a folder", async () => {
	const big = dir("sized");
	file(join(big, "a.bin"), "y".repeat(64 * 1024));
	const bytes = await sizeOf(big, 10_000);
	expect(bytes).not.toBeNull();
	expect(bytes as number).toBeGreaterThanOrEqual(64 * 1024);
});

test.skipIf(platform.trash === null)(
	"the working folders of this user's processes include this test's, with its parent",
	async () => {
		const own = await platform.trash?.workingFolders();
		expect(own).not.toBeNull();
		const me = own?.find((w) => w.pid === process.pid);
		expect(me?.cwd).toBe(realpathSync(process.cwd()));
		// What a deleted conversation's omp started is told by it (`DeleteCleanup.users`).
		expect(me?.ppid).toBe(process.ppid);
	},
);
