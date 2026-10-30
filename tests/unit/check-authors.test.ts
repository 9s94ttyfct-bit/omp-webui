import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED } from "../../scripts/check-authors.ts";

/**
 * scripts/check-authors.ts in a throwaway repository: only the maintainer's noreply address may author or commit what is
 * about to be published, in each of the ways the script finds those commits.
 */

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "check-authors.ts");
const GOOD = ALLOWED[0];
const OTHER = "someone@example.com";

let base: string;
let repo: string;
let n = 0;

/** This process's environment without what would change the case: GitHub Actions' event, and git's identity. */
const clean = () =>
	Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GITHUB_") && !k.startsWith("GIT_")));

function git(args: string[], env: Record<string, string> = {}): string {
	const r = Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...clean(), ...env }, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

/** A commit with this author and committer address; returns its sha. */
function commit(author = GOOD, committer = author): string {
	writeFileSync(join(repo, `f${n}`), String(n++));
	git(["add", "-A"]);
	git(["commit", "-q", "-m", `c${n}`], {
		GIT_AUTHOR_NAME: "a",
		GIT_AUTHOR_EMAIL: author,
		GIT_COMMITTER_NAME: "c",
		GIT_COMMITTER_EMAIL: committer,
	});
	return git(["rev-parse", "HEAD"]);
}

function check(args: string[] = [], env: Record<string, string> = {}, stdin?: string) {
	const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
		cwd: repo,
		env: { ...clean(), ...env },
		stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

/** Runs the script as GitHub Actions would for this event. */
function checkEvent(name: string, event: unknown) {
	const file = join(base, "event.json");
	writeFileSync(file, JSON.stringify(event));
	return check([], { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: file });
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "ompw-authors-test-"));
	repo = join(base, "repo");
	mkdirSync(repo);
	git(["init", "-q", "-b", "main"]);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

test("commits authored and committed with the noreply address pass", () => {
	commit();
	commit();
	const r = check();
	expect(r.out).toContain("Commit authors and committers allowed");
	expect(r.code).toBe(0);
});

test("a commit authored with another address fails, naming it and the address", () => {
	commit();
	const bad = commit(OTHER, GOOD);
	const r = check();
	expect(r.code).toBe(1);
	expect(r.out).toContain(bad.slice(0, 12));
	expect(r.out).toContain(`author ${OTHER}`);
});

test("a commit committed with another address fails too, even with the noreply author", () => {
	const bad = commit(GOOD, OTHER);
	const r = check();
	expect(r.code).toBe(1);
	expect(r.out).toContain(`${bad.slice(0, 12)} author ${GOOD}, committer ${OTHER}`);
});

test("locally, only what origin does not have yet is read", () => {
	Bun.spawnSync(["git", "init", "--bare", "-q", join(base, "origin.git")]);
	git(["remote", "add", "origin", join(base, "origin.git")]);
	commit(OTHER);
	git(["push", "-q", "origin", "main"]);
	commit();
	expect(check().code).toBe(0);
	commit(OTHER);
	expect(check().code).toBe(1);
});

test("in GitHub Actions, a push reads before..after, and all of after's history for a new branch", () => {
	commit(OTHER);
	const before = commit();
	const after = commit();
	expect(checkEvent("push", { before, after }).code).toBe(0);
	const newBranch = checkEvent("push", { before: "0".repeat(40), after });
	expect(newBranch.code).toBe(1);
	expect(newBranch.out).toContain(OTHER);
	// A `before` the clone does not have (a force push): the whole history is read.
	expect(checkEvent("push", { before: "1".repeat(40), after }).code).toBe(1);
});

test("in GitHub Actions, a pull request reads base..head", () => {
	const baseSha = commit(OTHER);
	const head = commit();
	expect(checkEvent("pull_request", { pull_request: { base: { sha: baseSha }, head: { sha: head } } }).code).toBe(0);
	const bad = commit(OTHER);
	const r = checkEvent("pull_request", { pull_request: { base: { sha: baseSha }, head: { sha: bad } } });
	expect(r.code).toBe(1);
	expect(r.out).toContain(bad.slice(0, 12));
});

test("as a pre-push hook, each pushed ref's new commits are read, and a deleted ref is nothing", () => {
	Bun.spawnSync(["git", "init", "--bare", "-q", join(base, "origin.git")]);
	git(["remote", "add", "origin", join(base, "origin.git")]);
	commit(OTHER);
	git(["push", "-q", "origin", "main"]);
	const good = commit();
	const zero = "0".repeat(40);
	expect(check(["--pre-push", "origin"], {}, `refs/heads/main ${good} refs/heads/main ${zero}\n`).code).toBe(0);
	expect(check(["--pre-push", "origin"], {}, `(delete) ${zero} refs/heads/old ${good}\n`).code).toBe(0);
	const bad = commit(GOOD, OTHER);
	const r = check(["--pre-push", "origin"], {}, `refs/heads/main ${bad} refs/heads/main ${zero}\n`);
	expect(r.code).toBe(1);
	expect(r.out).toContain(bad.slice(0, 12));
});
