import { FIXTURE } from "../support/fixtures.ts";
import { boxOf } from "../support/geometry.ts";
import { sessionRow } from "../support/live.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Where the chat's header meets the side panel's tab strip (no model call): the two columns touch, so their bottom
 * rules are one straight line and the buttons at their top edge share a centre line.
 */

test.use({ viewport: { width: 1400, height: 900 } });

test("the chat header and the panel's tab strip end on the same line", async ({ page }) => {
	await page.goto("/");
	await sessionRow(page, FIXTURE.gammaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.gammaTitle);
	await page.getByTestId("toggle-panel").click();
	const strip = page.getByTestId("right-panel-tabs");
	await expect(strip).toBeVisible();
	const header = await boxOf(page.locator("header"));
	const tabs = await boxOf(strip);
	expect(tabs.y, "both start at the top of the window").toBe(header.y);
	expect(tabs.y + tabs.height, "and both rules are on one line").toBe(header.y + header.height);
	// The panel toggle and the Close button, side by side across the seam, sit on one centre line.
	const toggle = await boxOf(page.getByTestId("toggle-panel"));
	const close = await boxOf(page.getByTestId("right-panel-close"));
	expect(close.y + close.height / 2).toBeCloseTo(toggle.y + toggle.height / 2, 0);
});
