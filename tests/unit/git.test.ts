import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { directoryOf, GitProbe, parsePullRequest, parseStatus, type Run } from "../../server/git.ts";
import { commandAttributes, commandKeys } from "../../server/git-vet.ts";
import { pollUntil, processExists } from "../support/poll.ts";

/**
 * The status line's git chips: the branch with its change counts (`git status --porcelain=v2 --branch`) and the
 * pull request (`gh pr view`, optional). Against a real temporary repository, with `gh` a script on the PATH.
 */

/** The two questions that decide whether a folder is looked at, answered as for a repository with nothing in it that runs a command. */
const vetted =
	(next: Run): Run =>
	async (cmd, cwd, timeoutMs, env) => {
		if (cmd[0] === "git" && cmd[1] === "rev-parse") return { code: 0, stdout: "/nowhere/.git/info/attributes\n" };
		if (cmd[0] === "git" && cmd[1] === "config") return { code: 0, stdout: "" };
		return next(cmd, cwd, timeoutMs, env);
	};

const root = mkdtempSync(join(tmpdir(), "ompw-git-"));
const repo = join(root, "repo");
const bin = join(root, "bin");
const ghLog = join(root, "gh.log");
const gitDir = dirname(Bun.which("git") ?? "/usr/bin/git");

/** Run git in the repository with an identity, so nothing depends on the machine's configuration. */
function git(...args: string[]): void {
	const ran = Bun.spawnSync(
		["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd: repo, stdout: "pipe", stderr: "pipe" },
	);
	if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
}

/** A `gh` that logs its calls and runs `body` (a shell fragment). */
function stubGh(body: string): void {
	const script = join(bin, "gh");
	writeFileSync(script, `#!/bin/sh\necho "$@" >> "${ghLog}"\n${body}\n`);
	chmodSync(script, 0o755);
}

const ghCalls = () => (Bun.file(ghLog).size ? readFileSync(ghLog, "utf8").trim().split("\n").length : 0);
/** git is found; `gh` is only what the stub directory has. */
const withStub = { PATH: `${bin}:${gitDir}`, HOME: root };

beforeAll(() => {
	mkdirSync(repo, { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(ghLog, "");
	git("init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "a\n");
	writeFileSync(join(repo, "b.txt"), "b\n");
	git("add", ".");
	git("commit", "-q", "-m", "first");
	git("checkout", "-q", "-b", "feature/status");
	// One staged, one changed in the working tree, one both, two untracked.
	writeFileSync(join(repo, "staged.txt"), "s\n");
	git("add", "staged.txt");
	writeFileSync(join(repo, "a.txt"), "a changed\n");
	writeFileSync(join(repo, "b.txt"), "b changed\n");
	git("add", "b.txt");
	writeFileSync(join(repo, "b.txt"), "b changed twice\n");
	writeFileSync(join(repo, "new1.txt"), "1\n");
	writeFileSync(join(repo, "new2.txt"), "2\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a status is the branch and one count per kind of change; a file changed twice counts on both sides", () => {
	const text = [
		"# branch.oid 5f3a1c2e9b8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b",
		"# branch.head main",
		"# branch.upstream origin/main",
		"# branch.ab +2 -1",
		"1 M. N... 100644 100644 100644 aaa bbb staged.txt",
		"1 .M N... 100644 100644 100644 aaa bbb worktree.txt",
		"1 MM N... 100644 100644 100644 aaa bbb both.txt",
		"2 R. N... 100644 100644 100644 aaa bbb R100 renamed.txt\told.txt",
		"u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt",
		"? untracked.txt",
		"? dir/",
		"! ignored.log",
		"",
	].join("\n");
	expect(parseStatus(text)).toEqual({
		branch: "main",
		detached: false,
		// staged.txt, both.txt, renamed.txt
		staged: 3,
		// worktree.txt, both.txt, the conflict
		unstaged: 3,
		untracked: 2,
	});
});

test("a detached HEAD is its short commit; a repository without a commit still names its branch; other text is no status", () => {
	expect(parseStatus("# branch.oid 5f3a1c2e9b8d7c6b\n# branch.head (detached)\n")).toEqual({
		branch: "5f3a1c2",
		detached: true,
		staged: 0,
		unstaged: 0,
		untracked: 0,
	});
	expect(parseStatus("# branch.oid (initial)\n# branch.head trunk\n? a.txt\n")).toMatchObject({
		branch: "trunk",
		detached: false,
		untracked: 1,
	});
	expect(parseStatus("fatal: not a git repository\n")).toBeNull();
	expect(parseStatus("")).toBeNull();
});

test("a pull request is a number and a web address; anything else is none", () => {
	expect(parsePullRequest('{"number":42,"url":"https://github.com/o/r/pull/42"}')).toEqual({
		number: 42,
		url: "https://github.com/o/r/pull/42",
	});
	for (const text of [
		"",
		"not json",
		"null",
		"[]",
		'{"number":0,"url":"https://github.com/o/r/pull/0"}',
		'{"number":"42","url":"https://github.com/o/r/pull/42"}',
		'{"number":42}',
		'{"number":42,"url":"javascript:alert(1)"}',
	]) {
		expect(parsePullRequest(text), text).toBeNull();
	}
});

test("a folder that is not there, is a file or is not absolute is refused like the other endpoints refuse it", () => {
	expect(directoryOf(repo)).toBe(realpathSync(repo));
	expect(() => directoryOf(join(root, "missing"))).toThrow("Not a directory");
	expect(() => directoryOf(join(repo, "a.txt"))).toThrow("Not a directory");
	// A conversation's folder is absolute: anything else would be the server's own.
	for (const relative of ["", ".", "repo", "../repo"]) {
		expect(() => directoryOf(relative), relative).toThrow("Not a directory");
	}
});

test("a real repository reports its branch and counts; a folder outside any repository reports none", async () => {
	stubGh("exit 1");
	const probe = new GitProbe({ env: withStub });
	expect(await probe.report(repo)).toEqual({
		git: { branch: "feature/status", detached: false, staged: 2, unstaged: 2, untracked: 2 },
	});
	const plain = join(root, "plain");
	mkdirSync(plain);
	expect(await new GitProbe({ env: withStub }).report(plain)).toEqual({ git: null });
});

test("the pull request comes from gh, is only asked for on request, and is kept: gh is asked once", async () => {
	writeFileSync(ghLog, "");
	stubGh(`echo '{"number":42,"url":"https://github.com/o/r/pull/42"}'`);
	let clock = 1_000;
	const probe = new GitProbe({ env: withStub, now: () => clock });
	// Without the request, gh is not run at all.
	expect((await probe.report(repo)).pr).toBeUndefined();
	expect(ghCalls()).toBe(0);
	const first = await probe.report(repo, { pr: true });
	expect(first.pr).toEqual({ number: 42, url: "https://github.com/o/r/pull/42" });
	expect(ghCalls()).toBe(1);
	expect(readFileSync(ghLog, "utf8")).toContain("pr view --json number,url");
	expect((await probe.report(repo, { pr: true })).pr).toEqual(first.pr);
	expect(ghCalls()).toBe(1);
	// `fresh` asks again, unless the answer is from the last moments.
	await probe.report(repo, { pr: true, fresh: true });
	expect(ghCalls()).toBe(1);
	clock += 600;
	await probe.report(repo, { pr: true, fresh: true });
	expect(ghCalls()).toBe(2);
});

test("a branch without a pull request, a gh that fails and a gh that is not installed all give no pull request, and the branch stays", async () => {
	stubGh(`echo "no pull requests found for branch" >&2; exit 1`);
	const none = await new GitProbe({ env: withStub }).report(repo, { pr: true });
	expect(none.pr).toBeNull();
	expect(none.git?.branch).toBe("feature/status");

	stubGh("echo 'garbage'");
	expect((await new GitProbe({ env: withStub }).report(repo, { pr: true })).pr).toBeNull();

	// No `gh` on the PATH at all.
	const missing = await new GitProbe({ env: { PATH: gitDir, HOME: root } }).report(repo, { pr: true });
	expect(missing.pr).toBeNull();
	expect(missing.git?.branch).toBe("feature/status");
});

// The two time-limit tests run real child processes against the real clock: the limit is what they test. The stubs run
// with the PATH the probe is given, which has no `sleep` (it is in /bin, and git is in /usr/bin): a stub that says
// `sleep` fails at once, and the limit never has anything to end.
/** That every process a stub recorded is gone. With every core taken a shell can take longer than the limit to run its
 * first line, and the limit has ended it before it recorded itself: then there is nothing left to be running. */
async function stubsStopped(pids: string): Promise<void> {
	const started = existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(Number) : [];
	await pollUntil(() => started.every((pid) => !processExists(pid)), "the stub that did not answer to be stopped");
}

test("a gh that does not answer in time is stopped and gives no pull request", async () => {
	const pids = join(root, "gh.pids");
	rmSync(pids, { force: true });
	// It hangs for ten minutes: a limit that ended nothing fails this test by its own timeout. How long the limit takes
	// to end it is not asserted: that depends on what else the machine is running.
	stubGh(`echo $$ >> "${pids}"\nexec /bin/sleep 600`);
	const report = await new GitProbe({ env: withStub, timeouts: { pr: 150 } }).report(repo, { pr: true });
	expect(report.pr).toBeNull();
	expect(report.git?.branch).toBe("feature/status");
	await stubsStopped(pids);
});

test("a gh whose child keeps the pipes open does not hold the report past its limit, and the child is stopped too", async () => {
	const pids = join(root, "gh-child.pids");
	rmSync(pids, { force: true });
	// The shell is gone at the limit, its `sleep` is not: it still has the pipes, and waiting for them would never end.
	stubGh(`echo $$ >> "${pids}"\n/bin/sleep 600 &\necho $! >> "${pids}"\nwait`);
	const report = await new GitProbe({ env: withStub, timeouts: { pr: 150 } }).report(repo, { pr: true });
	expect(report.pr).toBeNull();
	expect(report.git?.branch).toBe("feature/status");
	await stubsStopped(pids);
});

test("a git that does not answer in time gives no status, and no pull request is looked up", async () => {
	writeFileSync(ghLog, "");
	stubGh(`echo '{"number":1,"url":"https://github.com/o/r/pull/1"}'`);
	const pids = join(root, "git.pids");
	rmSync(pids, { force: true });
	const slowGit = join(root, "slow-bin");
	mkdirSync(slowGit, { recursive: true });
	writeFileSync(join(slowGit, "git"), `#!/bin/sh\necho $$ >> "${pids}"\nexec /bin/sleep 600\n`);
	chmodSync(join(slowGit, "git"), 0o755);
	const probe = new GitProbe({ env: { PATH: `${slowGit}:${bin}`, HOME: root }, timeouts: { status: 150 } });
	expect(await probe.report(repo, { pr: true })).toEqual({ git: null, pr: null });
	expect(ghCalls()).toBe(0);
	await stubsStopped(pids);
});

test("answers are kept for a moment and shared by simultaneous asks; a detached HEAD is not looked up", async () => {
	const calls: string[][] = [];
	let clock = 1_000;
	// The first git call is held open until the three asks have all been made.
	const release = Promise.withResolvers<void>();
	const run: Run = async (cmd) => {
		calls.push(cmd);
		await release.promise;
		if (cmd[0] === "git") return { code: 0, stdout: "# branch.oid abcdef0123\n# branch.head main\n" };
		return { code: 0, stdout: '{"number":7,"url":"https://github.com/o/r/pull/7"}' };
	};
	const probe = new GitProbe({ run: vetted(run), now: () => clock });
	// Three tabs ask at once: git runs once.
	const asks = Promise.all([probe.report(repo), probe.report(repo), probe.report(repo)]);
	release.resolve();
	await asks;
	expect(calls.filter((c) => c[0] === "git")).toHaveLength(1);
	// Within the second it is kept; after it, git is asked again.
	clock += 500;
	await probe.report(repo);
	expect(calls.filter((c) => c[0] === "git")).toHaveLength(1);
	clock += 600;
	await probe.report(repo);
	expect(calls.filter((c) => c[0] === "git")).toHaveLength(2);
	// A pull request is kept longer: a minute.
	await probe.report(repo, { pr: true });
	clock += 30_000;
	await probe.report(repo, { pr: true });
	expect(calls.filter((c) => c[0] === "gh")).toHaveLength(1);
	clock += 31_000;
	await probe.report(repo, { pr: true });
	expect(calls.filter((c) => c[0] === "gh")).toHaveLength(2);

	const detached = new GitProbe({
		run: vetted(async (cmd) => {
			if (cmd[0] === "gh") throw new Error("gh must not be asked about a detached HEAD");
			return { code: 0, stdout: "# branch.oid 5f3a1c2e9b\n# branch.head (detached)\n" };
		}),
	});
	expect(await detached.report(repo, { pr: true })).toMatchObject({ git: { detached: true }, pr: null });
});

test("a fresh ask joins a status load begun a moment ago; a later one starts its own", async () => {
	let clock = 1_000;
	let spawned = 0;
	const release = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const run: Run = async () => {
		spawned++;
		started.resolve();
		await release.promise;
		return { code: 0, stdout: "# branch.oid abcdef0123\n# branch.head main\n" };
	};
	const probe = new GitProbe({ run: vetted(run), now: () => clock });
	const first = probe.report(repo, { fresh: true });
	clock += 300;
	const second = probe.report(repo, { fresh: true });
	// Vetting is asked first (and answered at once); then the status look starts, held open by `release`.
	await started.promise;
	expect(spawned).toBe(1);
	release.resolve();
	await Promise.all([first, second]);
	// Answered 300 ms ago, begun 300 ms ago: still the same look.
	await probe.report(repo, { fresh: true });
	expect(spawned).toBe(1);
	// The tree may have changed since: a load begun 600 ms ago is not joined.
	clock += 300;
	await probe.report(repo, { fresh: true });
	expect(spawned).toBe(2);
});

test("a git or gh that does not answer in time is left alone for 30 s, fresh or not", async () => {
	let clock = 1_000;
	const calls: string[] = [];
	const run: Run = async (cmd) => {
		calls.push(cmd[0]);
		// git answers; gh runs out of time.
		return cmd[0] === "git" ? { code: 0, stdout: "# branch.oid abcdef0123\n# branch.head main\n" } : null;
	};
	const probe = new GitProbe({ run: vetted(run), now: () => clock });
	expect((await probe.report(repo, { pr: true })).pr).toBeNull();
	clock += 1_000;
	await probe.report(repo, { pr: true, fresh: true });
	clock += 20_000;
	await probe.report(repo, { pr: true, fresh: true });
	expect(calls.filter((c) => c === "gh")).toHaveLength(1);
	clock += 10_000;
	await probe.report(repo, { pr: true, fresh: true });
	expect(calls.filter((c) => c === "gh")).toHaveLength(2);

	calls.length = 0;
	const timedOut = new GitProbe({
		run: vetted(async (cmd) => {
			calls.push(cmd[0]);
			return null;
		}),
		now: () => clock,
	});
	expect((await timedOut.report(repo, { fresh: true })).git).toBeNull();
	clock += 5_000;
	await timedOut.report(repo, { fresh: true });
	expect(calls).toHaveLength(1);
	clock += 26_000;
	await timedOut.report(repo, { fresh: true });
	expect(calls).toHaveLength(2);
});

// ---------------------------------------------------------------------------------------------------------------
// A folder prepared by someone else: git does what a repository's own configuration says.

/** Git as a user's own commands run it: no machine-wide configuration, and a home of its own. */
const gitEnv = { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
function plainGit(cwd: string, ...args: string[]): string {
	const ran = Bun.spawnSync(
		["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" },
	);
	if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
	return ran.stdout.toString();
}

let counter = 0;
/** A repository with one committed file, `a.txt`, and the path of a marker that something it runs would create. */
function newRepo(): { dir: string; marker: string } {
	const n = ++counter;
	const dir = join(root, `hostile-${n}`);
	mkdirSync(dir);
	plainGit(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "a.txt"), "a\n");
	plainGit(dir, "add", ".");
	plainGit(dir, "commit", "-q", "-m", "first");
	return { dir, marker: join(root, `marker-${n}`) };
}

/** Make git think a file may have changed without changing it: checking it means reading it through its filter. */
function touch(dir: string, file = "a.txt"): void {
	const later = Date.now() / 1000 + 60;
	utimesSync(join(dir, file), later, later);
}

/** What an unguarded `git status` of the folder does; the marker shows whether it ran the program. */
function unguardedLook(dir: string): void {
	Bun.spawnSync(["git", "--no-optional-locks", "status", "--porcelain=v2", "--branch"], {
		cwd: dir,
		env: gitEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
}

const global = join(root, ".gitconfig");

interface Hostile {
	name: string;
	/** Prepare the repository so that git, asked for its status, would run `marker`'s program. */
	setup(dir: string, marker: string): void;
	/** Whether an unguarded `git status` really runs it (the others are refused for what they name, not for what they do). */
	runs: boolean;
}

/** The probe's PATH is only the stub directory and git's own, so the programs name what they use by path: a program that cannot start proves nothing. */
const program = (marker: string) => `/usr/bin/touch ${marker}; /bin/cat`;
const hostile: Hostile[] = [
	{
		name: "core.fsmonitor naming a program",
		setup(dir, marker) {
			const hook = join(dir, "hook.sh");
			writeFileSync(hook, `#!/bin/sh\n/usr/bin/touch ${marker}\nprintf '\\0'\n`);
			chmodSync(hook, 0o755);
			plainGit(dir, "config", "core.fsmonitor", hook);
		},
		runs: true,
	},
	{
		name: "a clean filter in the configuration, chosen in .git/info/attributes",
		setup(dir, marker) {
			plainGit(dir, "config", "filter.evil.clean", program(marker));
			writeFileSync(join(dir, ".git", "info", "attributes"), "a.txt filter=evil\n");
			touch(dir);
		},
		runs: true,
	},
	{
		name: "a clean filter that an included file defines",
		setup(dir, marker) {
			writeFileSync(join(dir, ".git", "extra.cfg"), `[filter "evil"]\n\tclean = ${program(marker)}\n`);
			plainGit(dir, "config", "include.path", "extra.cfg");
			writeFileSync(join(dir, ".git", "info", "attributes"), "a.txt filter=evil\n");
			touch(dir);
		},
		runs: true,
	},
	{
		name: "a filter of the user's own, chosen in .git/info/attributes",
		setup(dir) {
			writeFileSync(global, `[filter "mark"]\n\tclean = ${program(join(root, "global-marker"))}\n`);
			writeFileSync(join(dir, ".git", "info", "attributes"), "a.txt filter=mark\n");
			touch(dir);
		},
		runs: false,
	},
	{
		name: "a textconv driver",
		setup(dir, marker) {
			plainGit(dir, "config", "diff.evil.textconv", program(marker));
		},
		runs: false,
	},
	{
		name: "a merge driver",
		setup(dir, marker) {
			plainGit(dir, "config", "merge.evil.driver", program(marker));
		},
		runs: false,
	},
	{
		name: "core.pager, core.sshCommand and core.attributesFile",
		setup(dir, marker) {
			plainGit(dir, "config", "core.pager", program(marker));
			plainGit(dir, "config", "core.sshCommand", program(marker));
			plainGit(dir, "config", "core.attributesFile", ".gitattributes");
		},
		runs: false,
	},
];

for (const h of hostile) {
	test(`a repository with ${h.name} is not looked at: no status, no pull request, and nothing is run`, async () => {
		const { dir, marker } = newRepo();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			h.setup(dir, marker);
			// The control: without the guard, the look would run it.
			if (h.runs) {
				unguardedLook(dir);
				const ran = existsSync(marker);
				rmSync(marker, { force: true });
				expect(ran, "an unguarded git status runs it").toBe(true);
				touch(dir);
			}
			writeFileSync(ghLog, "");
			stubGh(`echo '{"number":3,"url":"https://github.com/o/r/pull/3"}'`);
			const probe = new GitProbe({ env: withStub });
			expect(await probe.report(dir, { pr: true })).toEqual({ git: null, pr: null });
			// A folder inside it is the same repository.
			mkdirSync(join(dir, "sub"));
			expect((await new GitProbe({ env: withStub }).report(join(dir, "sub"))).git).toBeNull();
			expect(existsSync(marker), "nothing was run").toBe(false);
			expect(existsSync(join(root, "global-marker"))).toBe(false);
			expect(ghCalls()).toBe(0);
			// The log says which folder, once per probe.
			const said = warn.mock.calls.filter(([line]) => String(line).includes(dir));
			expect(said.length).toBeGreaterThanOrEqual(1);
		} finally {
			warn.mockRestore();
			rmSync(global, { force: true });
		}
	});
}

test("what a repository's own .gitattributes asks for is not read: a filter of the user's own is not run for its files", async () => {
	const { dir, marker } = newRepo();
	try {
		writeFileSync(global, `[filter "mark"]\n\tclean = ${program(marker)}\n`);
		writeFileSync(join(dir, ".gitattributes"), "a.txt filter=mark\n");
		touch(dir);
		// The control: git reads it, and runs the user's filter on a file somebody else wrote.
		unguardedLook(dir);
		expect(existsSync(marker), "an unguarded git status runs it").toBe(true);
		rmSync(marker);
		touch(dir);

		const report = await new GitProbe({ env: withStub }).report(dir);
		expect(existsSync(marker), "the look does not").toBe(false);
		// And it still answers: the file is the same, so nothing is changed.
		expect(report.git).toEqual({ branch: "main", detached: false, staged: 0, unstaged: 0, untracked: 1 });
	} finally {
		rmSync(global, { force: true });
	}
});

test("a repository that sets what the look overrides, or only switches, is looked at like any other", async () => {
	const { dir } = newRepo();
	plainGit(dir, "config", "core.fsmonitor", "false");
	plainGit(dir, "config", "core.hooksPath", ".husky");
	plainGit(dir, "config", "pager.status", "true");
	plainGit(dir, "config", "alias.st", "status");
	plainGit(dir, "config", "branch.main.remote", "origin");
	writeFileSync(join(dir, ".git", "info", "attributes"), "# a comment\n*.png -diff\n*.lock -merge\n");
	const report = await new GitProbe({ env: withStub }).report(dir);
	expect(report.git).toMatchObject({ branch: "main", detached: false });
});

test("a linked worktree is vetted by the repository it shares its configuration with", async () => {
	const { dir, marker } = newRepo();
	const linked = join(root, "linked-worktree");
	plainGit(dir, "worktree", "add", "-q", "-b", "side", linked);
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect((await new GitProbe({ env: withStub }).report(linked)).git).toMatchObject({ branch: "side" });
		plainGit(dir, "config", "filter.evil.clean", program(marker));
		expect((await new GitProbe({ env: withStub }).report(linked)).git).toBeNull();
		expect(existsSync(marker)).toBe(false);
	} finally {
		warn.mockRestore();
	}
});

test("the look runs git without an fsmonitor, without hooks, without the folder's attributes and without entering submodules", async () => {
	// The empty tree is what git calls it in every repository.
	const empty = plainGit(repo, "hash-object", "-t", "tree", "/dev/null").trim();
	expect(empty).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
	const seen: string[][] = [];
	const probe = new GitProbe({
		run: vetted(async (cmd) => {
			seen.push(cmd);
			return { code: 0, stdout: "# branch.oid abcdef0123\n# branch.head main\n" };
		}),
	});
	await probe.report(repo);
	expect(seen).toEqual([
		[
			"git",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.hooksPath=/dev/null",
			`--attr-source=${empty}`,
			"--no-optional-locks",
			"status",
			"--porcelain=v2",
			"--branch",
			"--ignore-submodules=all",
		],
	]);
});

test("a repository is vetted by git's own reading of its configuration: the repository's scopes, includes followed, switches allowed", () => {
	// `scope NUL key LF value NUL`, as `git config --list --show-scope -z` prints it.
	const listing = (...entries: [string, string][]) => entries.map(([scope, entry]) => `${scope}\0${entry}\0`).join("");
	expect(commandKeys(listing(["local", "core.fsmonitor\n/tmp/hook"]))).toEqual(["core.fsmonitor"]);
	expect(commandKeys(listing(["worktree", "filter.lfs.clean\ngit-lfs clean -- %f"]))).toEqual(["filter.lfs.clean"]);
	expect(commandKeys(listing(["local", "filter.x.smudge\ncat"], ["local", "filter.x.process\ncat"]))).toEqual([
		"filter.x.smudge",
		"filter.x.process",
	]);
	expect(commandKeys(listing(["local", "diff.x.textconv\ncat"], ["local", "diff.external\ncat"]))).toHaveLength(2);
	expect(commandKeys(listing(["local", "merge.x.driver\ncat %A"], ["local", "gpg.ssh.program\nx"]))).toHaveLength(2);
	expect(commandKeys(listing(["local", "core.pager\nless"], ["local", "pager.status\nless"]))).toHaveLength(2);
	// A switch is not a command: git's own fsmonitor daemon, a pager turned on, one written without `=`.
	for (const entry of [
		"core.fsmonitor\ntrue",
		"core.fsmonitor\nfalse",
		"core.fsmonitor",
		"core.fsmonitor\n",
		"pager.log\nyes",
	]) {
		expect(commandKeys(listing(["local", entry])), entry).toEqual([]);
	}
	// What is the user's own is not asked about: their Git LFS filters are global, and the system's are the machine's.
	expect(
		commandKeys(
			listing(
				["system", "filter.lfs.clean\ngit-lfs clean -- %f"],
				["global", "filter.lfs.process\ngit-lfs filter-process"],
				["global", "core.fsmonitor\n/usr/local/bin/watch"],
				["command", "core.hooksPath\n/dev/null"],
			),
		),
	).toEqual([]);
	// Other keys, hooks included (the look turns them off), and everything of a different name, are fine.
	expect(
		commandKeys(
			listing(
				["local", "core.hookspath\n.husky"],
				["local", "filter.lfs.required\ntrue"],
				["local", "remote.origin.url\nhttps://github.com/o/r.git"],
				["local", "alias.st\n!echo hi"],
			),
		),
	).toEqual([]);
	expect(commandKeys("")).toEqual([]);
	expect(commandKeys("local")).toEqual([]);
});

test("an attributes file is refused for the filters and drivers it gives a path, not for what it turns off", () => {
	expect(commandAttributes("a.txt filter=lfs\n")).toEqual(["a.txt filter=lfs"]);
	expect(commandAttributes("*.md  text   diff=markdown\n")).toHaveLength(1);
	expect(commandAttributes("*.lock merge=ours\n")).toHaveLength(1);
	expect(commandAttributes('"a b.txt" eol=lf filter=x\n')).toHaveLength(1);
	expect(commandAttributes("[attr]lfs filter=lfs\n")).toHaveLength(1);
	expect(commandAttributes("# a.txt filter=lfs\n\n*.png -diff\n*.lock -merge -filter\n*.bin binary !diff\n")).toEqual(
		[],
	);
	expect(commandAttributes("")).toEqual([]);
});
