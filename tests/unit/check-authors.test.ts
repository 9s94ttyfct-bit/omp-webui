import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED, ALLOWED_NAMES } from "../../scripts/check-authors.ts";

/**
 * scripts/check-authors.ts in a throwaway repository: only the maintainer's handle and noreply address may author or
 * commit what is about to be published, or tag it, in each of the ways the script finds those commits.
 */

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "check-authors.ts");
const GOOD = ALLOWED[0];
const NAME = ALLOWED_NAMES[0];
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

/** A commit with this author and committer address (and name, the maintainer's handle unless given); returns its sha. */
function commit(author = GOOD, committer = author, names: { author?: string; committer?: string } = {}): string {
	writeFileSync(join(repo, `f${n}`), String(n++));
	git(["add", "-A"]);
	git(["commit", "-q", "-m", `c${n}`], {
		GIT_AUTHOR_NAME: names.author ?? NAME,
		GIT_AUTHOR_EMAIL: author,
		GIT_COMMITTER_NAME: names.committer ?? NAME,
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

/** Runs the script as GitHub Actions would for this event, on `sha` (GITHUB_SHA, HEAD unless given). */
function checkEvent(name: string, event: unknown, sha = git(["rev-parse", "HEAD"])) {
	const file = join(base, "event.json");
	writeFileSync(file, JSON.stringify(event));
	return check([], { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: file, GITHUB_SHA: sha });
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
	expect(r.out).toContain(`author ${NAME} <${OTHER}>`);
});

test("a commit committed with another address fails too, even with the noreply author", () => {
	const bad = commit(GOOD, OTHER);
	const r = check();
	expect(r.code).toBe(1);
	expect(r.out).toContain(`${bad.slice(0, 12)} author ${NAME} <${GOOD}>, committer ${NAME} <${OTHER}>`);
});

test("a commit whose author or committer name is not the maintainer's handle fails, with the allowed address", () => {
	const byName = commit(GOOD, GOOD, { author: "Real Person" });
	const r = check();
	expect(r.code).toBe(1);
	expect(r.out).toContain(`${byName.slice(0, 12)} author Real Person <${GOOD}>`);
	const committed = commit(GOOD, GOOD, { committer: "Real Person" });
	const later = check([`${byName}..${committed}`]);
	expect(later.code).toBe(1);
	expect(later.out).toContain(`${committed.slice(0, 12)} author ${NAME} <${GOOD}>, committer Real Person <${GOOD}>`);
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

test("in GitHub Actions, a run by hand or on a schedule reads all of the commit's history", () => {
	commit(OTHER);
	const head = commit();
	for (const name of ["workflow_dispatch", "schedule"]) {
		const r = checkEvent(name, { ref: "refs/heads/main" }, head);
		expect(r.code, name).toBe(1);
		expect(r.out).toContain(`author ${NAME} <${OTHER}>`);
		expect(r.out).toContain(`this ${name} (${head})`);
	}
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

test("as a pre-push hook, an annotated tag's tagger must be the maintainer's handle and address, though origin has its commit", () => {
	Bun.spawnSync(["git", "init", "--bare", "-q", join(base, "origin.git")]);
	git(["remote", "add", "origin", join(base, "origin.git")]);
	commit();
	git(["push", "-q", "origin", "main"]);
	const zero = "0".repeat(40);
	const tag = (name: string, who: string, email: string) => {
		git(["-c", `user.name=${who}`, "-c", `user.email=${email}`, "tag", "-a", name, "-m", "t"]);
		const sha = git(["rev-parse", `refs/tags/${name}`]);
		return check(["--pre-push", "origin"], {}, `refs/tags/${name} ${sha} refs/tags/${name} ${zero}\n`);
	};
	expect(tag("v1.0.0", NAME, GOOD).code).toBe(0);
	const r = tag("v9.9.9", "Real Person", "real.person@example.org");
	expect(r.code).toBe(1);
	expect(r.out).toContain("v9.9.9");
	expect(r.out).toContain("tagger Real Person <real.person@example.org>");
	expect(tag("v9.9.8", "Real Person", GOOD).code).toBe(1);
});
