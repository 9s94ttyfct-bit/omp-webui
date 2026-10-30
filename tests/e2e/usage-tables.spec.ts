import { distance, pixelsAt } from "../support/pixels.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The usage page shows a table only when it has rows, and lays tables out side by side only when both have
 * some. omp's accounting is replaced by a known one: what the real `omp stats` holds depends on the calls
 * made so far (fixture conversations, no model call).
 */

const bucket = (over: Record<string, unknown> = {}) => ({
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

const model = bucket({ provider: "anthropic", model: "claude-haiku-5-5" });
const folder = bucket({ folder: "/tmp/ompw-fixture-project" });
const agent = bucket({ agentType: "scout" });

async function showStats(page: Page, stats: Record<string, unknown>) {
	await page.route(/\/api\/stats(\?|$)/, (route) =>
		route.fulfill({ json: { overall: bucket(), byModel: [], byFolder: [], costSeries: [], ...stats } }),
	);
	await page.goto("/#/usage");
	await expect(page.locator("[data-stat]").first()).toBeVisible();
}

const tables = (page: Page) => page.locator("section", { has: page.locator("table[data-testid^='table-']") });
const table = (page: Page, id: string) => page.locator("section", { has: page.getByTestId(`table-${id}`) });

test("tables with no rows are left out instead of showing only their headings", async ({ page }) => {
	await showStats(page, { byModel: [], byFolder: [], byAgentType: [] });
	await expect(tables(page)).toHaveCount(0);
	// Conversations on disk still list their cost, and the page does not claim a fresh install.
	await expect(page.getByRole("heading", { name: "Most expensive conversations" })).toBeVisible();
	await expect(page.getByTestId("usage-fresh")).toHaveCount(0);
});

test("a table with rows shows while the empty ones stay out", async ({ page }) => {
	await showStats(page, { byModel: [model] });
	await expect(table(page, "By model")).toBeVisible();
	await expect(table(page, "By project")).toHaveCount(0);
	await expect(table(page, "By agent type")).toHaveCount(0);
});

test("without agent-type data the project table takes the full width", async ({ page }) => {
	await showStats(page, { byModel: [model], byFolder: [folder] });
	const [models, projects] = await Promise.all([
		table(page, "By model").boundingBox(),
		table(page, "By project").boundingBox(),
	]);
	expect(models && projects && Math.abs(models.width - projects.width) < 2).toBe(true);
	await expect(table(page, "By agent type")).toHaveCount(0);
});

test("with both project and agent-type data they sit side by side", async ({ page }) => {
	await showStats(page, { byModel: [model], byFolder: [folder], byAgentType: [agent] });
	const [models, projects, agents] = await Promise.all([
		table(page, "By model").boundingBox(),
		table(page, "By project").boundingBox(),
		table(page, "By agent type").boundingBox(),
	]);
	expect(models && projects && agents).toBeTruthy();
	if (!(models && projects && agents)) return;
	expect(projects.width).toBeLessThan(models.width * 0.6);
	expect(agents.x).toBeGreaterThan(projects.x + projects.width - 1);
	expect(Math.abs(agents.y - projects.y)).toBeLessThan(2);
});

test("on a phone every card fits the screen and a table's headers stay on one line", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await showStats(page, { byModel: [model], byFolder: [folder], byAgentType: [agent] });
	const widths = await page
		.locator("[data-testid=usage-page] section")
		.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
	expect(widths.length).toBeGreaterThanOrEqual(3);
	// Each card is as wide as the column (the viewport less the page's padding), not as wide as its widest table.
	for (const w of widths) expect(w).toBeLessThanOrEqual(390);
	const scroller = await page
		.getByTestId("usage-page")
		.evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
	expect(scroller.scroll).toBeLessThanOrEqual(scroller.client);
	// A header such as "Cache R/W" or "Requests" is one line, however narrow its column (the table scrolls inside its card).
	const heights = await page
		.locator("table[data-testid^='table-'] th")
		.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
	expect(Math.max(...heights)).toBeLessThan(40);
});

/**
 * The pinned Cost column must not cut a figure in half: at 390px it started at x=276 over the Input column, so "1.20M"
 * read as "1.20" and the Output and Cache hit columns were entirely behind it, with nothing to say the table scrolls.
 * A narrow card therefore shows whole columns only, and the pinned cell has a divider of its own.
 */
test("on a phone the pinned Cost column cuts no column in half", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await showStats(page, { byModel: [model], byFolder: [folder], byAgentType: [agent] });
	for (const id of ["By model", "By project", "By agent type"]) {
		const cells = await table(page, id)
			.locator("thead th")
			.evaluateAll((els) =>
				els.map((el) => {
					const b = el.getBoundingClientRect();
					return { text: (el.textContent ?? "").trim(), left: b.left, right: b.right, width: b.width };
				}),
			);
		const cost = cells.find((c) => c.text === "Cost");
		expect(cost, `${id}: the Cost column`).toBeTruthy();
		if (!cost) continue;
		// Every other column ends before the Cost cell starts: nothing is cut in half, and none is hidden behind it.
		for (const cell of cells) {
			if (cell.text === "Cost") continue;
			expect(cell.right, `${id}: the right edge of the "${cell.text}" column`).toBeLessThanOrEqual(cost.left + 0.5);
		}
	}
});

