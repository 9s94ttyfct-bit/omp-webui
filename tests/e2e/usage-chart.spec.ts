import AxeBuilder from "@axe-core/playwright";
import { PALETTES } from "../../web/src/lib/theme.ts";
import { CHART_TOKENS, colour, contrast, effective, readPalettes } from "../support/palettes.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The daily-cost chart on the usage page wears the palette and mode it is shown in: its series are the palette's
 * `--chart-1…8` (each 3:1 or more on the card), the legend and the tooltip print their words in the page's ink with a
 * swatch of the series colour (never in the series colour: 1.9–3:1 on a light palette), the models beyond the eight
 * colours are added up under "Other", and the bars are drawn in place instead of growing in. The stats are replaced by a
 * known set of ten models (what the real `omp stats` holds depends on the calls made so far; no model call).
 */

const palettes = readPalettes();
const MODES = ["light", "dark"] as const;
const COMBOS = PALETTES.flatMap((id) => MODES.map((mode) => ({ id, mode })));

const bucket = {
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
	lastTimestamp: Date.UTC(2026, 0, 7),
};

/** Ten models, model-0 the dearest: three days, each model dearer on later days. */
const NAMES = Array.from({ length: 10 }, (_, i) => `acme/model-${i}`);
const costSeries = [5, 6, 7].flatMap((day, d) =>
	NAMES.map((model, i) => ({ timestamp: Date.UTC(2026, 0, day, 12), model, cost: (10 - i) * 0.01 + d * 0.001 })),
);

async function showChart(page: Page) {
	await page.route(/\/api\/stats(\?|$)/, (route) =>
		route.fulfill({ json: { overall: bucket, byModel: [], byFolder: [], costSeries } }),
	);
	await page.goto("/#/usage");
	await expect(page.getByTestId("daily-chart")).toBeVisible();
	await expect(page.locator('[data-testid="daily-chart"] .recharts-bar-rectangle path').first()).toBeAttached();
}

/** axe's colour-contrast over what is on the page now; each violating element, in words. */
async function lowContrast(page: Page, where: string): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${where}: ${n.target.join(" ")} — ${(n.any[0]?.message ?? v.help).replace(/\s+/g, " ")}`),
	);
}

const rgb = ({ r, g, b }: { r: number; g: number; b: number }) => `rgb(${r}, ${g}, ${b})`;

for (const { id, mode } of COMBOS) {
	test(`${id} ${mode}: series, legend and tooltip are the palette's and readable`, async ({ page }) => {
		await page.addInitScript(
			([p, m]) => {
				localStorage.setItem("ompw.palette", p);
				localStorage.setItem("ompw.theme", m);
			},
			[id, mode],
		);
		await showChart(page);
		const tokens = effective(palettes[id], mode === "dark");
		const series = CHART_TOKENS.map((name) => rgb(colour(tokens, name)));

		// Eight series, in the palette's order (the dearest model takes the first colour), each 3:1 on the card.
		const fills = await page
			.locator('[data-testid="daily-chart"] .recharts-bar-rectangle path')
			.evaluateAll((paths) => paths.map((p) => getComputedStyle(p).fill));
		expect([...new Set(fills)]).toEqual(series);
		const card = colour(tokens, "surface");
		for (const fill of series) {
			const [r, g, b] = fill.match(/\d+/g)?.map(Number) ?? [];
			expect(contrast({ r, g, b }, card), `${fill} on the card`).toBeGreaterThanOrEqual(3);
		}

		// Seven models and "Other" for the three cheapest, named in the muted ink.
		const legend = page.locator('[data-testid="daily-chart"] .recharts-legend-item-text');
		await expect(legend).toHaveText([...NAMES.slice(0, 7), "Other"]);
		const legendInk = await legend.evaluateAll((items) =>
			items.map((item) => getComputedStyle(item.firstElementChild ?? item).color),
		);
		expect(new Set(legendInk)).toEqual(new Set([rgb(colour(tokens, "muted"))]));
		const swatches = await page
			.locator('[data-testid="daily-chart"] .recharts-legend-item svg path')
			.evaluateAll((paths) => paths.map((p) => getComputedStyle(p).fill));
		expect(swatches).toEqual(series);

		const bad = await lowContrast(page, "legend");

		// The tooltip of a day: the day in the ink, each model's name in muted and its cost in the ink, a swatch each.
		await page.locator('[data-testid="daily-chart"] .recharts-bar-rectangle').first().hover();
		const tooltip = page.getByTestId("daily-tooltip");
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toContainText("Other");
		const tooltipInk = await tooltip.evaluate((el) => {
			const ink = (node: Element | null) => (node ? getComputedStyle(node).color : "");
			return {
				day: ink(el.firstElementChild),
				name: ink(el.querySelector("li > span:nth-child(2)")),
				cost: ink(el.querySelector("li > span:nth-child(3)")),
				swatches: [...el.querySelectorAll("li > span:first-child")].map((s) => getComputedStyle(s).backgroundColor),
			};
		});
		expect(tooltipInk.day).toBe(rgb(colour(tokens, "fg")));
		expect(tooltipInk.name).toBe(rgb(colour(tokens, "muted")));
		expect(tooltipInk.cost).toBe(rgb(colour(tokens, "fg")));
		expect(tooltipInk.swatches.reverse()).toEqual(series);
		bad.push(...(await lowContrast(page, "tooltip")));
		expect(bad, `${id} ${mode}`).toEqual([]);
	});
}

