import { expect, test } from "bun:test";
import { join } from "node:path";
import type { GhRan, GhRun } from "../../server/gh-issues.ts";
import { ciProblemOf, GhRuns, parseJobs, parseRunList, stateOf } from "../../server/gh-runs.ts";
import {
	CI_ACTIVE_MS,
	CI_IDLE_MS,
	CI_MAX_BACKOFF_MS,
	type CiRun,
	type CiRuns,
	ciBadge,
	ciDurationMs,
	ciPollMs,
	finishedRuns,
} from "../../shared/ci.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * The CI tab's reader of GitHub Actions runs: what it asks the person's `gh`, how it reads the answers (synthetic fixtures in
 * the shape of `gh run list --json` and `gh run view --json jobs`), what it says when there is none, and how often one
 * repository's runs are looked at however many pages ask. Against a scripted `gh` and git: nothing here reaches GitHub.
 */

const DIR = tempDir("ompw-gh-runs-");

const RUN = {
	databaseId: 101,
	workflowName: "CI",
	displayTitle: "Fix the sidebar",
	headBranch: "feat/x",
	headSha: "aaaa111",
	event: "push",
	status: "completed",
	conclusion: "success",
	createdAt: "2026-10-01T10:00:00Z",
	startedAt: "2026-10-01T10:00:05Z",
	updatedAt: "2026-10-01T10:03:05Z",
	url: "https://github.com/o/r/actions/runs/101",
};

const ok = (value: unknown): GhRan => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

/** A world where git answers as a clean repository on `branch` does, and `gh` as scripted; every command is noted. */
function world(gh: (argv: string[]) => GhRan | Promise<GhRan>, opts: { branch?: string; repo?: boolean } = {}) {
	const ran: string[][] = [];
	let clock = 1_000_000;
	const run: GhRun = async (argv) => {
		ran.push(argv);
		if (argv[0] === "git") {
			if (opts.repo === false) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
			if (argv.includes("--git-path"))
				return { code: 0, stdout: `${join(DIR, ".git", "info", "attributes")}\n`, stderr: "" };
			if (argv.includes("--show-toplevel")) return { code: 0, stdout: `${DIR}\n`, stderr: "" };
			if (argv[1] === "branch") return { code: 0, stdout: `${opts.branch ?? "feat/x"}\n`, stderr: "" };
			if (argv[1] === "config") return { code: 0, stdout: "", stderr: "" };
		}
		return gh(argv);
	};
	const reader = new GhRuns({ run, env: {}, now: () => clock });
	return {
		reader,
		ghCalls: () => ran.filter((a) => a[0] === "gh"),
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

test("GitHub's status and conclusion read as one state", () => {
	expect(stateOf("queued", "")).toBe("queued");
	expect(stateOf("waiting", null)).toBe("queued");
	expect(stateOf("pending", null)).toBe("queued");
	expect(stateOf("in_progress", "")).toBe("running");
	expect(stateOf("completed", "success")).toBe("success");
	expect(stateOf("completed", "failure")).toBe("failure");
	expect(stateOf("completed", "timed_out")).toBe("failure");
	expect(stateOf("completed", "startup_failure")).toBe("failure");
	expect(stateOf("completed", "cancelled")).toBe("cancelled");
	expect(stateOf("completed", "skipped")).toBe("skipped");
	expect(stateOf("completed", "neutral")).toBe("skipped");
	expect(stateOf("COMPLETED", "SUCCESS")).toBe("success");
});

test("a run list is read from gh's JSON, newest first; a run without an id or a web address is dropped", () => {
	const text = JSON.stringify([
		{ ...RUN, databaseId: 102, status: "in_progress", conclusion: "", startedAt: "2026-10-01T11:00:00Z" },
		RUN,
		{ ...RUN, databaseId: 103, url: "javascript:alert(1)" },
		{ ...RUN, databaseId: "104" },
		"not a run",
	]);
	expect(parseRunList(text)).toEqual([
		{
			id: 102,
			workflow: "CI",
			title: "Fix the sidebar",
			branch: "feat/x",
			event: "push",
			sha: "aaaa111",
			state: "running",
			createdAt: "2026-10-01T10:00:00Z",
			startedAt: "2026-10-01T11:00:00Z",
			updatedAt: "2026-10-01T10:03:05Z",
			url: "https://github.com/o/r/actions/runs/101",
		},
		{
			id: 101,
			workflow: "CI",
			title: "Fix the sidebar",
			branch: "feat/x",
			event: "push",
			sha: "aaaa111",
			state: "success",
			conclusion: "success",
			createdAt: "2026-10-01T10:00:00Z",
			startedAt: "2026-10-01T10:00:05Z",
			updatedAt: "2026-10-01T10:03:05Z",
			url: "https://github.com/o/r/actions/runs/101",
		},
	]);
	expect(parseRunList("not json")).toBeNull();
	expect(parseRunList("{}")).toBeNull();
	expect(parseRunList("[]")).toEqual([]);
	// No more than a list holds, whatever gh printed.
	const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ ...RUN, databaseId: i + 1 })));
	expect(parseRunList(many)).toHaveLength(20);
});

