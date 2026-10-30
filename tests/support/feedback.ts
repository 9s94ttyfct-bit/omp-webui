import { expect, type Page } from "@playwright/test";

/**
 * Ask for the Feedback dialog from wherever the page is: through the command palette (⌘K / Ctrl+K, "feedback"), which is
 * on every page. The sidebar's own button is gone (#660: Send feedback is a card of Settings, with the palette and the
 * shortcuts card as the other ways in), and a test that only needs *a dialog* over the page it is on must not leave it.
 * What comes of the request is the caller's to check (a test of a missing chunk expects no dialog).
 */
export async function askForFeedback(page: Page): Promise<void> {
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill("feedback");
	await page.getByTestId("palette-feedback").click();
}

/** `askForFeedback`, and the dialog is up. */
export async function openFeedback(page: Page): Promise<void> {
	await askForFeedback(page);
	await expect(page.getByRole("dialog", { name: "Send feedback" })).toBeVisible();
}
