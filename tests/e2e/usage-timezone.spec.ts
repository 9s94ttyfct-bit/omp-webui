import { expect, test } from "./fixtures.ts";

/**
 * omp's `costSeries` buckets are UTC days: each `timestamp` is 00:00:00Z. The usage page names a bucket by the date it
 * covers (the axis, the tooltip and the table), says so ("UTC days"), and prints the date of the first request the same
 * way, so in no time zone does a day's label come before the first request or disagree with "since …". It used to label
 * a bucket with the viewer's local date of its start: one day early everywhere west of UTC (#293). The stats are
 * replaced by a known set: one request answered at 15:37:55Z on 2026-10-19, in a bucket that starts at 00:00Z that day.
 */

const FIRST = Date.UTC(2026, 9, 19, 15, 37, 55);
const stats = {
	overall: {
		totalRequests: 17,
		successfulRequests: 17,
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
		firstTimestamp: FIRST,
		lastTimestamp: FIRST + 3_600_000,
	},
	byModel: [],
	byFolder: [],
	costSeries: [{ timestamp: Date.UTC(2026, 9, 19), model: "acme/model-0", cost: 0.42, requests: 17 }],
};

/** West of UTC, UTC, and east of it: the label must not move with the zone. */
for (const timezoneId of ["America/Chicago", "Pacific/Honolulu", "UTC", "Asia/Shanghai", "Pacific/Auckland"]) {
	test.describe(timezoneId, () => {
		test.use({ timezoneId });

		test("the day of the first request is labelled with its own date, on the axis, in the table and in the card", async ({
			page,
		}) => {
			await page.route(/\/api\/stats(\?|$)/, (route) => route.fulfill({ json: stats }));
			await page.goto("/#/usage");
			const table = page.getByTestId("daily-table");
			await expect(table).toBeVisible();
			await expect(table.locator("thead th").first()).toHaveText("Day (UTC)");
			await expect(table.locator("tbody tr")).toHaveCount(1);
			await expect(table.locator("tbody td").first()).toHaveText("2026-10-19");
			await expect(table.locator("[data-day-total]")).toHaveAttribute("data-day-total", "2026-10-19");
			await expect(page.getByTestId("daily-chart").getByText("2026-10-19", { exact: true })).toBeVisible();
			await expect(page.getByRole("heading", { name: "Daily cost by model (UTC days)" })).toBeVisible();
			// The card says the same date: the first request is never "after" the day it is counted in.
			await expect(page.getByText("since 2026-10-19 UTC")).toBeVisible();
			// The tooltip of the bar names the same day.
			await page.locator('[data-testid="daily-chart"] .recharts-bar-rectangle').first().hover();
			await expect(page.getByTestId("daily-tooltip")).toContainText("2026-10-19");
		});
	});
}
