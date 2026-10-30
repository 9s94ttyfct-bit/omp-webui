import { boxOf } from "../support/geometry.ts";
import { expect, type Locator, test } from "./fixtures.ts";

/**
 * The Usage page's title row (no model call). On a phone the title is one line, the provenance caption ("from omp
 * stats") makes way for it and Refresh is an icon; from `sm` up the row is what it was: title, caption, Refresh with
 * its word.
 */

/** How many lines the text of `el` is set in. */
const linesOf = (el: Locator) =>
	el.evaluate((node) => {
		const range = document.createRange();
		range.selectNodeContents(node);
		return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
	});

for (const [lang, title, refresh] of [
	["en", "Usage & cost", "Refresh"],
	["zh-CN", "用量与费用", "刷新"],
] as const) {
	test.describe(`the Usage page header in ${lang}`, () => {
		test.beforeEach(async ({ page }) => {
			await page.addInitScript((l) => localStorage.setItem("ompw.lang", l), lang);
		});

		test("on a phone the title is one line, the caption is gone and Refresh is a 32px icon", async ({ page }) => {
			await page.setViewportSize({ width: 390, height: 844 });
			await page.goto("/#/usage");
			const heading = page.getByRole("heading", { level: 1, name: title });
			await expect(heading).toBeVisible();
			expect(await linesOf(heading), "the title is set on one line").toBe(1);
			await expect(page.getByTestId("usage-page").locator("code", { hasText: "omp stats" })).toBeHidden();
			const button = page.getByTestId("usage-page").getByRole("button", { name: refresh });
			const box = await boxOf(button);
			expect([box.width, box.height], "an icon button").toEqual([32, 32]);
			const head = await boxOf(heading);
			expect(box.y + box.height / 2, "centred on the title's line").toBeCloseTo(head.y + head.height / 2, 0);
		});

		test("on a desktop the caption and the word on Refresh are back", async ({ page }) => {
			await page.setViewportSize({ width: 1400, height: 900 });
			await page.goto("/#/usage");
			await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
			await expect(page.getByTestId("usage-page").locator("code", { hasText: "omp stats" })).toBeVisible();
			const button = page.getByTestId("usage-page").getByRole("button", { name: refresh });
			await expect(button).toBeVisible();
			expect((await boxOf(button)).width, "a labelled button").toBeGreaterThan(60);
		});
	});
}
