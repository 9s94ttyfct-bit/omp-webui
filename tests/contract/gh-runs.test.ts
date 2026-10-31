import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiAnswer, CiJob, CiRuns } from "../../shared/ci.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * `/api/github/runs` and `/api/github/run`, the CI tab's routes, against the real server: a temporary repository on a
 * branch, and a stand-in `gh` first on the server's PATH that answers from files (synthetic runs and jobs) and notes what it
 * was asked. A second server has no `gh` at all. Nothing reaches GitHub.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-gh-runs-http-"));
const repo = join(root, "repo");
const stubs = join(root, "stubs");
const log = join(stubs, "gh.log");
let withGh: TestServer;
let withoutGh: TestServer;

const RUNS = [
	{
		databaseId: 501,
		workflowName: "CI",
		displayTitle: "Add the CI tab",
		headBranch: "feat/ci",
		headSha: "c0ffee1",
		event: "push",
		status: "in_progress",
		conclusion: "",
		createdAt: "2026-10-30T09:00:00Z",
		startedAt: "2026-10-30T09:00:04Z",
		updatedAt: "2026-10-30T09:01:00Z",
		url: "https://github.com/o/r/actions/runs/501",
	},
];
const JOBS = {
	jobs: [
		{
			databaseId: 9001,
			name: "unit",
			status: "completed",
			conclusion: "failure",
			startedAt: "2026-10-30T09:00:10Z",
			completedAt: "2026-10-30T09:00:50Z",
			url: "https://github.com/o/r/actions/runs/501/job/9001",
			steps: [{ name: "bun test", status: "completed", conclusion: "failure", number: 3 }],
		},
	],
};

