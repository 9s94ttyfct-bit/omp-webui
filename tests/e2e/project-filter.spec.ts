import { existsSync, rmSync } from "node:fs";
import { writeChatSession } from "../support/chat-session.ts";
import { FIXTURE } from "../support/fixtures.ts";
import { chooseProject, projectTrigger } from "../support/project-groups.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The sidebar's project filter belongs to a project that has conversations. When the last one of it is deleted the list
 * has no such row any more and the filter is on "All projects": the list must show every conversation again, not
 * "No conversations". No model is called.
 *
 * The funnel opened the browser's own `<select>` until #636; it opens the list of projects (and their groups) now, and
 * filtering by one is the same: the funnel's own name says what is filtered by, and a dot marks it.
 */

const row = (page: Page, title: string) =>
	page.getByRole("complementary").locator('[data-testid="session-item"]', { hasText: title });

const turn = [{ prompt: "Where does the heron stand?", reply: "In the shallows." }];

test("deleting the last conversation of the filtered project shows all conversations again", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const cwd = "/tmp/ompw-heron-single";
	const file = writeChatSession(agentDir, { n: 0x22, title: "Heron single", cwd, turns: turn });
	try {
		await page.goto("/");
		await expect(row(page, "Heron single")).toHaveCount(1, { timeout: 15_000 });
		await chooseProject(page, cwd);
		await expect(row(page, "Heron single")).toHaveCount(1);
		await expect(row(page, FIXTURE.alphaTitle)).toHaveCount(0);

		await row(page, "Heron single").hover();
		await page.getByRole("button", { name: "Actions for Heron single" }).click();
		await page.getByRole("menuitem", { name: "Delete…" }).click();
		await page.getByTestId("confirm-session-action").click();
		await expect.poll(() => existsSync(file), { timeout: 60_000 }).toBe(false);

		await expect(projectTrigger(page), "no project filters the list any more").not.toHaveAttribute(
			"data-filtered",
			"true",
		);
		await expect(row(page, FIXTURE.alphaTitle)).toHaveCount(1);
		await expect(page.getByText("No conversations")).toHaveCount(0);
	} finally {
		rmSync(file, { force: true });
	}
});

test("bulk-deleting the filtered project's conversations shows all conversations again", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const cwd = "/tmp/ompw-heron-pair";
	const files = [
		writeChatSession(agentDir, { n: 0x23, title: "Heron pair north", cwd, turns: turn }),
		writeChatSession(agentDir, { n: 0x24, title: "Heron pair south", cwd, turns: turn }),
	];
	try {
		await page.goto("/");
		await expect(row(page, "Heron pair north")).toHaveCount(1, { timeout: 15_000 });
		await chooseProject(page, cwd);
		await expect(row(page, FIXTURE.alphaTitle)).toHaveCount(0);

		await page.getByTestId("select-sessions").click();
		await page.getByTestId("selection-bar").getByRole("button", { name: "Select all", exact: true }).click();
		await expect(page.getByTestId("selection-count")).toHaveText("2 selected");
		await page.getByTestId("selection-bar").getByRole("button", { name: "Delete" }).click();
		await page.getByTestId("confirm-bulk-delete").click();
		await expect.poll(() => files.some((f) => existsSync(f)), { timeout: 60_000 }).toBe(false);

		await expect(projectTrigger(page), "no project filters the list any more").not.toHaveAttribute(
			"data-filtered",
			"true",
		);
		await expect(row(page, FIXTURE.alphaTitle)).toHaveCount(1);
		await expect(page.getByText("No conversations")).toHaveCount(0);
	} finally {
		for (const f of files) rmSync(f, { force: true });
	}
});
