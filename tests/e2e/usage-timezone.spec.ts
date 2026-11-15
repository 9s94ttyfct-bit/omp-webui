import { expect, test } from "./fixtures.ts";

/**
 * The server's `costSeries` buckets are the page's days (it asks with its time zone): each `timestamp` is the page's
 * local midnight. The usage page names a bucket by the date it covers (the axis, the tooltip and the table), and prints
 * the date of the first request the same way, so in no time zone does a day's label come before the first request or
 * disagree with "since …". It once labelled a UTC-day bucket with the viewer's date of its start: one day early
 * everywhere west of UTC (#293). The stats are replaced by a known set: one request answered at 15:37:55Z on
 * 2026-10-19, in the bucket of the day it fell on in the page's zone.
 */

const FIRST = Date.UTC(2026, 9, 19, 15, 37, 55);
const statsIn = (midnight: number) => ({
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
	costSeries: [{ timestamp: midnight, model: "acme/model-0", cost: 0.42, requests: 17 }],
});

/**
 * West of UTC, UTC, and east of it: the date 15:37:55Z falls on in each zone, and the midnight it begins at there (the
 * bucket the server answers). It is already the 20th in Auckland (UTC+13 in October).
 */
const DAYS: Record<string, [string, number]> = {
	"America/Chicago": ["2026-10-19", Date.UTC(2026, 9, 19, 5)],
	"Pacific/Honolulu": ["2026-10-19", Date.UTC(2026, 9, 19, 10)],
	UTC: ["2026-10-19", Date.UTC(2026, 9, 19)],
	"Asia/Shanghai": ["2026-10-19", Date.UTC(2026, 9, 18, 16)],
	"Pacific/Auckland": ["2026-10-20", Date.UTC(2026, 9, 19, 11)],
};

for (const [timezoneId, [date, midnight]] of Object.entries(DAYS)) {
	test.describe(timezoneId, () => {
		test.use({ timezoneId });

		test("the day of the first request is labelled with its own date, on the axis, in the table and in the card", async ({
			page,
		}) => {
			await page.route(/\/api\/stats(\?|$)/, (route) => route.fulfill({ json: statsIn(midnight) }));
			await page.goto("/#/usage");
			const table = page.getByTestId("daily-table");
			await expect(table).toBeVisible();
			await expect(table.locator("thead th").first()).toHaveText("Day");
			await expect(table.locator("tbody tr")).toHaveCount(1);
			await expect(table.locator("tbody td").first()).toHaveText(date);
			await expect(table.locator("[data-day-total]")).toHaveAttribute("data-day-total", date);
			await expect(page.getByTestId("daily-chart").getByText(date, { exact: true })).toBeVisible();
			await expect(page.getByRole("heading", { name: "Daily cost by model" })).toBeVisible();
			// The card says the same date: the first request is never "after" the day it is counted in.
			await expect(page.getByText(`since ${date}`)).toBeVisible();
			// The tooltip of the bar names the same day.
			await page.locator('[data-testid="daily-chart"] .recharts-bar-rectangle').first().hover();
			await expect(page.getByTestId("daily-tooltip")).toContainText(date);
		});
	});
}
