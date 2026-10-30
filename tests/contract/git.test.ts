import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitReport } from "../../shared/git.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * `/api/git`, the status line's branch, change counts and pull request, against the real server: a temporary
 * repository, `gh` a script on the server's PATH. A second server has no `gh` at all.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-git-http-"));
const repo = join(root, "repo");
const stubs = join(root, "stubs");
const saved = { ...process.env };
let withGh: TestServer;
let withoutGh: TestServer;

function gitIn(cwd: string, ...args: string[]): void {
	const ran = Bun.spawnSync(
		["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, stdout: "pipe", stderr: "pipe" },
	);
	if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
}
const git = (...args: string[]) => gitIn(repo, ...args);

beforeAll(async () => {
	mkdirSync(repo, { recursive: true });
	mkdirSync(stubs, { recursive: true });
	git("init", "-q", "-b", "main");
	writeFileSync(join(repo, "tracked.txt"), "one\n");
	git("add", ".");
	git("commit", "-q", "-m", "first");
	git("checkout", "-q", "-b", "fix/status-line");
	writeFileSync(join(repo, "tracked.txt"), "two\n");
	writeFileSync(join(repo, "untracked.txt"), "x\n");
	const gh = join(stubs, "gh");
	writeFileSync(gh, `#!/bin/sh\necho '{"number":149,"url":"https://github.com/o/r/pull/149"}'\n`);
	chmodSync(gh, 0o755);

	Object.assign(process.env, await isolatedEnv(root));
	process.env.PATH = `${stubs}:${saved.PATH}`;
	withGh = await startTestServer();
	// A PATH with the tools the server needs (bun, git, and ps for its instance record) and nothing else: no `gh`.
	const tools = join(root, "tools");
	mkdirSync(tools, { recursive: true });
	for (const name of ["bun", "git", "ps"])
		symlinkSync(Bun.which(name, { PATH: saved.PATH }) ?? name, join(tools, name));
	process.env.PATH = tools;
	withoutGh = await startTestServer();
}, 90_000);

afterAll(async () => {
	await withGh?.stop();
	await withoutGh?.stop();
	process.env = saved;
	rmSync(root, { recursive: true, force: true });
});

/** The page asks for the pull request (`pr=1`) or a fresh look (`fresh=1`) with a POST, and for the branch alone with a GET. */
const ask = (s: TestServer, query: string, method = /(^|&)(pr|fresh)=1/.test(query) ? "POST" : "GET") =>
	fetch(`${s.url}/api/git?${query}`, {
		method,
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", Origin: s.url },
	});
const report = async (s: TestServer, query: string): Promise<GitReport> => (await ask(s, query)).json();

test("asking for the pull request or a fresh look is a POST: a GET of it is refused", async () => {
	for (const query of ["pr=1", "fresh=1", "pr=1&fresh=1"]) {
		const r = await ask(withGh, `cwd=${encodeURIComponent(repo)}&${query}`, "GET");
		expect(r.status, query).toBe(405);
		expect(await r.json()).toEqual({ error: "POST required" });
	}
});

test("the branch and the change counts come without waiting for the pull request", async () => {
	const r = await report(withGh, `cwd=${encodeURIComponent(repo)}`);
	expect(r).toEqual({ git: { branch: "fix/status-line", detached: false, staged: 0, unstaged: 1, untracked: 1 } });
});

test("the pull request is asked for with pr=1 and comes from gh", async () => {
	const r = await report(withGh, `cwd=${encodeURIComponent(repo)}&pr=1`);
	expect(r.git?.branch).toBe("fix/status-line");
	expect(r.pr).toEqual({ number: 149, url: "https://github.com/o/r/pull/149" });
	// Asking again, fresh, gives the same.
	expect((await report(withGh, `cwd=${encodeURIComponent(repo)}&pr=1&fresh=1`)).pr?.number).toBe(149);
});

test("a new change shows once the answer is asked fresh", async () => {
	// A fresh ask joins a look taken within the last half second.
	await Bun.sleep(600);
	writeFileSync(join(repo, "second.txt"), "y\n");
	const r = await report(withGh, `cwd=${encodeURIComponent(repo)}&fresh=1`);
	expect(r.git?.untracked).toBe(2);
});

test("a folder outside any repository reports none, and a server without gh still answers with the branch", async () => {
	const plain = join(root, "plain");
	mkdirSync(plain, { recursive: true });
	expect(await report(withGh, `cwd=${encodeURIComponent(plain)}&pr=1`)).toEqual({ git: null, pr: null });

	const r = await report(withoutGh, `cwd=${encodeURIComponent(repo)}&pr=1`);
	expect(r.git?.branch).toBe("fix/status-line");
	expect(r.pr).toBeNull();
});

test("a folder that is not there, a file and no folder at all are refused like the other endpoints refuse them", async () => {
	for (const query of [
		`cwd=${encodeURIComponent(join(root, "missing"))}`,
		`cwd=${encodeURIComponent(join(repo, "tracked.txt"))}`,
		"",
	]) {
		const r = await ask(withGh, query);
		expect(r.status, query).toBe(400);
		expect(await r.json()).toEqual({ error: "Not a directory" });
	}
});

test("without the access token there is no answer", async () => {
	const r = await fetch(`${withGh.url}/api/git?cwd=${encodeURIComponent(repo)}`);
	expect(r.status).toBe(401);
});

test("a folder prepared with a configuration that runs a program is not looked at, and the program is not run", async () => {
	const evil = join(root, "evil");
	const marker = join(root, "evil-ran");
	mkdirSync(evil, { recursive: true });
	gitIn(evil, "init", "-q", "-b", "main");
	writeFileSync(join(evil, "a.txt"), "a\n");
	gitIn(evil, "add", ".");
	gitIn(evil, "commit", "-q", "-m", "first");
	// core.fsmonitor is run on every `git status`; the filter on every file its attribute names, and info/attributes needs no commit.
	const hook = join(evil, "hook.sh");
	writeFileSync(hook, `#!/bin/sh\n/usr/bin/touch ${marker}\nprintf '\\0'\n`);
	chmodSync(hook, 0o755);
	gitIn(evil, "config", "core.fsmonitor", hook);
	gitIn(evil, "config", "filter.evil.clean", `/usr/bin/touch ${marker}; /bin/cat`);
	writeFileSync(join(evil, ".git", "info", "attributes"), "a.txt filter=evil\n");
	const later = Date.now() / 1000 + 60;
	utimesSync(join(evil, "a.txt"), later, later);

	const asked = [
		`cwd=${encodeURIComponent(evil)}`,
		`cwd=${encodeURIComponent(evil)}&pr=1`,
		`cwd=${encodeURIComponent(evil)}&fresh=1`,
	];
	for (const query of asked) {
		expect(await report(withGh, query), query).toEqual(
			query.includes("pr=1") ? { git: null, pr: null } : { git: null },
		);
	}
	expect(existsSync(marker)).toBe(false);
});

test("a submodule whose own git directory names a program is not asked to run it by the look at its parent", async () => {
	const inner = join(root, "inner");
	const outer = join(root, "outer");
	const marker = join(root, "submodule-ran");
	for (const dir of [inner, outer]) {
		mkdirSync(dir, { recursive: true });
		gitIn(dir, "init", "-q", "-b", "main");
		writeFileSync(join(dir, "a.txt"), "a\n");
		gitIn(dir, "add", ".");
		gitIn(dir, "commit", "-q", "-m", "first");
	}
	gitIn(outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub");
	gitIn(outer, "commit", "-q", "-m", "with a submodule");
	// The submodule's git directory lives in the parent's (`.git/modules/sub`) and is not the parent's own: what is
	// vetted for the parent (its configuration, its info/attributes) does not cover it, and `git status` runs a
	// `git status` of its own in the submodule's folder, with its configuration and attributes.
	const hook = join(outer, "hook.sh");
	writeFileSync(hook, `#!/bin/sh\n/usr/bin/touch ${marker}\nprintf '\\0'\n`);
	chmodSync(hook, 0o755);
	const subGit = join(outer, ".git", "modules", "sub");
	gitIn(outer, "config", "--file", join(subGit, "config"), "core.fsmonitor", hook);
	gitIn(outer, "config", "--file", join(subGit, "config"), "filter.evil.clean", `/usr/bin/touch ${marker}; /bin/cat`);
	mkdirSync(join(subGit, "info"), { recursive: true });
	writeFileSync(join(subGit, "info", "attributes"), "a.txt filter=evil\n");
	// A change of the same size as the file, newer than the submodule's index: to tell whether it differs, its status has
	// to hash the file, which runs the clean filter (a change of size would be seen without reading it).
	writeFileSync(join(outer, "sub", "a.txt"), "b\n");
	const later = Date.now() / 1000 + 60;
	utimesSync(join(outer, "sub", "a.txt"), later, later);

	for (const query of [
		`cwd=${encodeURIComponent(outer)}`,
		`cwd=${encodeURIComponent(outer)}&pr=1`,
		`cwd=${encodeURIComponent(outer)}&fresh=1`,
	]) {
		// The parent itself is fine: it is still looked at, with its own branch; only the submodule is not entered.
		expect((await report(withGh, query)).git?.branch, query).toBe("main");
	}
	expect(existsSync(marker)).toBe(false);
});
