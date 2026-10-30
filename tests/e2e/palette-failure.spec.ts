import { appReady } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A search that fails says so (with a Retry) instead of "No results", a failed refresh while the server is still indexing
 * keeps what is shown and asks again, a failed "N more" tells why, and typing on abandons the search still in flight (no
 * model call; the search answers are stubbed).
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

async function openPalette(page: Page) {
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	return page.getByTestId("palette-input");
}

test("a failed search says so and offers Retry; it is not the empty answer", async ({ page }) => {
	let failing = true;
	await page.route("**/api/search?*", (route) =>
		failing
			? route.fulfill({ status: 500, json: { error: "The search index is damaged" } })
			: route.fulfill({ json: [hit("FOUND AGAIN")] }),
	);
	const input = await openPalette(page);
	await input.fill("needle");

	const error = page.getByTestId("palette-error");
	await expect(error).toContainText("The search index is damaged");
	await expect(page.getByText("No results")).toHaveCount(0);
	await expect(page.getByTestId("search-hit")).toHaveCount(0);

	failing = false;
	await error.getByRole("button", { name: "Retry" }).click();
	await expect(page.getByTestId("search-hit")).toContainText("FOUND AGAIN");
	await expect(error).toHaveCount(0);
});

test("typing a new query clears the error of the one before", async ({ page }) => {
	await page.route("**/api/search?*", (route) =>
		new URL(route.request().url()).searchParams.get("q") === "broken"
			? route.fulfill({ status: 500, json: { error: "boom" } })
			: route.fulfill({ json: [hit("FINE")] }),
	);
	const input = await openPalette(page);
	await input.fill("broken");
	await expect(page.getByTestId("palette-error")).toContainText("boom");
	await input.fill("fine");
	await expect(page.getByTestId("search-hit")).toContainText("FINE");
	await expect(page.getByTestId("palette-error")).toHaveCount(0);
});

test("a refresh that fails while the server is still indexing keeps the hits shown and is asked again", async ({
	page,
}) => {
	let asked = 0;
	await page.route("**/api/search?*", async (route) => {
		asked++;
		if (asked === 1) {
			await route.fulfill({ json: [hit("EARLY RESULT")], headers: { "x-search-index": "120/4000" } });
		} else if (asked === 2) {
			await route.fulfill({ status: 503, json: { error: "worker restarting" } });
		} else {
			await route.fulfill({ json: [hit("EARLY RESULT"), hit("LATE RESULT")] });
		}
	});
	const input = await openPalette(page);
	await input.fill("anything");
	await expect(page.getByTestId("search-hit")).toHaveCount(1);
	// The failed refresh leaves the list as it was, with no error over it; the next one fills it.
	await expect(page.getByTestId("search-hit")).toHaveCount(2, { timeout: 15_000 });
	expect(asked).toBe(3);
	await expect(page.getByTestId("palette-error")).toHaveCount(0);
	await expect(page.getByTestId("palette-indexing")).toHaveCount(0);
});

test("a failed 'N more in this conversation' says why and leaves the row to try again", async ({ page }) => {
	let failing = true;
	await page.route("**/api/search?*", (route) => {
		if (!new URL(route.request().url()).searchParams.has("file")) return route.fulfill({ json: [hit("CAPPED", 2)] });
		return failing
			? route.fulfill({ status: 500, json: { error: "index busy" } })
			: route.fulfill({ json: [hit("CAPPED"), hit("SECOND"), hit("THIRD")] });
	});
	const input = await openPalette(page);
	await input.fill("anything");
	const more = page.getByTestId("search-more");
	await more.click();
	await expect(page.getByTestId("toast").filter({ hasText: "index busy" })).toBeVisible();
	await expect(more).toHaveCount(1);
	await expect(page.getByTestId("search-hit")).toHaveCount(1);

	failing = false;
	await more.click();
	await expect(page.getByTestId("search-hit")).toHaveCount(3);
	await expect(more).toHaveCount(0);
});

test("typing on abandons the search still in flight, so the server can drop it", async ({ page }) => {
	const abandoned = Promise.withResolvers<void>();
	const asked = Promise.withResolvers<void>();
	page.on("requestfailed", (request) => {
		if (new URL(request.url()).searchParams.get("q") === "slow") abandoned.resolve();
	});
	await page.route("**/api/search?*", async (route) => {
		// The first query is never answered; the page has to give up on it by itself.
		if (new URL(route.request().url()).searchParams.get("q") === "slow") {
			asked.resolve();
			return;
		}
		await route.fulfill({ json: [hit("FRESH RESULT")] });
	});
	const input = await openPalette(page);
	await input.fill("slow");
	await asked.promise;
	await input.fill("fresh");
	await expect(page.getByTestId("search-hit")).toContainText("FRESH RESULT");
	await abandoned.promise;
});