test("a run's jobs come with how long each took and the first step that failed", () => {
	const text = JSON.stringify({
		jobs: [
			{
				databaseId: 1,
				name: "lint",
				status: "completed",
				conclusion: "success",
				startedAt: "2026-10-01T10:00:10Z",
				completedAt: "2026-10-01T10:01:10Z",
				url: "https://github.com/o/r/actions/runs/101/job/1",
				steps: [{ name: "Set up job", status: "completed", conclusion: "success", number: 1 }],
			},
			{
				databaseId: 2,
				name: "test (ubuntu)",
				status: "completed",
				conclusion: "failure",
				startedAt: "2026-10-01T10:00:10Z",
				completedAt: "2026-10-01T10:02:40Z",
				url: "https://github.com/o/r/actions/runs/101/job/2",
				steps: [
					{ name: "Set up job", status: "completed", conclusion: "success", number: 1 },
					{ name: "Unit tests", status: "completed", conclusion: "failure", number: 2 },
					{ name: "Upload", status: "completed", conclusion: "failure", number: 3 },
				],
			},
			{
				databaseId: 3,
				name: "e2e",
				status: "in_progress",
				conclusion: "",
				startedAt: "2026-10-01T10:00:10Z",
				completedAt: "0001-01-01T00:00:00Z",
				url: "https://github.com/o/r/actions/runs/101/job/3",
				steps: [],
			},
			{ databaseId: 4, name: "no address", status: "queued", url: "ftp://x" },
		],
	});
	expect(parseJobs(text)).toEqual([
		{
			id: 1,
			name: "lint",
			state: "success",
			startedAt: "2026-10-01T10:00:10Z",
			completedAt: "2026-10-01T10:01:10Z",
			url: "https://github.com/o/r/actions/runs/101/job/1",
		},
		{
			id: 2,
			name: "test (ubuntu)",
			state: "failure",
			startedAt: "2026-10-01T10:00:10Z",
			completedAt: "2026-10-01T10:02:40Z",
			url: "https://github.com/o/r/actions/runs/101/job/2",
			failedStep: "Unit tests",
		},
		// A job at work has no end yet (gh prints a zero time for it).
		{
			id: 3,
			name: "e2e",
			state: "running",
			startedAt: "2026-10-01T10:00:10Z",
			url: "https://github.com/o/r/actions/runs/101/job/3",
		},
	]);
	expect(parseJobs("[]")).toBeNull();
	expect(parseJobs('{"jobs":"none"}')).toBeNull();
});

test("what gh says on a failure: signed out, no repository, a rate limit, and anything else with no token in it", () => {
	expect(ciProblemOf("To get started with GitHub CLI, please run:  gh auth login")).toEqual({ problem: "signed-out" });
	expect(ciProblemOf("no git remotes found")).toEqual({ problem: "no-repo" });
	expect(ciProblemOf("HTTP 403: API rate limit exceeded for user ID 1.")).toEqual({ problem: "rate-limited" });
	expect(ciProblemOf("GraphQL: was submitted too quickly (secondary rate limit)")).toEqual({ problem: "rate-limited" });
	const token = `ghp_${"a".repeat(36)}`;
	expect(ciProblemOf(`\nHTTP 500: bad gateway (sent ${token})\n`)).toEqual({
		problem: "failed",
		message: "HTTP 500: bad gateway (sent [token])",
	});
	expect(ciProblemOf("")).toEqual({ problem: "failed" });
});

test("a list is looked at again after 10 s while a run is queued or running, 60 s once all are finished, and backs off after failures", () => {
	const runs = (states: CiRun["state"][]): CiRuns => ({
		scope: "branch",
		branch: "main",
		runs: states.map((state, i) => ({ ...parsedRun(i + 1), state })),
	});
	expect(ciPollMs({ ok: true, value: runs(["running", "success"]) })).toBe(CI_ACTIVE_MS);
	expect(ciPollMs({ ok: true, value: runs(["success", "queued"]) })).toBe(10_000);
	expect(ciPollMs({ ok: true, value: runs(["success", "failure", "cancelled"]) })).toBe(CI_IDLE_MS);
	expect(ciPollMs({ ok: true, value: runs([]) })).toBe(60_000);
	expect([1, 2, 3, 4, 5, 6].map((n) => ciPollMs({ ok: false, problem: "failed" }, n))).toEqual([
		60_000, 120_000, 240_000, 480_000, 900_000, 900_000,
	]);
	expect([1, 2, 3].map((n) => ciPollMs({ ok: false, problem: "rate-limited" }, n))).toEqual([
		300_000,
		600_000,
		CI_MAX_BACKOFF_MS,
	]);
});

