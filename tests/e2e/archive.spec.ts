import { existsSync, rmSync } from "node:fs";
import { writeSimpleSession } from "../support/fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** Multi-select in the sidebar: archive, unarchive and bulk delete through omp (no model call). */

const row = (page: Page, title: string) =>
	page.getByRole("complementary").locator('[data-testid="session-item"]', { hasText: title });

test("select a range, archive it, restore one, then bulk-delete the rest", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const titles = ["Bulk one", "Bulk two", "Bulk three"];
	const files = titles.map((title, i) => writeSimpleSession(agentDir, 0x40 + i, title));
	await page.goto("/");
	for (const title of titles) await expect(row(page, title)).toHaveCount(1, { timeout: 15_000 });

	// Range selection: click the first, shift-click the last (rows are newest first: three, two, one).
	await page.getByTestId("select-sessions").click();
	await row(page, "Bulk three").click();
	await row(page, "Bulk one").click({ modifiers: ["Shift"] });
	await expect(page.getByTestId("selection-count")).toHaveText("3 selected");
	await page.getByTestId("selection-bar").getByRole("button", { name: "Archive" }).click();
	for (const title of titles) await expect(row(page, title)).toHaveCount(0);
	await expect(page.getByTestId("selection-bar")).toHaveCount(0);

	// The archived view lists them; restoring one returns it to the main list.
	await page.getByTestId("show-archived").click();
	for (const title of titles) await expect(row(page, title)).toHaveCount(1);
	await row(page, "Bulk two").hover();
	await page.getByRole("button", { name: "Actions for Bulk two" }).click();
	await page.getByRole("menuitem", { name: "Unarchive" }).click();
	await expect(row(page, "Bulk two")).toHaveCount(0);

	// Bulk delete the two still archived, through omp.
	await page.getByTestId("select-sessions").click();
	await page.getByTestId("selection-bar").getByRole("button", { name: "All" }).click();
	await expect(page.getByTestId("selection-count")).toHaveText("2 selected");
	await page.getByTestId("selection-bar").getByRole("button", { name: "Delete" }).click();
	await expect(page.getByRole("dialog")).toContainText("Delete 2 conversations?");
	await page.getByTestId("confirm-bulk-delete").click();
	await expect(page.getByText("No archived conversations.")).toBeVisible({ timeout: 60_000 });
	expect(existsSync(files[0])).toBe(false);
	expect(existsSync(files[2])).toBe(false);
	expect(existsSync(files[1])).toBe(true);

	await page.getByTestId("show-all-sessions").click();
	await expect(row(page, "Bulk two")).toHaveCount(1);

	// Clean up through the single-delete path.
	await row(page, "Bulk two").hover();
	await page.getByRole("button", { name: "Actions for Bulk two" }).click();
	await page.getByRole("menuitem", { name: "Delete…" }).click();
	await page.getByTestId("confirm-session-action").click();
	await expect(row(page, "Bulk two")).toHaveCount(0, { timeout: 60_000 });
});

/**
 * #707: the archive has a place of its own from the first conversation on. With nothing archived the Archived button is
 * there, its list says so and says how to archive one, and the command palette goes to it. The archive is a preference
 * of the server shared by the worker: these tests archive nothing, and each deletes the file it wrote.
 */
for (const [lang, n, button, empty, hint, goTo, back] of [
	[
		"en",
		0xe1,
		"Archived",
		"No archived conversations.",
		"To archive one, open a conversation's menu and choose Archive.",
		"Archived conversations",
		"All conversations",
	],
	[
		"zh-CN",
		0xe2,
		"已归档",
		"没有已归档的对话。",
		"要归档一个对话，请打开它的菜单，选择“归档”。",
		"已归档的对话",
		"全部对话",
	],
] as const) {
	test(`${lang}: with nothing archived the Archived button is there and its list says how to archive`, async ({
		page,
	}) => {
		await page.addInitScript((l) => localStorage.setItem("ompw.lang", l), lang);
		const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, n, `Quiet shelf ${lang}`);
		try {
			await page.goto("/");
			await expect(row(page, `Quiet shelf ${lang}`)).toHaveCount(1, { timeout: 15_000 });

			const toggle = page.getByTestId("show-archived");
			await expect(toggle).toBeVisible();
			await expect(toggle).toHaveAccessibleName(button);
			await expect(toggle).toHaveText(button, { useInnerText: true });
			await expect(page.getByTestId("sidebar-archived-empty")).toHaveCount(0);

			await toggle.click();
			const emptyState = page.getByTestId("sidebar-archived-empty");
			await expect(emptyState).toContainText(empty);
			await expect(emptyState).toContainText(hint);
			await expect(row(page, `Quiet shelf ${lang}`)).toHaveCount(0);
			await expect(page.getByTestId("show-all-sessions")).toHaveText(back, { useInnerText: true });

			await page.getByTestId("show-all-sessions").click();
			await expect(row(page, `Quiet shelf ${lang}`)).toHaveCount(1);
			await expect(page.getByTestId("show-archived")).toBeVisible();
		} finally {
			rmSync(file, { force: true });
		}
	});

	test(`${lang}: Go to › ${goTo} in the palette opens the sidebar on the archive, even when it was hidden`, async ({
		page,
	}) => {
		await page.addInitScript((l) => localStorage.setItem("ompw.lang", l), lang);
		const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, n + 0x10, `Palette shelf ${lang}`);
		try {
			await page.goto("/");
			await expect(row(page, `Palette shelf ${lang}`)).toHaveCount(1, { timeout: 15_000 });

			// The sidebar is showing the other conversations: the palette's entry switches it to the archive.
			await page.keyboard.press("ControlOrMeta+k");
			await page.getByTestId("palette-go-archived").filter({ hasText: goTo }).click();
			await expect(page.getByTestId("palette-input")).toHaveCount(0);
			await expect(page.getByTestId("show-all-sessions")).toHaveText(back, { useInnerText: true });
			await expect(page.getByTestId("sidebar-archived-empty")).toContainText(empty);
			await page.getByTestId("show-all-sessions").click();

			// With the sidebar hidden it is opened as well.
			await page.getByRole("button", { name: lang === "en" ? "Hide sidebar" : "隐藏侧边栏" }).click();
			await expect(page.getByTestId("session-list")).toHaveCount(0);
			await page.keyboard.press("ControlOrMeta+k");
			await page.getByTestId("palette-go-archived").click();
			await expect(page.getByTestId("show-all-sessions")).toBeVisible();
			await expect(page.getByTestId("sidebar-archived-empty")).toContainText(empty);
		} finally {
			rmSync(file, { force: true });
		}
	});
}
