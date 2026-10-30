import { expect, type Page, test } from "./fixtures.ts";

/**
 * The Speed card reports how fast the model answered. omp has no figure for conversations that carry no per-request
 * timing (it sends `null`; a count of zero is the same thing): the card then says there is none, not "0 tokens/s, TTFT 0ms,
 * avg 0ms", which reads as a stalled model. Stats are replaced by known ones (no model call).
 */

const overall = (over: Record<string, unknown>) => ({
	totalRequests: 4,
	successfulRequests: 4,
	failedRequests: 0,
	errorRate: 0,
	totalInputTokens: 1000,
	totalOutputTokens: 200,
	totalCacheReadTokens: 5000,
	totalCacheWriteTokens: 300,
	cacheRate: 0.8,
	totalCost: 0.42,
	avgDuration: 1500,
	avgTtft: 400,
	avgTokensPerSecond: 60,
	firstTimestamp: Date.UTC(2026, 0, 5),
	lastTimestamp: Date.UTC(2026, 0, 6),
	...over,
});

async function showSpeed(page: Page, timing: Record<string, unknown>) {
	await page.route(/\/api\/stats(\?|$)/, (route) =>
		route.fulfill({ json: { overall: overall(timing), byModel: [], byFolder: [], costSeries: [] } }),
	);
	await page.goto("/#/usage");
	await expect(page.locator('[data-stat="Speed"]')).toBeVisible();
}

const card = (page: Page) => page.locator('[data-stat="Speed"]').locator("xpath=..");

for (const [name, none] of [
	["zero", { avgTokensPerSecond: 0, avgTtft: 0, avgDuration: 0 }],
	["null (what omp sends)", { avgTokensPerSecond: null, avgTtft: null, avgDuration: null }],
] as const) {
	test(`no timing recorded (${name}): a dash and the reason, not zeros`, async ({ page }) => {
		await showSpeed(page, none);
		await expect(page.locator('[data-stat="Speed"]')).toHaveText("—");
		await expect(card(page)).toContainText("No timing recorded yet");
		await expect(card(page)).not.toContainText("tokens/s");
		await expect(card(page)).not.toContainText("0ms");
	});
}

test("with timing the card shows the speed, the first token and the average as before", async ({ page }) => {
	await showSpeed(page, {});
	await expect(page.locator('[data-stat="Speed"]')).toHaveText("60 tokens/s");
	await expect(card(page)).toContainText("TTFT 400ms · avg 1.5s");
	await expect(card(page)).not.toContainText("No timing recorded yet");
});

test("a figure omp lacks is a dash while the others are shown", async ({ page }) => {
	await showSpeed(page, { avgTokensPerSecond: 42, avgTtft: null, avgDuration: 2000 });
	await expect(page.locator('[data-stat="Speed"]')).toHaveText("42 tokens/s");
	await expect(card(page)).toContainText("TTFT — · avg 2.0s");
});
