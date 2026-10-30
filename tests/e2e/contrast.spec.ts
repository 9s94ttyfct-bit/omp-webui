import { FIXTURE } from "../support/fixtures.ts";
import { contrastOf } from "../support/style.ts";
import { expect, test } from "./fixtures.ts";

/**
 * WCAG contrast of the colors the audit flagged, measured on the rendered page in both themes: placeholder text
 * (4.5:1), a destructive button's label (4.5:1), and the accent bar that marks the current or highlighted row (3:1,
 * the bar of the row against the row). No model call.
 */

for (const theme of ["light", "dark"] as const) {
	test.describe(`${theme} theme`, () => {
		test.beforeEach(async ({ page }) => {
			await page.addInitScript((t) => localStorage.setItem("ompw.theme", t), theme);
		});

		test("placeholders are at least 4.5:1 on the field behind them", async ({ page }) => {
			await page.goto("/");
			const ratios: Record<string, number> = {};
			ratios.composer = await contrastOf(page.getByTestId("composer"), "placeholder");
			ratios["sidebar filter"] = await contrastOf(page.getByTestId("session-filter"), "placeholder");
			await page.keyboard.press("ControlOrMeta+k");
			ratios.palette = await contrastOf(page.getByTestId("palette-input"), "placeholder");
			await page.keyboard.press("Escape");
			await page.getByRole("button", { name: "Commands & terminal" }).click();
			ratios["command filter"] = await contrastOf(page.getByLabel("Filter commands"), "placeholder");

			const low = Object.entries(ratios).filter(([, r]) => r < 4.5);
			expect(low, JSON.stringify(ratios)).toEqual([]);
		});

		test("a destructive button's label is at least 4.5:1 on its fill", async ({ page }) => {
			await page.goto("/");
			await page.locator('[data-testid="session-item"]', { hasText: FIXTURE.betaTitle }).hover();
			await page.getByRole("button", { name: `Actions for ${FIXTURE.betaTitle}` }).click();
			await page.getByRole("menuitem", { name: "Delete…" }).click();
			const confirm = page.getByTestId("confirm-session-action");
			await expect(confirm).toBeVisible();
			expect(await contrastOf(confirm, "color")).toBeGreaterThanOrEqual(4.5);
		});

		test("the current and the highlighted row carry an accent bar and say so to assistive tech", async ({ page }) => {
			await page.goto("/");
			await page.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
			await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
			const bars: Record<string, number> = {};

			// The conversation being read, in the sidebar.
			const current = page.locator('[data-testid="session-item"][aria-current="page"]');
			await expect(current).toHaveCount(1);
			bars["current conversation"] = await contrastOf(current, "shadow");

			// The page being shown, in the sidebar.
			const settings = page.getByRole("button", { name: "Settings", exact: true });
			await settings.click();
			await expect(settings).toHaveAttribute("aria-current", "page");
			bars["current page"] = await contrastOf(settings, "shadow");

			// The result a search is on.
			await page.keyboard.press("ControlOrMeta+k");
			const result = page.getByRole("dialog").getByRole("option", { selected: true });
			await expect(result).toHaveCount(1);
			bars["search result"] = await contrastOf(result, "shadow");
			await page.keyboard.press("Escape");

			// The item a menu is on.
			await page.locator('[data-testid="session-item"]', { hasText: FIXTURE.betaTitle }).hover();
			await page.getByRole("button", { name: `Actions for ${FIXTURE.betaTitle}` }).click();
			const item = page.getByRole("menuitem", { name: "Rename" });
			await item.hover();
			await expect(item).toHaveAttribute("data-highlighted", "");
			bars["menu item"] = await contrastOf(item, "shadow");

			const faint = Object.entries(bars).filter(([, r]) => r < 3);
			expect(faint, JSON.stringify(bars)).toEqual([]);
		});
	});
}
