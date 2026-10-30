import { expect, test } from "./fixtures.ts";

/**
 * The "wait for the reset and retry" setting says what turning it on does in a line or two. The rest (the omp key it is,
 * the countdown, the per-conversation override, the limits of the wait) is behind "How it works", and all of it is still
 * there when opened. No model call.
 */

test("the hint is short; the rest is behind 'How it works' and nothing of it is lost", async ({ page }) => {
	await page.goto("/#/settings/chats");
	const hint = page.getByTestId("usage-wait-hint");
	await expect(hint).toBeVisible();
	await expect(hint).toContainText("omp sleeps until the provider's reset time and retries by itself");
	const lines = await hint.evaluate(
		(el) => el.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(el).lineHeight),
	);
	expect(lines, "lines of the hint under the checkbox").toBeLessThanOrEqual(2.01);

	const details = page.getByTestId("usage-wait-details");
	await expect(details).toBeHidden();
	await page.getByTestId("usage-wait-how").getByText("How it works").click();
	await expect(details).toBeVisible();
	for (const said of [
		"retry.waitForUsageReset",
		"omp config",
		"needs the provider to say when the limit resets",
		"countdown",
		"Agents tab",
		"quota pill",
		"retry.maxDelayMs",
		"automatic compaction",
	])
		await expect(details).toContainText(said);

	// Opening it is not a press on the checkbox's label.
	const box = page.getByTestId("usage-wait-default");
	const before = await box.isChecked();
	await page.getByTestId("usage-wait-how").getByText("How it works").click();
	await expect(details).toBeHidden();
	expect(await box.isChecked()).toBe(before);
});