test("the models beyond the eight colours add up under Other in the table too, and the totals still add up", async ({
	page,
}) => {
	await showChart(page);
	const table = page.getByTestId("daily-table");
	await expect(table.locator("thead th")).toHaveText(["Day (UTC)", ...NAMES.slice(0, 7), "Other", "Total"]);
	// Day one: models 7, 8 and 9 cost 3 + 2 + 1 cents; the day's total is every model's.
	const lastRow = table.locator("tbody tr").last();
	await expect(lastRow.locator("td").nth(8)).toHaveText("$0.06");
	const total = Number(await table.locator("[data-day-total]").last().getAttribute("data-cost"));
	expect(total).toBeCloseTo(0.55, 6);
});

test("the bars are drawn in place: nothing grows in after the page shows", async ({ page }) => {
	await showChart(page);
	const bar = page.locator('[data-testid="daily-chart"] .recharts-bar-rectangle path').first();
	const first = await bar.getAttribute("d");
	await page.waitForTimeout(1000);
	expect(await bar.getAttribute("d")).toBe(first);
});

/**
 * However few days there are, a bar is a column, not a wall: one day used to fill the plot with a single bar about 780px
 * wide (a new account passes through that on its first day). A history under a week is drawn on a week's axis, its days at
 * the right, where "today" is.
 */
for (const days of [1, 2, 30]) {
	test(`${days} day${days === 1 ? "" : "s"} of data: no bar is wider than 56px`, async ({ page }) => {
		const costSeries = Array.from({ length: days }, (_, d) => ({
			timestamp: Date.UTC(2026, 0, 1 + d, 12),
			model: "acme/model-0",
			cost: 0.1 + d * 0.001,
		}));
		await page.route(/\/api\/stats(\?|$)/, (route) =>
			route.fulfill({ json: { overall: bucket, byModel: [], byFolder: [], costSeries } }),
		);
		await page.goto("/#/usage");
		const chart = page.getByTestId("daily-chart");
		await expect(chart).toBeVisible();
		await expect(chart.locator(".recharts-bar-rectangle path").first()).toBeAttached();
		const bars = await chart
			.locator(".recharts-bar-rectangle path")
			.evaluateAll((paths) => paths.map((p) => p.getBoundingClientRect()));
		expect(bars).toHaveLength(days);
		for (const bar of bars) expect(bar.width, "px width of a bar").toBeLessThanOrEqual(56.5);
		if (days >= 7) return;

		// Fewer than a week: the axis still has seven days, and the real ones are the last.
		await expect(chart.locator(".recharts-xAxis .recharts-cartesian-axis-tick")).toHaveCount(7);
		const plot = await chart.locator(".recharts-cartesian-grid").boundingBox();
		expect(plot).toBeTruthy();
		if (!plot) return;
		for (const bar of bars)
			expect(bar.x, "the day is at the right of the plot").toBeGreaterThan(plot.x + plot.width * 0.6);
		// The table below lists the days there are, not the empty ones.
		await expect(page.getByTestId("daily-table").locator("tbody tr")).toHaveCount(days);
	});
}