function parsedRun(id: number, over: Partial<CiRun> = {}): CiRun {
	return {
		id,
		workflow: "CI",
		title: "t",
		branch: "main",
		event: "push",
		sha: "s1",
		state: "success",
		createdAt: "2026-10-01T10:00:00Z",
		updatedAt: "2026-10-01T10:00:00Z",
		url: `https://github.com/o/r/actions/runs/${id}`,
		...over,
	};
}

test("the badge is of the latest commit's runs on the branch: running before failed before passed", () => {
	const list = (runs: CiRun[], over: Partial<CiRuns> = {}): CiRuns => ({
		scope: "branch",
		branch: "main",
		runs,
		...over,
	});
	expect(ciBadge(null)).toBeNull();
	expect(ciBadge(list([]))).toBeNull();
	expect(ciBadge(list([parsedRun(1)]))).toBe("passed");
	expect(ciBadge(list([parsedRun(2, { state: "failure" }), parsedRun(1)]))).toBe("failed");
	expect(ciBadge(list([parsedRun(3, { state: "running" }), parsedRun(2, { state: "failure" })]))).toBe("running");
	expect(ciBadge(list([parsedRun(3, { state: "queued" })]))).toBe("running");
	// An older commit's failure is not the latest commit's.
	expect(ciBadge(list([parsedRun(3, { sha: "s2" }), parsedRun(2, { state: "failure", sha: "s1" })]))).toBe("passed");
	expect(ciBadge(list([parsedRun(1, { state: "cancelled" })]))).toBeNull();
	expect(ciBadge(list([parsedRun(1)], { scope: "all" }))).toBeNull();
	expect(ciBadge(list([parsedRun(1)], { branch: null }))).toBeNull();
});

test("a run that was queued or running and is finished now is noticed once", () => {
	const before = [parsedRun(2, { state: "running" }), parsedRun(1, { state: "queued" }), parsedRun(0)];
	const after = [parsedRun(2, { state: "failure" }), parsedRun(1, { state: "running" }), parsedRun(0)];
	expect(finishedRuns(before, after).map((r) => r.id)).toEqual([2]);
	expect(finishedRuns(after, after).map((r) => r.id)).toEqual([]);
	// A new run that is already finished at its first look was never seen at work.
	expect(finishedRuns([], [parsedRun(5)])).toEqual([]);
});

test("a duration is from the start to the end, or to now while it runs", () => {
	expect(ciDurationMs("2026-10-01T10:00:00Z", "2026-10-01T10:02:30Z", false, 0)).toBe(150_000);
	expect(ciDurationMs("2026-10-01T10:00:00Z", undefined, true, Date.parse("2026-10-01T10:00:09Z"))).toBe(9000);
	expect(ciDurationMs(undefined, "2026-10-01T10:02:30Z", false, 0)).toBeNull();
	expect(ciDurationMs("2026-10-01T10:00:00Z", undefined, false, 0)).toBeNull();
});

test("the branch's runs are asked of gh with --branch; all branches without; a detached HEAD lists every branch", async () => {
	const w = world(() => ok([RUN]));
	const branch = await w.reader.runs(DIR, "branch");
	expect(branch).toMatchObject({ ok: true, value: { scope: "branch", branch: "feat/x" } });
	const [argv] = w.ghCalls();
	expect(argv?.slice(0, 3)).toEqual(["gh", "run", "list"]);
	expect(argv?.[argv.indexOf("--branch") + 1]).toBe("feat/x");
	expect(argv?.[argv.indexOf("--limit") + 1]).toBe("20");

	await w.reader.runs(DIR, "all");
	expect(w.ghCalls()[1]).not.toContain("--branch");

	const detached = world(() => ok([RUN]), { branch: "" });
	expect(await detached.reader.runs(DIR, "branch")).toMatchObject({ ok: true, value: { scope: "all", branch: null } });
	expect(detached.ghCalls()[0]).not.toContain("--branch");
});

