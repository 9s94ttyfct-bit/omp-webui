import { FIXTURE_FILES } from "../support/fixtures.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * The version switcher of a prompt with several versions sits at the edge of the prompt's bubble, whether or
 * not the hover actions beside it are showing (fixtures, no model call).
 */

async function openGammaPrompt(page: Page) {
	await page.goto("/");
	await page.locator(`[data-testid="session-item"][data-file$="${FIXTURE_FILES.gamma}"]`).click();
	// Gamma's first prompt has an abandoned sibling in the same file: two versions.
	const prompt = page.locator('[data-testid="msg-user"]', { hasText: "config files" });
	await expect(prompt.getByTestId("sibling-nav")).toContainText("/ 2");
	return prompt;
}

/** How far the switcher's right edge is from the bubble's. */
async function offset(prompt: Locator) {
	const [bubble, nav] = await Promise.all([
		prompt.locator(".bg-bubble").boundingBox(),
		prompt.getByTestId("sibling-nav").boundingBox(),
	]);
	if (!(bubble && nav)) throw new Error("the prompt or its switcher is not on screen");
	return bubble.x + bubble.width - (nav.x + nav.width);
}

test("the switcher sits at the bubble's edge with the actions hidden and shown", async ({ page }) => {
	const prompt = await openGammaPrompt(page);

	await page.mouse.move(0, 0);
	await expect(prompt.getByTestId("msg-actions")).toHaveCSS("opacity", "0");
	expect(Math.abs(await offset(prompt))).toBeLessThan(2);

	await prompt.hover();
	await expect(prompt.getByTestId("msg-actions")).toHaveCSS("opacity", "1");
	expect(Math.abs(await offset(prompt))).toBeLessThan(2);
});
