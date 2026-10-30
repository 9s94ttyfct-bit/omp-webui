import { appendFileSync } from "node:fs";
import { appReady } from "../support/live.ts";
import { Chain, writeRenderSession } from "../support/render-fixtures.ts";
import { expect, test } from "./fixtures.ts";

/**
 * While the server is still building its search index (first start, after an update) the palette says that the results
 * may be missing older conversations, and asks again until the index is complete (no model call).
 */

const hit = (title: string, more?: number) => ({
	file: "/tmp/ompw-fixture-project/none.jsonl",
	entryId: title,
	role: "assistant",
	snippet: `${title} snippet`,
	timestamp: "2026-01-05T10:00:00.000Z",
	title,
	cwd: "/tmp/ompw-fixture-project",
	...(more ? { more } : {}),
});

test("a search answered from a partial index says so and is asked again until the index is complete", async ({
	page,
}) => {
	let asked = 0;
	await page.route("**/api/search?*", async (route) => {
		asked++;
		if (asked === 1) {
			await route.fulfill({ json: [hit("EARLY RESULT")], headers: { "x-search-index": "120/4000" } });
		} else {
			await route.fulfill({ json: [hit("EARLY RESULT"), hit("LATE RESULT")] });
		}
	});
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill("anything");
	await expect(page.getByTestId("palette-indexing")).toContainText("120 of 4000");
	await expect(page.getByTestId("search-hit")).toHaveCount(1);
	await expect(page.getByTestId("search-hit")).toHaveCount(2, { timeout: 10_000 });
	await expect(page.getByTestId("palette-indexing")).toHaveCount(0);
});

test("an answer from a complete index shows no note", async ({ page }) => {
	await page.route("**/api/search?*", (route) => route.fulfill({ json: [hit("ONLY RESULT")] }));
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill("anything");
	await expect(page.getByTestId("search-hit")).toHaveCount(1);
	await expect(page.getByTestId("palette-indexing")).toHaveCount(0);
});

test("a conversation whose last line is not whole is expanded in full, with no 'still indexing' note and one request (#544)", async ({
	page,
}) => {
	// omp killed in the middle of a write: the transcript ends in a line with no newline that is not JSON yet.
	const c = new Chain("pl");
	for (let i = 1; i <= 5; i++) c.user(`rhubarb entry number ${i}`);
	const file = writeRenderSession(
		process.env.OMPW_E2E_AGENT_DIR as string,
		"01a00000-0000-7000-8000-000000000544",
		c.entries,
	);
	appendFileSync(file, '{"type":"message","id":"zz","mess');
	let named = 0;
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname === "/api/search" && url.searchParams.has("file")) named++;
	});
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill("rhubarb entry");
	// Three of the five, and the row that offers the other two.
	await expect(page.getByTestId("search-hit")).toHaveCount(3);
	await page.getByTestId("search-more").click();
	await expect(page.getByTestId("search-hit")).toHaveCount(5);
	await expect(page.getByTestId("search-more")).toHaveCount(0);
	// All there is of the conversation that will be indexed is in: nothing more is coming, and the page does not say so.
	await expect(page.getByTestId("palette-file-indexing")).toHaveCount(0);
	expect(named).toBe(1);
});

test("a conversation that stays out of the index is asked for a bounded number of times, then the note says it was left", async ({
	page,
}) => {
	let named = 0;
	await page.route("**/api/search?*", (route) => {
		if (!new URL(route.request().url()).searchParams.has("file")) return route.fulfill({ json: [hit("CAPPED", 2)] });
		named++;
		return route.fulfill({ json: [hit("CAPPED"), hit("SECOND")], headers: { "x-search-file": "100/200" } });
	});
	// Minutes pass without the page waiting for them.
	await page.clock.install();
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill("anything");
	await page.getByTestId("search-more").click();
	const note = page.getByTestId("palette-file-indexing");
	await expect(note).toContainText("more of its results are on the way");
	// The first answer and ten more, three seconds apart.
	for (let asked = 1; asked <= 10; asked++) {
		await expect.poll(() => named).toBe(asked);
		await page.clock.fastForward(3_000);
	}
	await expect.poll(() => named).toBe(11);
	await expect(note).toContainText("still not fully indexed (100 of 200)");
	// Past the bound it is not asked again, however long the palette stays open.
	await page.clock.fastForward(5 * 60_000);
	await expect(note).toContainText("still not fully indexed");
	expect(named).toBe(11);
});
