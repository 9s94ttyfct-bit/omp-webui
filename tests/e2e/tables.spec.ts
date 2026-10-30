import { FIXTURE } from "../support/fixtures.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * A markdown table keeps whole words in its cells; one that is too wide for the screen scrolls sideways instead of
 * breaking them mid-word (no model call).
 */

const TABLE = [
	"| Setting | Current value | Recommended value | Description | Configuration |",
	"|---|---|---|---|---|",
	"| Timeout | thirty seconds | sixty seconds | How long one request may run before cancellation | Environment variable |",
	"| Concurrency | four workers | eight workers | Parallel jobs per project | Command line argument |",
	"| Retries | three attempts | five attempts | Attempts before giving up completely | Configuration file entry |",
].join("\n");

/**
 * Opens the alpha fixture with its first assistant reply replaced by `markdown` (the chat reads history from
 * /api/family). On a phone the sidebar is a drawer: pass `drawer` to open it first.
 */
async function openWithMarkdown(page: Page, markdown: string, opts: { drawer?: boolean } = {}) {
	await page.route("**/api/family?*", async (route) => {
		const res = await route.fetch();
		const data = await res.json();
		for (const member of data.members) {
			for (const e of member.entries) {
				if (e.id === "f0000003") e.message.content = [{ type: "text", text: markdown }];
			}
		}
		await route.fulfill({ response: res, json: data });
	});
	await page.goto("/");
	if (opts.drawer) await page.getByRole("button", { name: "Show sidebar" }).click();
	await page.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
}

/** Words of the table's cells that the layout broke across lines. */
function brokenWords(table: Locator): Promise<string[]> {
	return table.evaluate((root) => {
		const broken: string[] = [];
		for (const cell of root.querySelectorAll("th, td")) {
			const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				if (!(node instanceof Text)) continue;
				for (const word of node.data.matchAll(/\S+/g)) {
					const range = document.createRange();
					range.setStart(node, word.index);
					range.setEnd(node, word.index + word[0].length);
					const tops = [...range.getClientRects()].map((r) => r.top);
					if (Math.max(...tops) - Math.min(...tops) > 4) broken.push(word[0]);
				}
			}
		}
		return broken;
	});
}

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("a wide table scrolls sideways and no word in it is cut", async ({ page }) => {
		await openWithMarkdown(page, TABLE, { drawer: true });
		const table = page.locator(".prose-omp table").first();
		await expect(table).toBeVisible();

		expect(await brokenWords(table)).toEqual([]);
		// It scrolls (instead of squeezing words), and the page around it does not.
		expect(await table.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		// Header cells never wrap; body cells break only at spaces.
		const th = table.locator("th").first();
		const td = table.locator("td").first();
		expect(await th.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("nowrap");
		expect(await td.evaluate((el) => getComputedStyle(el).overflowWrap)).toBe("normal");
	});
});

test("on a wide screen the same table fits and words stay whole", async ({ page }) => {
	await openWithMarkdown(page, TABLE);
	const table = page.locator(".prose-omp table").first();
	await expect(table).toBeVisible();
	expect(await brokenWords(table)).toEqual([]);
	expect(await table.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
