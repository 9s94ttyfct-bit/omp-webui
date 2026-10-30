import { expect, type Page } from "@playwright/test";

/**
 * The session panel folds its least-used settings under Advanced (#716): auto-retry, steering, follow-up, interrupt and
 * cache warming. A spec that reads or sets one of them unfolds it first, once the panel is open; the open state is a
 * preference, so it may be unfolded already.
 */
export async function unfoldAdvanced(page: Page): Promise<void> {
	const fold = page.getByTestId("session-controls-panel").getByTestId("session-controls-advanced");
	await expect(fold).toBeVisible();
	if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
	await expect(fold).toHaveAttribute("aria-expanded", "true");
}
