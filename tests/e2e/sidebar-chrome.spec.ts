import { writeChatSession } from "../support/chat-session.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { boxOf } from "../support/geometry.ts";
import { sessionRow } from "../support/live.ts";
import { chooseProject, projectTrigger } from "../support/project-groups.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The sidebar's controls above the conversation list (no model call): New chat, the filter with the
 * project filter beside it, and the list's own actions (Select, the archive) on the list's first line, so that the list
 * starts high and keeps its room. Every control is still there and still works.
 */

/** The sidebar, in any language: the column that holds the conversation list. */
const sidebar = (page: Page) => page.locator("aside", { has: page.getByTestId("session-list") });
const firstRow = (page: Page) => page.getByTestId("session-item").first();
const project = (page: Page) => projectTrigger(page);

test.describe("at 1400 x 700", () => {
	test.use({ viewport: { width: 1400, height: 700 } });

	test("the list starts high: the filter and the project filter share a row, Select is not a row of its own", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(firstRow(page)).toBeVisible();
		const filter = await boxOf(page.getByTestId("session-filter"));
		const funnel = await boxOf(project(page));
		expect(funnel.width, "the project filter is a 32px button").toBe(32);
		expect(funnel.height).toBe(32);
		expect(funnel.y, "level with the filter field").toBe(filter.y);
		expect(funnel.x, "to its right").toBeGreaterThan(filter.x + filter.width);
		expect(filter.height).toBe(32);

		const select = await boxOf(page.getByTestId("select-sessions"));
		const row = await boxOf(firstRow(page));
		expect(select.y + select.height, "Select is on the list's first line, above the first row").toBeLessThanOrEqual(
			row.y,
		);
		expect(select.y, "and under the filter row").toBeGreaterThanOrEqual(filter.y + filter.height);
		const list = await boxOf(page.getByTestId("session-list"));
		expect(select.x + select.width, "at its right edge").toBeGreaterThan(list.x + list.width - 24);
		expect(select.height, "a target of at least 24px").toBeGreaterThanOrEqual(24);

		// 286px before (204px once the mode switch was gone): New chat, the filter, a project row and a Select row each took a line.
		expect(row.y, "the first conversation starts at most 224px down").toBeLessThanOrEqual(224);
	});

	test("the project filter still filters, says what it filters by, and the list's actions still work", async ({
		page,
	}) => {
		const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
		const cwd = "/tmp/ompw-chrome-heron";
		writeChatSession(agentDir, {
			n: 0x6b,
			title: "Chrome heron",
			cwd,
			turns: [{ prompt: "Where does the heron stand?", reply: "In the shallows." }],
		});
		await page.goto("/");
		await expect(sessionRow(page, "Chrome heron")).toHaveCount(1, { timeout: 15_000 });
		const funnel = project(page);
		await expect(funnel).toHaveAttribute("title", /^Project: All projects \(\d+\)$/);

		await chooseProject(page, cwd);
		await expect(page.getByTestId("session-item")).toHaveCount(1);
		await expect(funnel, "the funnel names the project").toHaveAttribute("title", `Project: ${cwd}`);
		await expect(funnel.locator("span[aria-hidden]"), "and wears a dot while it filters").toHaveCount(1);

		await chooseProject(page, null);
		await expect(funnel.locator("span[aria-hidden]")).toHaveCount(0);
		await expect(page.getByTestId("session-item")).not.toHaveCount(1);

		const select = page.getByTestId("select-sessions");
		await select.click();
		await expect(select).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByTestId("selection-bar")).toBeVisible();
		await select.click();
		await expect(select).toHaveAttribute("aria-pressed", "false");
		await expect(page.getByTestId("selection-bar")).toHaveCount(0);
	});
});

for (const [lang, archived, all, select, restore] of [
	["en", /^Archived · \d+$/, "All conversations", "Select", "Unarchive"],
	["zh-CN", /^已归档 · \d+$/, "全部对话", "选择", "取消归档"],
] as const) {
	test.describe(`the archive and Select on the list's first line in ${lang}`, () => {
		test.use({ viewport: { width: 1400, height: 800 } });

		test("they share the line, in the default sidebar and at its narrowest", async ({ page }) => {
			await page.addInitScript((l) => localStorage.setItem("ompw.lang", l), lang);
			const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
			writeSimpleSession(agentDir, lang === "en" ? 0x6c : 0x6d, `Chrome archive ${lang}`);
			await page.goto("/");
			const title = `Chrome archive ${lang}`;
			const item = sessionRow(page, title);
			await expect(item).toHaveCount(1, { timeout: 15_000 });
			await item.hover();
			await item.locator("..").getByTestId("session-menu").click();
			await page.getByRole("menuitem", { name: lang === "en" ? "Archive" : "归档", exact: true }).click();
			const toggle = page.getByTestId("show-archived");
			await expect(toggle).toHaveAccessibleName(archived);

			for (const width of [288, 200]) {
				const grip = page.getByTestId("resize-sidebar");
				await grip.focus();
				await page.keyboard.press(width === 288 ? "Enter" : "Home");
				expect((await boxOf(sidebar(page))).width).toBe(width);
				// The label is there while the sidebar is wide enough; in the narrowest one it is the icon and the count (the name stays whole).
				await expect(toggle).toHaveText(width === 288 ? archived : /^\d+$/, { useInnerText: true });
				await expect(toggle).toHaveAccessibleName(archived);
				const aside = await boxOf(sidebar(page));
				const a = await boxOf(toggle);
				const s = await boxOf(page.getByTestId("select-sessions"));
				expect(a.y, `${width}px: one line`).toBe(s.y);
				expect(a.x + a.width, "the archive sits left of Select").toBeLessThanOrEqual(s.x);
				expect(s.x + s.width, `${width}px: Select is inside the sidebar`).toBeLessThanOrEqual(aside.x + aside.width);
				expect(a.x, `${width}px: the archive is inside the sidebar`).toBeGreaterThanOrEqual(aside.x);
			}

			await toggle.click();
			const back = page.getByTestId("show-all-sessions");
			await expect(back).toHaveText(all);
			const b = await boxOf(back);
			const s = await boxOf(page.getByTestId("select-sessions"));
			expect(b.y, "in the archive view the way back shares the line with Select").toBe(s.y);
			await expect(page.getByTestId("select-sessions")).toHaveText(select);
			// Put it back, so that the archive is as empty as the other specs of this worker expect it, and the width too.
			await item.hover();
			await item.locator("..").getByTestId("session-menu").click();
			await page.getByRole("menuitem", { name: restore, exact: true }).click();
			await back.click();
			await expect(item).toHaveCount(1);
			await page.getByTestId("resize-sidebar").focus();
			await page.keyboard.press("Enter");
		});
	});
}
