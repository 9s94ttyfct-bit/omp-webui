import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeChatSession } from "../support/chat-session.ts";
import { openSidebar } from "../support/live.ts";
import { writeLongFakeOmp } from "../support/long-fake-omp-bin.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The side panel's CI tab: the GitHub Actions runs of the conversation's folder, read through the server's routes with a
 * stand-in `gh` first on the server's PATH (it answers from files of synthetic runs and jobs, and notes what it was asked).
 * A second server has no `gh` at all. Nothing reaches GitHub, and no model is called.
 */

let s: TestServer;
let noGh: TestServer;
let binDir: string;
const LOG = () => join(binDir, "gh.log");
const REPO_TITLE = "CI tab repository";
const PLAIN_TITLE = "CI tab plain folder";

const ghRun = (id: number, state: "running" | "success" | "failure", extra: object = {}) => ({
	databaseId: id,
	workflowName: "CI",
	displayTitle: `Change ${id}`,
	headBranch: "feat/ci",
	headSha: `sha${id}`,
	event: "push",
	status: state === "running" ? "in_progress" : "completed",
	conclusion: state === "running" ? "" : state,
	createdAt: "2026-10-30T09:00:00Z",
	startedAt: "2026-10-30T09:00:04Z",
	updatedAt: "2026-10-30T09:03:04Z",
	url: `https://github.com/o/r/actions/runs/${id}`,
	...extra,
});

const runsOf = (file: string, runs: object[]) => writeFileSync(join(binDir, file), JSON.stringify(runs));

