import { appReady } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** Palette search: a slow response to an earlier query must not replace the latest query's results (no model call). */

const hit = (title: string) => ({
	file: "/tmp/ompw-fixture-project/none.jsonl",
	entryId: title,
	role: "assistant",
	snippet: `${title} snippet`,
	timestamp: "2026-01-05T10:00:00.000Z",
	title,
	cwd: "/tmp/ompw-fixture-project",
});

/** Lets the stale response's handler run before asserting that it changed nothing. */
const settle = (page: Page) =>
	page.evaluate(() => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 100);
		return promise;
	});

/** Searches for "slow" hang until released; any other query answers at once with a "FRESH" hit. */
async function slowSearch(page: Page) {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const delivered = Promise.withResolvers<void>();
	await page.route("**/api/search?*", async (route) => {
		const q = new URL(route.request().url()).searchParams.get("q");
		if (q === "slow") {
			started.resolve();
			await release.promise;
			await route.fulfill({ json: [hit("STALE RESULT")] });
			delivered.resolve();
		} else {
			await route.fulfill({ json: [hit("FRESH RESULT")] });
		}
	});
	return { started: started.promise, release: release.resolve, delivered: delivered.promise };
}

test("an earlier query's slow response never overwrites the latest query's results", async ({ page }) => {
	const slow = await slowSearch(page);
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	const input = page.getByTestId("palette-input");
	await input.fill("slow");
	await slow.started;
	await input.fill("fresh");
	await expect(page.getByTestId("search-hit")).toContainText("FRESH RESULT");

	slow.release();
	await slow.delivered;
	await settle(page);
	await expect(page.getByTestId("search-hit")).toHaveCount(1);
	await expect(page.getByTestId("search-hit")).toContainText("FRESH RESULT");
	await expect(page.getByText("STALE RESULT")).toHaveCount(0);
});

test("a search still in flight when the query is cleared never shows results", async ({ page }) => {
	const slow = await slowSearch(page);
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	const input = page.getByTestId("palette-input");
	await input.fill("slow");
	await slow.started;
	await input.fill("");
	slow.release();
	await slow.delivered;
	await settle(page);
	await expect(page.getByTestId("search-hit")).toHaveCount(0);
	await expect(page.getByText("STALE RESULT")).toHaveCount(0);
});
