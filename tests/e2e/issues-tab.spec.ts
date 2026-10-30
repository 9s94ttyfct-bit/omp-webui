import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeChatSession } from "../support/chat-session.ts";
import { writeLongFakeOmp } from "../support/long-fake-omp-bin.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The side panel's Issues tab (#653): the GitHub issues of the conversation's folder, read through the server's routes
 * with a stand-in `gh` first on the server's PATH (it answers from files and notes what it was asked). Nothing reaches
 * GitHub, and no model is called.
 */

let s: TestServer;
let binDir: string;
let repo: string;
let plain: string;
const LOG = () => join(binDir, "gh.log");
const REPO_TITLE = "Issues tab repository";
const PLAIN_TITLE = "Issues tab plain folder";

const issue = (number: number, title: string, state: "OPEN" | "CLOSED", extra: object = {}) => ({
	number,
	title,
	state,
	labels: [{ name: "bug", color: "d73a4a" }],
	author: { login: "ana" },
	assignees: [],
	createdAt: "2026-10-01T10:00:00Z",
	updatedAt: "2026-10-02T10:00:00Z",
	url: `https://github.com/o/r/issues/${number}`,
	...extra,
});

test.beforeAll(async () => {
	binDir = mkdtempSync(join(tmpdir(), "ompw-issues-bin-"));
	writeFileSync(
		join(binDir, "open.json"),
		JSON.stringify([issue(7, "Crash on start", "OPEN"), issue(9, "Slow sidebar", "OPEN")]),
	);
	writeFileSync(join(binDir, "closed.json"), JSON.stringify([issue(3, "Old typo", "CLOSED")]));
	writeFileSync(
		join(binDir, "view-7.json"),
		JSON.stringify(
			issue(7, "Crash on start", "OPEN", {
				body: "It **crashes** when the folder is empty.",
				comments: [{ author: { login: "bo" }, body: "Same here on 0.11.15", createdAt: "2026-10-03T00:00:00Z" }],
			}),
		),
	);
	const gh = join(binDir, "gh");
	writeFileSync(
		gh,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> '${LOG()}'`,
			'case "$1 $2" in',
			`  "issue list") case "$*" in *"--state closed"*) cat '${join(binDir, "closed.json")}';; *) cat '${join(binDir, "open.json")}';; esac;;`,
			`  "issue view") cat '${binDir}'/view-"$3".json;;`,
			"  *) echo 'not scripted' >&2; exit 1;;",
			"esac",
			"",
		].join("\n"),
	);
	chmodSync(gh, 0o755);
	s = await startTestServer(
		0,
		{ OMP_BIN: writeLongFakeOmp(binDir), PATH: `${binDir}:${process.env.PATH ?? ""}` },
		{ login: false },
	);
	const root = realpathSync(s.work);
	repo = join(root, "issues-repo");
	plain = join(root, "issues-plain");
	mkdirSync(repo);
	mkdirSync(plain);
	execFileSync("git", ["init", "-q", repo]);
	writeChatSession(s.agentDir, { n: 0x71, title: REPO_TITLE, cwd: repo, turns: [{ prompt: "hello", reply: "hi" }] });
	writeChatSession(s.agentDir, { n: 0x72, title: PLAIN_TITLE, cwd: plain, turns: [{ prompt: "hello", reply: "hi" }] });
});
test.afterAll(async () => {
	await s?.stop();
	rmSync(binDir, { recursive: true, force: true });
});

const panel = (page: Page) => page.getByTestId("right-panel");
const asked = () => {
	try {
		return readFileSync(LOG(), "utf8");
	} catch {
		return "";
	}
};

/** Open the conversation, its side panel and the Issues tab. */
async function openIssues(page: Page, title = REPO_TITLE): Promise<void> {
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await page.locator('[data-testid="session-item"]', { hasText: title }).click();
	await expect(page.getByTestId("composer")).toBeVisible();
	await page.getByTestId("toggle-panel").click();
	await panel(page).getByTestId("panel-pane-bottom").getByRole("tab", { name: "Issues" }).click();
	await expect(page.getByTestId("issues-tab")).toBeVisible();
}

const rows = (page: Page) =>
	page.getByTestId("issues-row").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.number));

test("the tab is lazy, lists the open issues, filters, and passes a search to gh", async ({ page }) => {
	const chunks: string[] = [];
	page.on("request", (r) => {
		if (/IssuesTab-.*\.js$/.test(new URL(r.url()).pathname)) chunks.push(r.url());
	});
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await page.locator('[data-testid="session-item"]', { hasText: REPO_TITLE }).click();
	await page.getByTestId("toggle-panel").click();
	await expect(panel(page)).toBeVisible();
	expect(chunks).toEqual([]);

	await panel(page).getByTestId("panel-pane-bottom").getByRole("tab", { name: "Issues" }).click();
	await expect.poll(() => rows(page)).toEqual(["7", "9"]);
	expect(chunks).toHaveLength(1);
	await expect(page.getByTestId("issues-list")).toContainText("Crash on start");
	await expect(page.getByTestId("issues-tab")).toContainText("Read only");

	await page.getByTestId("issues-filter-closed").click();
	await expect.poll(() => rows(page)).toEqual(["3"]);
	await expect(page.getByTestId("issues-filter-closed")).toHaveAttribute("aria-pressed", "true");

	await page.getByTestId("issues-filter-open").click();
	await page.getByTestId("issues-search").fill("label:bug crash");
	await page.getByTestId("issues-search").press("Enter");
	await expect.poll(asked).toContain("--search label:bug crash");
});

test("an issue opens with its body and comments, and goes into this conversation's message box", async ({ page }) => {
	await openIssues(page);
	await page.locator('[data-testid="issues-row"][data-number="7"]').click();
	await expect(page.getByTestId("issue-title")).toHaveText("Crash on start");
	await expect(page.getByTestId("issue-body").locator("strong")).toHaveText("crashes");
	await expect(page.getByTestId("issue-comment")).toContainText("Same here on 0.11.15");
	await expect(page.getByTestId("issue-open-github")).toHaveAttribute("href", "https://github.com/o/r/issues/7");

	await page.getByTestId("issue-to-chat").click();
	const box = page.getByTestId("composer");
	await expect(box).toHaveValue(/GitHub issue #7: Crash on start/);
	await expect(box).toHaveValue(/https:\/\/github\.com\/o\/r\/issues\/7/);
	await expect(box).toHaveValue(/Same here on 0\.11\.15/);

	await page.getByTestId("issue-back").click();
	await expect.poll(() => rows(page)).toEqual(["7", "9"]);
});

test("an issue starts a new conversation in the same folder with it in the message box", async ({ page }) => {
	await openIssues(page);
	await page.locator('[data-testid="issues-row"][data-number="7"]').click();
	await expect(page.getByTestId("issue-title")).toHaveText("Crash on start");
	await page.getByTestId("issue-to-new").click();
	await expect(page.getByTestId("cwd-picker")).toContainText("issues-repo");
	await expect(page.getByTestId("composer")).toHaveValue(/GitHub issue #7: Crash on start/);
});

test("a folder that is not a repository says so, and gh is not asked", async ({ page }) => {
	const before = asked();
	await openIssues(page, PLAIN_TITLE);
	await expect(page.getByTestId("issues-problem")).toHaveAttribute("data-problem", "no-repo");
	await expect(page.getByTestId("issues-problem")).toContainText("not a git repository");
	expect(asked()).toBe(before);
});

test("the list asks again by itself while it is shown: on the interval and when the window comes back, never while the page is hidden (#695)", async ({
	page,
}) => {
	const lists: string[] = [];
	page.on("request", (r) => {
		if (new URL(r.url()).pathname === "/api/github/issues") lists.push(r.postData() ?? "");
	});
	// Time is the page's clock: a minute is fast-forwarded, not waited for.
	await page.clock.install();
	await openIssues(page);
	await expect.poll(() => rows(page)).toEqual(["7", "9"]);
	const first = lists.length;
	expect(first).toBeGreaterThanOrEqual(1);

	// The window coming back (focus) looks again, without the Refresh button.
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect.poll(() => lists.length).toBe(first + 1);

	// A minute later it looks again by itself, and the list is still there while it does.
	await page.clock.fastForward(61_000);
	await expect.poll(() => lists.length).toBe(first + 2);
	await expect.poll(() => rows(page)).toEqual(["7", "9"]);

	// Hidden: no timer fires and a focus asks nothing.
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.clock.fastForward(300_000);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await page.waitForTimeout(500);
	expect(lists.length).toBe(first + 2);

	// Visible again: it looks at once.
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect.poll(() => lists.length).toBe(first + 3);
});
