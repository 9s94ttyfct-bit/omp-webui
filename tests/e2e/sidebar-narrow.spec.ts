import { writeSimpleSession } from "../support/fixtures.ts";
import { boxOf } from "../support/geometry.ts";
import { sessionRow } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The sidebar at its narrowest (200px, the minimum the handle allows) still says what it says (no model call):
 * the first date group's name is whole next to the list's actions (Select, the archive). A date cut to "T…" says
 * nothing, and an action that spills out of the sidebar cannot be used.
 */

const sidebar = (page: Page) => page.locator("aside", { has: page.getByTestId("session-list") });

/** The first line of the list: the date group's name, and the actions at its right. */
const listHeading = (page: Page) => page.getByTestId("session-list").locator("div > div > span").first();

/** Put the sidebar at its narrowest, the way a user does: the handle, then Home. */
async function narrowest(page: Page) {
	const grip = page.getByTestId("resize-sidebar");
	await grip.focus();
	await expect(grip).toBeFocused();
	await page.keyboard.press("Home");
	await expect.poll(async () => (await boxOf(sidebar(page))).width).toBe(200);
}

/**
 * An archived conversation, so that the list's first line carries the archive toggle as well. The archive is a
 * preference of the server, shared by the whole worker, so the conversation is put back when the test is done.
 */
async function withAnArchived(page: Page, n: number, title: string, archive: string) {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const file = writeSimpleSession(agentDir, n, title);
	await page.goto("/");
	const item = sessionRow(page, title);
	await expect(item).toHaveCount(1, { timeout: 15_000 });
	await item.hover();
	await item.locator("..").getByTestId("session-menu").click();
	await page.getByRole("menuitem", { name: archive, exact: true }).click();
	await expect(page.getByTestId("show-archived")).toBeVisible();
	// The menu gives focus back to its button a moment after it closes, and the row leaves the list once the archive is
	// answered, which drops that focus to the page. Either one lands after the click: done after the handle was focused,
	// it takes the Home key from the handle. Once the row is gone, nothing is left to move the focus.
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(item).toHaveCount(0);
	return file;
}

/** A file number of its own for each test, so that they do not archive one another's conversation. */
let files = 0;

for (const [lang, archiveMenu] of [
	["en", "Archive"],
	["zh-CN", "归档"],
] as const) {
	for (const theme of ["light", "dark"] as const) {
		test(`at 200px, in ${lang} and ${theme}, the date and the list's actions read whole`, async ({ page }) => {
			await page.addInitScript(
				([l, t]) => {
					localStorage.setItem("ompw.lang", l);
					localStorage.setItem("ompw.theme", t);
				},
				[lang, theme] as const,
			);
			// A file of its own for each test: the archive is a preference of the server, shared by the worker.
			const file = await withAnArchived(page, 0x41 + files++, `Narrow ${lang} ${theme}`, archiveMenu);
			try {
				await narrowest(page);

				// The first date group's name: whole, and next to the actions rather than cut to a stub.
				const heading = listHeading(page);
				await expect(heading).toHaveText(/Today|今天/);
				expect(await heading.evaluate((e) => e.scrollWidth > e.clientWidth + 1), "the date is not cut off").toBe(false);
				const archive = page.getByTestId("show-archived");
				const select = page.getByTestId("select-sessions");
				await expect(archive).toBeVisible();
				await expect(select).toBeVisible();
				// The actions are inside the sidebar and do not overlap the name.
				const aside = await boxOf(sidebar(page));
				for (const action of [archive, select]) {
					const box = await boxOf(action);
					expect(box.x + box.width, "the action is inside the sidebar").toBeLessThanOrEqual(aside.x + aside.width + 1);
				}
				const headingBox = await boxOf(heading);
				for (const action of [archive, select]) {
					const box = await boxOf(action);
					const overlaps =
						headingBox.x < box.x + box.width &&
						box.x < headingBox.x + headingBox.width &&
						headingBox.y < box.y + box.height &&
						box.y < headingBox.y + headingBox.height;
					expect(overlaps, "the date and the actions do not overlap").toBe(false);
				}
			} finally {
				// The conversation goes back into the list, so the next test of this worker starts as it was.
				await page.request.post("/api/archive", {
					data: { files: [file], archived: false },
					headers: { "x-omp-webui": "1" },
				});
			}
		});
	}
}
