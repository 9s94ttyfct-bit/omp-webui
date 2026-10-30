import { expect, type Page, test } from "./fixtures.ts";

/**
 * Tabbing through Settings moves the Settings page, never the app shell around it (#288). The page's visually hidden
 * radios and checkboxes (`sr-only`, `position:absolute`) used to sit outside the scroller's box, which made the shell
 * scrollable: focusing one scrolled the sidebar and header away and left a blank window (no model call).
 */

/** The five Settings pages, in the order of the index. */
const PAGES = ["look", "chats", "models", "safety", "app"] as const;

/** The scroll position and overflow of the element that clips the whole app (`overflow-hidden`, above the page). */
const shell = (page: Page) =>
	page.getByTestId("settings-page").evaluate((el) => {
		let e = el.parentElement;
		while (e && !e.classList.contains("overflow-hidden")) e = e.parentElement;
		return e ? { top: e.scrollTop, overflow: e.scrollHeight - e.clientHeight } : null;
	});

for (const size of [
	{ width: 1400, height: 900 },
	{ width: 390, height: 844 },
]) {
	test(`tabbing through Settings never scrolls the app shell (${size.width} px)`, async ({ page }) => {
		await page.setViewportSize(size);
		// One page of cards is shown at a time: each of the five is tabbed through in turn.
		for (const id of PAGES) {
			await page.goto(`/#/settings/${id}`);
			await expect(page.getByTestId("settings-page")).toBeVisible();
			await expect(page.locator(`[data-testid="settings-page-tab"][data-page="${id}"]`)).toHaveAttribute(
				"aria-current",
				"page",
			);
			// Nothing sticks out below the window to begin with.
			expect(await shell(page), `the shell on ${id}`).toEqual({ top: 0, overflow: 0 });
			await page.getByRole("heading", { name: "Settings" }).click();
			// Far enough to pass the page tabs, the search and the radios and checkboxes of the page's first cards.
			for (let i = 0; i < 40; i++) {
				await page.keyboard.press("Tab");
				expect((await shell(page))?.top, `after Tab ${i + 1} on ${id}`).toBe(0);
			}
			expect((await shell(page))?.overflow, `the shell on ${id} after tabbing`).toBe(0);
		}
	});
}
