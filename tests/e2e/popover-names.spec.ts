import { FIXTURE } from "../support/fixtures.ts";
import { openSidebar, sessionRow } from "../support/live.ts";
import { expect, test } from "./fixtures.ts";

/** The header's popovers are dialogs a screen reader announces by their visible title (#292). No model call. */

test("Session settings is a dialog named by its title", async ({ page }) => {
	await page.goto("/");
	await openSidebar(page);
	await sessionRow(page, FIXTURE.alphaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
	await page.getByTestId("session-controls").click();
	const panel = page.getByTestId("session-controls-panel");
	await expect(panel).toBeVisible();
	await expect(panel).toHaveAttribute("role", "dialog");
	await expect(page.getByRole("dialog", { name: "This session" })).toBeVisible();
});
