import { expect, test } from "./fixtures.ts";

/**
 * The commands page folds a command's arguments and flags behind a disclosure. It looks like the app's other
 * disclosures (a chevron that turns a quarter when open), not like the browser's own solid triangle, and it still
 * opens and closes from the keyboard. No model call.
 */

test("'Arguments & flags' has the app's chevron instead of the browser's triangle and toggles from the keyboard", async ({
	page,
}) => {
	await page.goto("/#/cli");
	await page.locator('[data-testid="cli-command"][data-command="stats"]').click();
	const details = page.locator("details", { has: page.locator("summary", { hasText: "Arguments & flags" }) });
	const summary = details.locator("summary");
	await expect(summary).toBeVisible();

	// Few flags: it starts open. No marker of the browser's is drawn; the chevron is the summary's first element.
	await expect(details).toHaveJSProperty("open", true);
	const style = await summary.evaluate((el) => {
		const s = getComputedStyle(el);
		return { display: s.display, list: s.listStyleType };
	});
	expect(style.display, "a summary that is not a list item draws no marker").not.toBe("list-item");
	expect(style.list).toBe("none");
	const chevron = summary.locator("svg").first();
	await expect(chevron).toBeVisible();
	const turn = () => chevron.evaluate((el) => getComputedStyle(el).rotate);
	// Turned a quarter while open (Tailwind's `rotate-90` is the `rotate` property).
	expect(await turn()).toBe("90deg");

	await summary.focus();
	await page.keyboard.press("Enter");
	await expect(details).toHaveJSProperty("open", false);
	await expect.poll(turn).toBe("none");
	await page.keyboard.press("Space");
	await expect(details).toHaveJSProperty("open", true);
	await expect.poll(turn).toBe("90deg");
});
