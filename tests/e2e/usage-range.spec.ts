import { expect, type Page, test } from "./fixtures.ts";

/**
 * Usage & cost over a range (#714): the page opens on a month, asks the server for the range the person picks, keeps
 * that choice, and says so when the server could only give omp's own 24 hours. The server's answer is replaced by a
 * known one per range (what the real database holds depends on the calls made so far); the server side is held by
 * `tests/contract/stats-range.test.ts`.
 */

const COST: Record<string, number> = { "24h": 1.25, "7d": 2.5, "30d": 5, all: 10 };

const answer = (cost: number) => ({
	overall: {
		totalRequests: 4,
		successfulRequests: 4,
		failedRequests: 0,
		errorRate: 0,
		totalInputTokens: 1000,
		totalOutputTokens: 200,
		totalCacheReadTokens: 5000,
		totalCacheWriteTokens: 300,
		cacheRate: 0.8,
		totalCost: cost,
		avgDuration: 1500,
		avgTtft: 400,
		avgTokensPerSecond: 60,
		firstTimestamp: Date.UTC(2026, 0, 5),
		lastTimestamp: Date.UTC(2026, 0, 6),
	},
	byModel: [],
	byFolder: [],
	costSeries: [],
});

/** Answer `/api/stats` by its range; the ranges asked, in order. */
async function stubStats(page: Page, fallback: (range: string) => boolean = () => false): Promise<string[]> {
	const asked: string[] = [];
	await page.route(/\/api\/stats(\?|$)/, (route) => {
		const range = new URL(route.request().url()).searchParams.get("range") ?? "(none)";
		asked.push(range);
		return route.fulfill({
			json: answer(COST[range] ?? 0),
			headers: { "x-stats-range": range, ...(fallback(range) ? { "x-stats-fallback": "24h" } : {}) },
		});
	});
	return asked;
}

const total = (page: Page) => page.locator('[data-stat="Total cost"]');

test("the page opens on 30 days; another range is asked of the server, shown, and kept for the next visit", async ({
	page,
}) => {
	const asked = await stubStats(page);
	await page.goto("/#/usage");
	await expect(total(page)).toHaveText("$5.00");
	await expect(page.getByTestId("usage-range-30d")).toHaveAttribute("aria-pressed", "true");
	expect(asked[0]).toBe("30d");
	await page.getByTestId("usage-range-all").click();
	await expect(total(page)).toHaveText("$10.00");
	await expect(page.getByTestId("usage-range-all")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("usage-range-30d")).toHaveAttribute("aria-pressed", "false");
	await page.reload();
	await expect(total(page)).toHaveText("$10.00");
	await expect(page.getByTestId("usage-range-all")).toHaveAttribute("aria-pressed", "true");
	expect(asked.at(-1)).toBe("all");
});

test("Refresh asks for the range shown", async ({ page }) => {
	const asked = await stubStats(page);
	await page.goto("/#/usage");
	await page.getByTestId("usage-range-7d").click();
	await expect(total(page)).toHaveText("$2.50");
	await page.getByTestId("usage-page").getByRole("button", { name: "Refresh" }).click();
	await expect.poll(() => asked.length).toBeGreaterThanOrEqual(3);
	expect(asked.at(-1)).toBe("7d");
});

test("an answer to a range the person has already left is not shown", async ({ page }) => {
	let releaseSlow: () => void = () => {};
	const slow = new Promise<void>((r) => {
		releaseSlow = r;
	});
	await page.route(/\/api\/stats(\?|$)/, async (route) => {
		const range = new URL(route.request().url()).searchParams.get("range") ?? "";
		if (range === "all") await slow;
		return route.fulfill({ json: answer(COST[range] ?? 0) });
	});
	await page.goto("/#/usage");
	await expect(total(page)).toHaveText("$5.00");
	await page.getByTestId("usage-range-all").click();
	await page.getByTestId("usage-range-24h").click();
	await expect(total(page)).toHaveText("$1.25");
	releaseSlow();
	// The month-long answer arrives last and is dropped: the page keeps the day it shows.
	await page.waitForTimeout(300);
	await expect(total(page)).toHaveText("$1.25");
});

test("when the server could only give omp's 24 hours, the page says so", async ({ page }) => {
	await stubStats(page, () => true);
	await page.goto("/#/usage");
	await expect(total(page)).toBeVisible();
	await expect(page.getByTestId("usage-fallback")).toBeVisible();
});

test("on a phone the range is a row of its own and the title stays on one line", async ({ page }) => {
	await stubStats(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/#/usage");
	const heading = page.getByRole("heading", { level: 1, name: "Usage & cost" });
	await expect(heading).toBeVisible();
	const range = page.getByTestId("usage-range");
	const [h, r] = await Promise.all([heading.boundingBox(), range.boundingBox()]);
	if (!h || !r) throw new Error("not laid out");
	expect(r.y, "the range is below the title").toBeGreaterThanOrEqual(h.y + h.height);
	expect(r.x + r.width, "and fits the screen").toBeLessThanOrEqual(390);
});