/**
 * The Cost column is pinned over the table, so it is a square box: without a clip it painted over the card's rounded
 * bottom-right corner and its border, and the card looked cut off. The pixels are read, not the stylesheet: what the
 * card's own border colour is at the corner is what the reader sees.
 */
test("the pinned Cost column does not paint over the card's rounded corner", async ({ page }) => {
	await showStats(page, { byModel: [model], byFolder: [folder], byAgentType: [agent] });
	for (const id of ["By model", "By project", "By agent type"]) {
		const card = table(page, id);
		await expect(card).toBeVisible();

		// The card clips what is in it, so the table's square box cannot reach past its radius.
		const overflow = await card.evaluate((el) => getComputedStyle(el.closest("section") as Element).overflow);
		expect(overflow, `${id}: the card's overflow`).toBe("hidden");

		// And the corner is painted: the card's border runs along its right edge, where the Cost cell is.
		const box = await card.evaluate((el) => {
			const card = (el.closest("section") as Element).getBoundingClientRect();
			return { left: card.left, right: card.right, top: card.top, bottom: card.bottom };
		});
		const png = await page.screenshot({
			clip: { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top },
		});
		// The border's own colour, read from a pixel of the left edge (which the Cost cell never covers).
		const border = (await pixelsAt(page, png, [{ x: 0, y: 10 }]))[0];
		// Two pixels above the bottom edge, at the right edge: the border has to be there, not the Cost cell's fill.
		const corner = await pixelsAt(page, png, [{ x: box.right - box.left - 1, y: box.bottom - box.top - 3 }]);
		expect(distance(border, corner[0]), `${id}: the border at the bottom-right corner`).toBeLessThanOrEqual(3);
	}
});

/**
 * Cost is the figure each table is about, so it is never the part of a card that is out of sight: laptop widths used to
 * set the project and agent-type cards side by side at about 520px each, with a table wider than that scrolling inside,
 * its Cost column the one cut off. Now the pair stacks until each card is wide enough, a card narrower than 36rem gives up
 * its Cache R/W column, and on a phone the Cost column stays at the card's edge while the rest scrolls.
 */
