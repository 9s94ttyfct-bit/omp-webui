import { FIXTURE_FILES } from "../support/fixtures.ts";
import { openSidebar } from "../support/live.ts";
import { devices, expect, type Page, test } from "./fixtures.ts";

/**
 * Controls that appear on hover must be reachable where there is no hover: the open conversation's row menu, message
 * actions and love buttons on coarse pointers, and the version switcher whenever there are several versions (no model
 * call). The other rows show no menu button on a touch screen: their names have the whole row.
 */

const { defaultBrowserType: _browser, ...pixel } = devices["Pixel 5"];

/** Gamma, found by file because other specs rename it. */
const gammaRow = (page: Page) => page.locator(`[data-testid="session-item"][data-file$="${FIXTURE_FILES.gamma}"]`);
/** Gamma's first prompt has an abandoned sibling in the same file: two versions, whatever other specs delete. */
const versionedPrompt = (page: Page) => page.locator('[data-testid="msg-user"]', { hasText: "config files" });
const menuOf = (page: Page) => gammaRow(page).locator("..").getByTestId("session-menu");

async function openGamma(page: Page) {
	await gammaRow(page).click();
	await expect(versionedPrompt(page)).toBeVisible();
}

test.describe("touch screen", () => {
	test.use(pixel);

	test("the open row's menu, message actions and version switcher are visible without hover", async ({ page }) => {
		await page.goto("/");
		expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
		expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(false);

		await page.getByRole("button", { name: "Show sidebar" }).click();
		await expect(menuOf(page)).toHaveCSS("opacity", "0");
		await openGamma(page);

		await expect(versionedPrompt(page).getByTestId("msg-actions")).toHaveCSS("opacity", "1");
		await expect(versionedPrompt(page).getByTestId("sibling-nav")).toContainText("/ 2");
		await expect(versionedPrompt(page).getByTestId("sibling-nav")).toHaveCSS("opacity", "1");

		await openSidebar(page);
		await expect(menuOf(page)).toHaveCSS("opacity", "1");
	});

	test("the love button in the model picker is visible without hover", async ({ page }) => {
		await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
		await page.goto("/");
		await page.getByTestId("model-picker").click();
		// cmdk pre-selects the first row, which shows its button anyway: look at one that isn't selected.
		const love = page.getByTestId("model-love").last();
		await expect(love).toBeVisible({ timeout: 30_000 });
		await expect(love).toHaveCSS("opacity", "1");
	});
});

test.describe("mouse", () => {
	test("row menu and message actions still appear on hover only; the version switcher never hides", async ({
		page,
	}) => {
		await page.goto("/");
		expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);
		await expect(menuOf(page)).toHaveCSS("opacity", "0");
		await gammaRow(page).hover();
		await expect(menuOf(page)).toHaveCSS("opacity", "1");

		await openGamma(page);
		await page.mouse.move(0, 0);
		const prompt = versionedPrompt(page);
		await expect(prompt.getByTestId("msg-actions")).toHaveCSS("opacity", "0");
		await expect(prompt.getByTestId("sibling-nav")).toHaveCSS("opacity", "1");
		await prompt.hover();
		await expect(prompt.getByTestId("msg-actions")).toHaveCSS("opacity", "1");
	});
});