test("pages that ask within a look's interval share it: 10 s while a run is at work, then 60 s once all are finished", async () => {
	let runs: unknown[] = [{ ...RUN, status: "in_progress", conclusion: "" }];
	const w = world(() => ok(runs));
	const first = await w.reader.runs(DIR, "branch");
	expect(first.nextMs).toBe(10_250);
	// Two more pages a moment later: the same look, and told when the next is due.
	w.advance(4000);
	const [a, b] = await Promise.all([w.reader.runs(DIR, "branch"), w.reader.runs(DIR, "branch")]);
	expect(w.ghCalls()).toHaveLength(1);
	expect(a).toEqual(b);
	expect(a.nextMs).toBe(6250);
	// Its interval over: looked at again, now finished, and good for a minute.
	runs = [RUN];
	w.advance(6000);
	const done = await w.reader.runs(DIR, "branch");
	expect(w.ghCalls()).toHaveLength(2);
	expect(done).toMatchObject({ ok: true, value: { runs: [{ state: "success" }] }, nextMs: 60_250 });
	w.advance(59_000);
	await w.reader.runs(DIR, "branch");
	expect(w.ghCalls()).toHaveLength(2);
	w.advance(1000);
	await w.reader.runs(DIR, "branch");
	expect(w.ghCalls()).toHaveLength(3);
	// Refresh looks now, whatever the age.
	await w.reader.runs(DIR, "branch", { fresh: true });
	expect(w.ghCalls()).toHaveLength(4);
});

test("a look under way is waited for, not repeated", async () => {
	const answer = Promise.withResolvers<GhRan>();
	const asked = Promise.withResolvers<void>();
	const w = world(() => {
		asked.resolve();
		return answer.promise;
	});
	const one = w.reader.runs(DIR, "branch");
	await asked.promise;
	const two = w.reader.runs(DIR, "branch");
	answer.resolve(ok([RUN]));
	expect((await one).ok).toBe(true);
	expect(await two).toEqual(await one);
	expect(w.ghCalls()).toHaveLength(1);
});

test("a failed look is told again later, and later still after each failure in a row", async () => {
	const w = world(() => ({ code: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded" }));
	const first = await w.reader.runs(DIR, "branch");
	expect(first).toEqual({ ok: false, problem: "rate-limited", nextMs: 300_250 });
	w.advance(300_000);
	const second = await w.reader.runs(DIR, "branch");
	expect(second.nextMs).toBe(600_250);
	expect(w.ghCalls()).toHaveLength(2);
});

test("no gh, a folder that is not a repository, and an unsafe one each say so; gh is not asked about a folder it cannot look at", async () => {
	const missing = world(() => "missing");
	expect(await missing.reader.runs(DIR, "branch")).toMatchObject({ ok: false, problem: "no-gh" });
	const slow = world(() => "slow");
	expect(await slow.reader.runs(DIR, "branch")).toMatchObject({ ok: false, problem: "slow" });
	const plain = world(() => ok([]), { repo: false });
	expect(await plain.reader.runs(DIR, "branch")).toMatchObject({ ok: false, problem: "no-repo", nextMs: 60_000 });
	expect(plain.ghCalls()).toHaveLength(0);
	const garbled = world(() => ({ code: 0, stdout: "<html>", stderr: "" }));
	expect(await garbled.reader.runs(DIR, "branch")).toMatchObject({ ok: false, problem: "failed" });
});

test("a run's jobs are kept 10 s while one is at work and 10 minutes once all are finished", async () => {
	let jobs: unknown[] = [
		{ databaseId: 1, name: "test", status: "in_progress", url: "https://github.com/o/r/actions/runs/101/job/1" },
	];
	const w = world(() => ok({ jobs }));
	const first = await w.reader.jobs(DIR, 101);
	expect(first).toMatchObject({ ok: true, value: [{ id: 1, state: "running" }], nextMs: 10_250 });
	expect(w.ghCalls()[0]).toEqual(["gh", "run", "view", "101", "--json", "jobs"]);
	w.advance(5000);
	await w.reader.jobs(DIR, 101);
	expect(w.ghCalls()).toHaveLength(1);
	jobs = [{ ...(jobs[0] as object), status: "completed", conclusion: "success" }];
	w.advance(5000);
	expect(await w.reader.jobs(DIR, 101)).toMatchObject({ value: [{ state: "success" }], nextMs: 600_250 });
	w.advance(300_000);
	await w.reader.jobs(DIR, 101);
	expect(w.ghCalls()).toHaveLength(2);
	expect(await w.reader.jobs(DIR, 0)).toMatchObject({ ok: false, problem: "failed" });
	expect(w.ghCalls()).toHaveLength(2);
});
