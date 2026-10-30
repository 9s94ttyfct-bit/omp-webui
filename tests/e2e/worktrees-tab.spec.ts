import type { WorktreeList } from "../../shared/git.ts";
import { FIXTURE_FILES } from "../support/fixtures.ts";
import { panelTab } from "../support/panel.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The Worktrees tab (#698): the conversation's repository's worktrees, each with its branch, what is not committed and its
 * commits the main branch lacks; Refresh looks again (a POST, as the status line's fresh look is). The server's answer is a
 * known one here: what it reads of a real repository is `tests/unit/git-worktrees.test.ts`'s. No model call.
 */

const LIST: WorktreeList = {
	state: "ok",
	mainBranch: "origin/main",
	truncated: false,
	worktrees: [
		{
			path: "/tmp/ompw-fixture-project",
			branch: "main",
			head: "f6fe60b",
			main: true,
			current: true,
			locked: false,
			prunable: false,
			changes: { staged: 1, unstaged: 3, untracked: 2 },
			ahead: 0,
		},
		{
			path: "/tmp/ompw-fixture-project-wt/feature",
			branch: "feature",
			head: "1234567",
			main: false,
			current: false,
			locked: true,
			prunable: false,
			changes: { staged: 0, unstaged: 0, untracked: 0 },
			ahead: 3,
		},
	],
};

async function openTab(page: Page): Promise<void> {
	await page.goto("/");
	await page.locator(`[data-testid="session-item"][data-file$="${FIXTURE_FILES.gamma}"]`).click();
	await page.getByTestId("toggle-panel").click();
	await panelTab(page, /^Worktrees/).click();
}

test("lists each worktree with its branch, what is uncommitted and its commits not on the main branch; Refresh looks again", async ({
	page,
}) => {
	const asked: { method: string; fresh: boolean }[] = [];
	await page.route(/\/api\/git\/worktrees\?/, (route) => {
		const url = new URL(route.request().url());
		asked.push({ method: route.request().method(), fresh: url.searchParams.get("fresh") === "1" });
		return route.fulfill({ json: LIST });
	});
	await openTab(page);
	const tab = page.getByTestId("worktrees-tab");
	const rows = tab.getByTestId("worktree-row");
	await expect(rows).toHaveCount(2);
	const main = rows.filter({ hasText: "main" }).first();
	await expect(main).toHaveAttribute("data-dirty", "true");
	await expect(main.getByTestId("worktree-changes")).toHaveText("Uncommitted: 1 staged · 3 changed · 2 untracked");
	await expect(main).toContainText("this conversation");
	await expect(main.getByTestId("worktree-ahead")).toHaveText("Every commit is on origin/main");
	const feature = rows.filter({ hasText: "feature" });
	await expect(feature.getByTestId("worktree-changes")).toHaveText("Nothing uncommitted");
	await expect(feature.getByTestId("worktree-ahead")).toHaveText("3 commits not on origin/main");
	await expect(feature.getByLabel("Locked")).toBeVisible();
	// The first look is a plain ask; Refresh is a fresh one, by POST.
	expect(asked[0]).toEqual({ method: "GET", fresh: false });
	await tab.getByTestId("worktrees-refresh").click();
	await expect.poll(() => asked.some((a) => a.fresh && a.method === "POST")).toBe(true);
});

test("a repository that is not looked at says why, in Chinese too", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	await page.route(/\/api\/git\/worktrees\?/, (route) =>
		route.fulfill({ json: { state: "unsafe", mainBranch: null, worktrees: [], truncated: false } }),
	);
	await page.goto("/");
	await page.locator(`[data-testid="session-item"][data-file$="${FIXTURE_FILES.gamma}"]`).click();
	await page.getByTestId("toggle-panel").click();
	await panelTab(page, /^工作树/).click();
	await expect(page.getByTestId("worktrees-state")).toHaveAttribute("data-state", "unsafe");
	await expect(page.getByTestId("worktrees-state")).toContainText("仓库自己的设置");
});