test.beforeAll(async () => {
	binDir = mkdtempSync(join(tmpdir(), "ompw-ci-bin-"));
	runsOf("runs-branch.json", [ghRun(302, "failure"), ghRun(301, "success")]);
	runsOf("runs-all.json", [
		ghRun(400, "success", { headBranch: "main", displayTitle: "Release" }),
		ghRun(302, "failure"),
		ghRun(301, "success"),
	]);
	writeFileSync(
		join(binDir, "jobs-302.json"),
		JSON.stringify({
			jobs: [
				{
					databaseId: 1,
					name: "lint",
					status: "completed",
					conclusion: "success",
					startedAt: "2026-10-30T09:00:10Z",
					completedAt: "2026-10-30T09:00:40Z",
					url: "https://github.com/o/r/actions/runs/302/job/1",
					steps: [],
				},
				{
					databaseId: 2,
					name: "test",
					status: "completed",
					conclusion: "failure",
					startedAt: "2026-10-30T09:00:10Z",
					completedAt: "2026-10-30T09:02:10Z",
					url: "https://github.com/o/r/actions/runs/302/job/2",
					steps: [
						{ name: "Set up job", status: "completed", conclusion: "success", number: 1 },
						{ name: "Unit tests", status: "completed", conclusion: "failure", number: 2 },
					],
				},
			],
		}),
	);
	const gh = join(binDir, "gh");
	writeFileSync(
		gh,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> '${LOG()}'`,
			'case "$1 $2" in',
			`  "run list") case "$*" in *"--branch"*) cat '${join(binDir, "runs-branch.json")}';; *) cat '${join(binDir, "runs-all.json")}';; esac;;`,
			`  "run view") cat '${binDir}'/jobs-"$3".json;;`,
			"  *) echo 'not scripted' >&2; exit 1;;",
			"esac",
			"",
		].join("\n"),
	);
	chmodSync(gh, 0o755);
	const omp = writeLongFakeOmp(binDir);
	s = await startTestServer(0, { OMP_BIN: omp, PATH: `${binDir}:${process.env.PATH ?? ""}` }, { login: false });
	// A PATH with what the server needs (bun for it and the stand-in omp, git, ps) and no `gh`.
	const tools = join(binDir, "tools");
	mkdirSync(tools);
	for (const name of ["bun", "git", "ps"])
		symlinkSync(execFileSync("which", [name]).toString().trim(), join(tools, name));
	noGh = await startTestServer(0, { OMP_BIN: omp, PATH: tools }, { login: false });
	for (const server of [s, noGh]) {
		const root = realpathSync(server.work);
		const r = join(root, "ci-repo");
		mkdirSync(r);
		execFileSync("git", ["init", "-q", "-b", "feat/ci", r]);
		const p = join(root, "ci-plain");
		mkdirSync(p);
		writeChatSession(server.agentDir, {
			n: 0x81,
			title: REPO_TITLE,
			cwd: r,
			turns: [{ prompt: "hello", reply: "hi" }],
		});
		writeChatSession(server.agentDir, {
			n: 0x82,
			title: PLAIN_TITLE,
			cwd: p,
			turns: [{ prompt: "hello", reply: "hi" }],
		});
	}
});
test.afterAll(async () => {
	await s?.stop();
	await noGh?.stop();
	rmSync(binDir, { recursive: true, force: true });
});

const asked = () => {
	try {
		return readFileSync(LOG(), "utf8").trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
};
const runIds = (page: Page) =>
	page.getByTestId("ci-run").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.id));
const badge = (page: Page) => page.getByTestId("pane-tab-status-ci");

/** Open the conversation and its side panel (the badge is there from now on), then the CI tab unless `tab` is false. */
async function openCi(page: Page, title = REPO_TITLE, server = s, tab = true): Promise<void> {
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(`${server.url}/?token=${server.accessToken}`);
	// On a phone the sidebar is a drawer to open first.
	await openSidebar(page);
	await page.locator('[data-testid="session-item"]', { hasText: title }).click();
	await expect(page.getByTestId("composer")).toBeVisible();
	await page.getByTestId("toggle-panel").click();
	if (!tab) return;
	await page.getByTestId("pane-tab-ci").click();
	await expect(page.getByTestId("ci-tab")).toBeVisible();
}

test("the tab is lazy, lists the branch's runs, unfolds a failed run to its jobs with the failing step and its log, and shows every branch", async ({
	page,
}) => {
	runsOf("runs-branch.json", [ghRun(302, "failure"), ghRun(301, "success")]);
	const chunks: string[] = [];
	page.on("request", (r) => {
		if (/CiTab-.*\.js$/.test(new URL(r.url()).pathname)) chunks.push(r.url());
	});
	await openCi(page, REPO_TITLE, s, false);
	// The badge watches the branch with the panel open, before the tab's own code is fetched.
	await expect(badge(page)).toHaveAttribute("data-status", "failed");
	await expect(page.getByTestId("pane-tab-ci")).toHaveAttribute("aria-label", "CI: failed");
	expect(chunks).toEqual([]);

	await page.getByTestId("pane-tab-ci").click();
	await expect.poll(() => runIds(page)).toEqual(["302", "301"]);
	expect(chunks).toHaveLength(1);
	await expect(page.getByTestId("ci-branch")).toHaveText("Branch feat/ci");
	expect(asked().some((a) => a.startsWith("run list") && a.includes("--branch feat/ci"))).toBe(true);
	const failed = page.locator('[data-testid="ci-run"][data-id="302"]');
	await expect(failed).toHaveAttribute("data-state", "failure");
	await expect(failed.getByTestId("ci-run-link")).toHaveAttribute("href", "https://github.com/o/r/actions/runs/302");
	await expect(failed.getByTestId("ci-run-duration")).toHaveText("took 3m 00s");

	// A click unfolds the jobs; the failed one names its step and links to its log.
	const toggle = failed.getByTestId("ci-run-toggle");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(failed.getByTestId("ci-job")).toHaveCount(2);
	const failedJob = failed.locator('[data-testid="ci-job"][data-state="failure"]');
	await expect(failedJob).toContainText("test");
	await expect(failedJob.getByTestId("ci-job-failed-step")).toHaveText("Failed at: Unit tests");
	await expect(failedJob.getByTestId("ci-job-log")).toHaveAttribute(
		"href",
		"https://github.com/o/r/actions/runs/302/job/2",
	);
	expect(asked()).toContain("run view 302 --json jobs");
	// The keyboard folds it again.
	await toggle.focus();
	await page.keyboard.press("Enter");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(failed.getByTestId("ci-job")).toHaveCount(0);

	await page.getByTestId("ci-scope-all").click();
	await expect(page.getByTestId("ci-scope-all")).toHaveAttribute("aria-pressed", "true");
	await expect.poll(() => runIds(page)).toEqual(["400", "302", "301"]);
	expect(asked().at(-1)).not.toContain("--branch");
	// The badge stays the branch's.
	await expect(badge(page)).toHaveAttribute("data-status", "failed");
});

test("the badge follows the latest commit's runs: running, then passed", async ({ page }) => {
	runsOf("runs-branch.json", [ghRun(311, "running"), ghRun(302, "failure")]);
	await openCi(page);
	// Refresh: what the server looked at for the last test is not this one's.
	await page.getByTestId("ci-refresh").click();
	await expect(badge(page)).toHaveAttribute("data-status", "running");
	await expect(page.getByTestId("pane-tab-ci")).toHaveAttribute("aria-label", "CI: running");
	await expect(page.locator('[data-testid="ci-run"][data-id="311"]')).toHaveAttribute("data-state", "running");

	runsOf("runs-branch.json", [ghRun(311, "success"), ghRun(302, "failure")]);
	await page.getByTestId("ci-refresh").click();
	await expect(badge(page)).toHaveAttribute("data-status", "passed");
	await expect(page.getByTestId("pane-tab-ci")).toHaveAttribute("aria-label", "CI: passed");
});

test("the page asks again 10 s later while a run is at work, and a minute later once all are finished", async ({
	page,
}) => {
	runsOf("runs-branch.json", [ghRun(321, "running")]);
	const asks: { at: number; fresh: boolean }[] = [];
	const answers: number[] = [];
	page.on("request", (r) => {
		if (new URL(r.url()).pathname !== "/api/github/runs") return;
		const body = JSON.parse(r.postData() ?? "{}") as { scope?: string; fresh?: boolean };
		if (body.scope === "branch") asks.push({ at: Date.now(), fresh: body.fresh === true });
	});
	page.on("response", async (r) => {
		if (new URL(r.url()).pathname !== "/api/github/runs") return;
		const body = (await r.json().catch(() => null)) as { nextMs?: number; value?: { scope?: string } } | null;
		if (body?.value?.scope === "branch" && typeof body.nextMs === "number") answers.push(body.nextMs);
	});
	// Time is the page's clock: the waits are fast-forwarded, not waited for.
	await page.clock.install();
	await openCi(page);
	await page.getByTestId("ci-refresh").click();
	await expect(badge(page)).toHaveAttribute("data-status", "running");
	await expect.poll(() => answers.length).toBeGreaterThanOrEqual(1);
	// The server says the next look is due within 10 s.
	expect(answers.at(-1)).toBeLessThanOrEqual(10_250);
	expect(answers.at(-1)).toBeGreaterThan(5000);
	const settled = asks.length;

	await page.clock.fastForward(4000);
	await page.waitForTimeout(300);
	expect(asks.length).toBe(settled);
	await page.clock.fastForward(6500);
	await expect.poll(() => asks.length).toBe(settled + 1);

	// Every run finished: the next look is a minute away, and nothing is asked before.
	runsOf("runs-branch.json", [ghRun(321, "success")]);
	await page.getByTestId("ci-refresh").click();
	await expect(badge(page)).toHaveAttribute("data-status", "passed");
	await expect.poll(() => answers.at(-1) ?? 0).toBeGreaterThan(50_000);
	const finished = asks.length;
	await page.clock.fastForward(30_000);
	await page.waitForTimeout(300);
	expect(asks.length).toBe(finished);
	await page.clock.fastForward(31_000);
	await expect.poll(() => asks.length).toBe(finished + 1);
	expect(asks.at(-1)?.fresh).toBe(false);
});

test("a folder that is not a repository says so without asking gh, and shows no badge", async ({ page }) => {
	const before = asked().length;
	await openCi(page, PLAIN_TITLE);
	await expect(page.getByTestId("ci-problem")).toHaveAttribute("data-problem", "no-repo");
	await expect(page.getByTestId("ci-problem")).toContainText("not a git repository");
	await expect(badge(page)).toHaveCount(0);
	expect(asked().length).toBe(before);
});

test("a server without gh says it is not installed", async ({ page }) => {
	await openCi(page, REPO_TITLE, noGh);
	await expect(page.getByTestId("ci-problem")).toHaveAttribute("data-problem", "no-gh");
	await expect(page.getByTestId("ci-problem")).toContainText("GitHub CLI (gh) is not installed");
	await expect(badge(page)).toHaveCount(0);
});

test("on a phone the tab is in the sheet, its runs fit the width, and a run unfolds", async ({ page }) => {
	runsOf("runs-branch.json", [ghRun(302, "failure"), ghRun(301, "success")]);
	await page.setViewportSize({ width: 390, height: 844 });
	await openCi(page);
	await page.getByTestId("ci-refresh").click();
	await expect.poll(() => runIds(page)).toEqual(["302", "301"]);
	const tab = page.getByTestId("ci-tab");
	const overflow = await tab.evaluate((el) => el.scrollWidth - el.clientWidth);
	expect(overflow).toBeLessThanOrEqual(0);
	await page.locator('[data-testid="ci-run"][data-id="302"]').getByTestId("ci-run-toggle").click();
	await expect(page.getByTestId("ci-job-failed-step")).toHaveText("Failed at: Unit tests");
});