for (const viewport of [
	{ width: 1400, height: 900 },
	{ width: 1024, height: 768 },
	{ width: 390, height: 844 },
]) {
	test(`at ${viewport.width}px every table shows its Cost header and every cost inside its card`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await showStats(page, { byModel: [model], byFolder: [folder], byAgentType: [agent] });
		for (const id of ["By model", "By project", "By agent type"]) {
			const card = table(page, id);
			const cardBox = await card.boundingBox();
			const cells = [card.getByRole("columnheader", { name: "Cost" }), ...(await card.locator("[data-cost]").all())];
			expect(cells.length, `${id}: the header and a cost`).toBeGreaterThanOrEqual(2);
			for (const cell of cells) {
				const box = await cell.boundingBox();
				expect(box, id).toBeTruthy();
				if (!(box && cardBox)) continue;
				expect(box.x + box.width, `${id}: right edge of a Cost cell`).toBeLessThanOrEqual(
					cardBox.x + cardBox.width + 0.5,
				);
				expect(box.x, `${id}: left edge of a Cost cell`).toBeGreaterThanOrEqual(cardBox.x);
			}
		}
	});
}

test("a laptop's width stacks the pair when side by side would squeeze both; a wide window keeps them side by side", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1024, height: 768 });
	await showStats(page, { byModel: [model], byFolder: [folder], byAgentType: [agent] });
	const [projects, agents] = await Promise.all([
		table(page, "By project").boundingBox(),
		table(page, "By agent type").boundingBox(),
	]);
	expect(projects && agents).toBeTruthy();
	if (!(projects && agents)) return;
	expect(agents.y, "stacked: the second card is below the first").toBeGreaterThan(projects.y + projects.height - 1);
	expect(Math.abs(agents.width - projects.width)).toBeLessThan(2);
});

test("a card narrower than 36rem leaves out Cache R/W, a wider one keeps it", async ({ page }) => {
	await showStats(page, { byModel: [model], byFolder: [folder], byAgentType: [agent] });
	const header = (id: string) => table(page, id).getByRole("columnheader", { name: "Cache R/W" });
	// Side by side at 1400px the cards are about 520px.
	await expect(header("By project")).toBeHidden();
	await expect(header("By model")).toBeVisible();
});

test("kept figures show at once and give way to omp's new ones (#690)", async ({ page }) => {
	const kept = { overall: bucket({ totalCost: 1.25 }), byModel: [], byFolder: [], costSeries: [] };
	const fresh = { ...kept, overall: bucket({ totalCost: 2.5 }) };
	let release: () => void = () => {};
	const ran = new Promise<void>((r) => {
		release = r;
	});
	await page.route(/\/api\/stats(\?|$)/, async (route) => {
		if (!route.request().url().includes("wait=1"))
			return route.fulfill({
				json: kept,
				headers: { "x-stats-at": String(Date.UTC(2026, 9, 27, 9, 0)), "x-stats-refreshing": "1" },
			});
		// omp is still bringing its figures up to date.
		await ran;
		return route.fulfill({ json: fresh, headers: { "x-stats-at": String(Date.now()) } });
	});
	await page.goto("/#/usage");
	const total = page.locator('[data-stat="Total cost"]');
	await expect(total).toHaveText("$1.25");
	await expect(page.getByTestId("usage-kept")).toBeVisible();
	release();
	await expect(total).toHaveText("$2.50");
	await expect(page.getByTestId("usage-kept")).toHaveCount(0);
});

test("a row omp sends no cache rate for (it sends none by agent type) shows the rate of its tokens", async ({
	page,
}) => {
	await showStats(page, {
		byAgentType: [
			bucket({ agentType: "main", cacheRate: null }),
			bucket({ agentType: "guard", cacheRate: null, totalInputTokens: 0, totalCacheReadTokens: 0 }),
		],
	});
	const rows = table(page, "By agent type").getByRole("row");
	// 5,000 cache reads of 6,000 tokens read; a row that read nothing has no rate to show.
	await expect(rows.filter({ hasText: "main" }).getByTestId("bucket-cache-rate")).toHaveText("83%");
	await expect(rows.filter({ hasText: "guard" }).getByTestId("bucket-cache-rate")).toHaveText("–");
});