function git(...args: string[]): void {
	const ran = Bun.spawnSync(
		["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd: repo, stdout: "pipe", stderr: "pipe" },
	);
	if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
}

beforeAll(async () => {
	mkdirSync(repo, { recursive: true });
	mkdirSync(stubs, { recursive: true });
	git("init", "-q", "-b", "feat/ci");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git("add", ".");
	git("commit", "-q", "-m", "first");
	writeFileSync(join(stubs, "runs.json"), JSON.stringify(RUNS));
	writeFileSync(join(stubs, "jobs.json"), JSON.stringify(JOBS));
	const gh = join(stubs, "gh");
	writeFileSync(
		gh,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> '${log}'`,
			`if [ -f '${join(stubs, "fail")}' ]; then cat '${join(stubs, "fail")}' >&2; exit 1; fi`,
			'case "$1 $2" in',
			`  "run list") cat '${join(stubs, "runs.json")}';;`,
			`  "run view") cat '${join(stubs, "jobs.json")}';;`,
			"  *) echo 'not scripted' >&2; exit 1;;",
			"esac",
			"",
		].join("\n"),
	);
	chmodSync(gh, 0o755);
	withGh = await startTestServer(0, { PATH: `${stubs}:${process.env.PATH ?? ""}` }, { login: false });
	// A PATH with the tools the server needs (bun, git, and ps for its instance record) and nothing else: no `gh`.
	const tools = join(root, "tools");
	mkdirSync(tools, { recursive: true });
	for (const name of ["bun", "git", "ps"]) symlinkSync(Bun.which(name) ?? name, join(tools, name));
	withoutGh = await startTestServer(0, { PATH: tools }, { login: false });
}, 90_000);

afterAll(async () => {
	await withGh?.stop();
	await withoutGh?.stop();
	rmSync(root, { recursive: true, force: true });
});

const post = (s: TestServer, path: string, body: unknown, method = "POST") =>
	fetch(`${s.url}${path}`, {
		method,
		headers: {
			"x-omp-webui-token": s.accessToken,
			"x-omp-webui": "1",
			Origin: s.url,
			"content-type": "application/json",
		},
		body: method === "GET" ? undefined : JSON.stringify(body),
	});
const asked = (): string[] => {
	try {
		return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
};

test("asking GitHub is a POST: a GET of either route is refused", async () => {
	for (const path of ["/api/github/runs", "/api/github/run"]) {
		const r = await post(withGh, path, null, "GET");
		expect(r.status, path).toBe(405);
	}
});

test("the branch's runs come from gh run list with --branch; pages that ask within the interval share one look", async () => {
	const before = asked().length;
	const r = await post(withGh, "/api/github/runs", { cwd: repo });
	expect(r.status).toBe(200);
	const answer = (await r.json()) as CiAnswer<CiRuns>;
	expect(answer).toMatchObject({
		ok: true,
		value: {
			scope: "branch",
			branch: "feat/ci",
			runs: [{ id: 501, workflow: "CI", title: "Add the CI tab", state: "running", branch: "feat/ci" }],
		},
	});
	// A run is at work: the next look is due in about 10 s.
	expect(answer.nextMs).toBeGreaterThan(9000);
	expect(answer.nextMs).toBeLessThanOrEqual(10_250);
	const calls = asked().slice(before);
	expect(calls).toHaveLength(1);
	expect(calls[0]).toStartWith("run list --json ");
	expect(calls[0]).toContain("--branch feat/ci");

	// Three more pages at once: the same look, gh not asked again.
	const again = await Promise.all(
		[1, 2, 3].map(() => post(withGh, "/api/github/runs", { cwd: repo, scope: "branch" })),
	);
	for (const a of again) expect(((await a.json()) as CiAnswer<CiRuns>).ok).toBe(true);
	expect(asked().length).toBe(before + 1);

	// Every branch is another list; Refresh looks again.
	const all = (await (await post(withGh, "/api/github/runs", { cwd: repo, scope: "all" })).json()) as CiAnswer<CiRuns>;
	expect(all).toMatchObject({ ok: true, value: { scope: "all" } });
	expect(asked().at(-1)).not.toContain("--branch");
	await post(withGh, "/api/github/runs", { cwd: repo, fresh: true });
	expect(asked().length).toBe(before + 3);
});

test("a run's jobs come from gh run view, with the step that failed and the job's page", async () => {
	const r = await post(withGh, "/api/github/run", { cwd: repo, id: 501 });
	const answer = (await r.json()) as CiAnswer<CiJob[]>;
	expect(answer).toMatchObject({
		ok: true,
		value: [
			{
				id: 9001,
				name: "unit",
				state: "failure",
				failedStep: "bun test",
				url: "https://github.com/o/r/actions/runs/501/job/9001",
			},
		],
	});
	expect(asked().at(-1)).toBe("run view 501 --json jobs");
	const bad = (await (await post(withGh, "/api/github/run", { cwd: repo, id: "x" })).json()) as CiAnswer<CiJob[]>;
	expect(bad).toMatchObject({ ok: false, problem: "failed" });
});

test("what gh says on a failure is a problem the page explains, with no token in it", async () => {
	const token = `gho_${"Z".repeat(36)}`;
	writeFileSync(join(stubs, "fail"), `HTTP 401: Bad credentials (${token})\n`);
	try {
		const r = await post(withGh, "/api/github/runs", { cwd: repo, fresh: true });
		const text = await r.text();
		expect(text).not.toContain(token);
		expect(JSON.parse(text)).toMatchObject({
			ok: false,
			problem: "failed",
			message: "HTTP 401: Bad credentials ([token])",
		});
		writeFileSync(join(stubs, "fail"), "HTTP 403: API rate limit exceeded for user ID 1\n");
		const limited = (await (
			await post(withGh, "/api/github/runs", { cwd: repo, fresh: true })
		).json()) as CiAnswer<CiRuns>;
		expect(limited).toMatchObject({ ok: false, problem: "rate-limited" });
		// Backed off: the page is told to wait minutes, not seconds.
		expect(limited.nextMs).toBeGreaterThan(5 * 60_000);
	} finally {
		rmSync(join(stubs, "fail"), { force: true });
	}
});

test("a folder that is not a repository says so without asking gh; a server without gh says gh is missing", async () => {
	const plain = join(root, "plain");
	mkdirSync(plain, { recursive: true });
	const before = asked().length;
	const r = (await (await post(withGh, "/api/github/runs", { cwd: plain })).json()) as CiAnswer<CiRuns>;
	expect(r).toMatchObject({ ok: false, problem: "no-repo" });
	expect(asked().length).toBe(before);

	const missing = (await (await post(withoutGh, "/api/github/runs", { cwd: repo })).json()) as CiAnswer<CiRuns>;
	expect(missing).toMatchObject({ ok: false, problem: "no-gh" });
});
