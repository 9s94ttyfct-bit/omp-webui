import { FIXTURE } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/** Phone layout: the sidebar is a drawer that closes when the user navigates (no model call). */

test.use({ viewport: { width: 390, height: 844 } });

test("choosing a page from the drawer closes it; the toggle stays reachable", async ({ page }) => {
	await page.goto("/");
	const toggle = page.getByRole("button", { name: "Show sidebar" });
	const drawer = page.getByRole("complementary");
	await expect(drawer).toHaveCount(0);

	await toggle.click();
	await drawer.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
	await expect(drawer).toHaveCount(0);
	const title = page.getByTestId("chat-title");
	await expect(title).toHaveText(FIXTURE.alphaTitle);
	// The toggle sits beside the title, not under it.
	const t = await toggle.boundingBox();
	const h = await title.boundingBox();
	expect(t && h && t.x + t.width <= h.x).toBe(true);

	await toggle.click();
	await drawer.getByRole("button", { name: /^Settings$/ }).click();
	await expect(drawer).toHaveCount(0);
	await expect(page.getByTestId("settings-page")).toBeVisible();
});
