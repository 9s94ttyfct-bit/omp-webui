import { FIXTURE } from "../support/fixtures.ts";
import { sessionRow } from "../support/live.ts";
import { appendTaskTurn } from "../support/subagent-assignment-fixtures.ts";
import { sessionWithSubagents } from "../support/subagent-fixtures.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * The type scale is three steps and no others: caption 12px (the floor), body 14px and title 15px. The same role
 * used to get a different size by screen — the Usage table headers were 11px over 14px cells while the Info tab's
 * key/value rows were 12px, the popover descriptions 11px under 12px titles, the key caps 10px with the modifier
 * glyphs drawn at half the height of the letters beside them.
 *
 * Read from what the browser computes, on the surfaces where the sizes differed: the popover of the permission
 * mode, the Usage table's headers, the sidebar's version line, the key caps of the shortcuts dialog and the
 * conversation's own caption. No model call.
 */

/** The computed size of what is on the page, in pixels. */
const sizeOf = (el: Locator) =>
	el.evaluate((e) => {
		const s = getComputedStyle(e);
		return { px: Number.parseFloat(s.fontSize), family: s.fontFamily };
	});

/** Every element under a root that draws text, with the size the browser gives it. */
const sizesUnder = (root: Locator) =>
	root.locator("*").evaluateAll((els) =>
		els
			.filter((e) => (e.textContent ?? "").trim() !== "" && e.children.length === 0)
			.map((e) => {
				const s = getComputedStyle(e);
				return { px: Number.parseFloat(s.fontSize), text: e.textContent?.trim().slice(0, 40) ?? "" };
			}),
	);

/** The smallest size any text under a root is drawn at. */
const smallestUnder = async (root: Locator) => {
	const sizes = await sizesUnder(root);
	return sizes.length ? Math.min(...sizes.map((s) => s.px)) : Number.POSITIVE_INFINITY;
};

/** The call of a subagent, and the frame that carries a subagent's task. */
const CALL = "call_assignment";

/** The task card of the call. */
const card = (page: Page) => page.locator('[data-testid="tool-card"][data-tool="task"]');

/** Open the card whether or not it is open already (a card whose call runs may open by itself). */
async function openCard(c: Locator): Promise<void> {
	const header = c.locator("button[aria-expanded]").first();
	if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
	await expect(header).toHaveAttribute("aria-expanded", "true");
}

test("nothing on the page is drawn below the 12px caption", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByTestId("composer")).toBeVisible();

	// The sidebar: its headings, the version line and the filter's own label.
	const sidebar = page.getByRole("complementary");
	expect(await smallestUnder(sidebar), "the sidebar").toBeGreaterThanOrEqual(12);

	// A conversation: the caption under the title (the folder's path) is the smallest type of the header.
	await sessionRow(page, FIXTURE.alphaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
	const cwd = page.getByTestId("chat-cwd");
	await expect(cwd).toBeVisible();
	expect((await sizeOf(cwd)).px, "the size of the folder's path").toBeGreaterThanOrEqual(12);
});

test("the permission mode's popover: its title and its description are the same caption", async ({ page }) => {
	await page.goto("/");
	const picker = page.getByTestId("approval-picker");
	await expect(picker).toBeVisible({ timeout: 60_000 });
	await picker.click();
	const menu = page.getByTestId("approval-menu");
	await expect(menu).toBeVisible();

	// The menu's own label (the caption) and the description of one of its items.
	const sizes = await sizesUnder(menu);
	expect(sizes.length, "the menu has text").toBeGreaterThan(0);
	for (const size of sizes) expect(size.px, `the size of "${size.text}"`).toBeGreaterThanOrEqual(12);
});

test("the Usage table's headers are the caption, like the cells under them", async ({ page }) => {
	await page.route(/\/api\/stats(\?|$)/, (route) =>
		route.fulfill({
			json: {
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
					totalCost: 0.42,
					avgDuration: 1500,
					avgTtft: 400,
					avgTokensPerSecond: 60,
					firstTimestamp: Date.UTC(2026, 0, 5),
					lastTimestamp: Date.UTC(2026, 0, 6),
				},
				byModel: [
					{
						provider: "anthropic",
						model: "claude-haiku-5-5",
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
					},
				],
				byFolder: [],
				byAgentType: [],
				costSeries: [],
			},
		}),
	);
	await page.goto("/#/usage");
	const table = page.getByTestId("table-By model");
	await expect(table).toBeVisible();

	// The header is the caption (12px), the cells under it the body (14px): the header is never the smaller of the two.
	const header = await sizeOf(table.locator("thead th").first());
	const cell = await sizeOf(table.locator("tbody td").first());
	expect(header.px, "the size of a table header").toBe(12);
	expect(cell.px, "the size of a table cell").toBe(14);
});

test("the key caps of the shortcuts page are the caption, and their modifier glyphs are not in the code face", async ({
	page,
}) => {
	// The symbols are what an Apple platform writes (⌘⇧O; elsewhere Ctrl+Shift+O, with none to look at), so the page is
	// told it is on a Mac, as `shortcut-hints.spec.ts` does: the faces are then those of the machine the test runs on.
	await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }));
	await page.goto("/");
	await page.locator("body").click({ position: { x: 600, y: 10 } });
	await page.keyboard.press("?");
	const list = page.getByTestId("shortcuts");
	await expect(list).toBeVisible();

	// Every key cap is the caption: 12px, and never the 10px the caps used to be.
	const caps = list.locator("kbd");
	expect(await caps.count(), "the key caps").toBeGreaterThan(0);
	for (const cap of await caps.all()) expect((await sizeOf(cap)).px, "the size of a key cap").toBe(12);

	// The modifier symbols (⌘, ⇧, ↵) are drawn in the UI face: in the code face they sit at about half the height of
	// the letters beside them, so a cap read as a small sign next to a letter.
	const modifiers = list.locator("kbd span.font-sans");
	expect(await modifiers.count(), "the modifier glyphs").toBeGreaterThan(0);
	for (const modifier of await modifiers.all()) {
		const { family } = await sizeOf(modifier);
		expect(family, "the face of a modifier glyph").not.toMatch(/mono/i);
	}
});

/**
 * A subagent's assignment is Markdown in the compact prose, whose sizes are relative to its base: on a 12px base the
 * inline code came out at 10.56px and the tables at 11.04px, under the floor. A task text is full of paths and
 * commands, so its code has to be readable.
 */
test("a subagent's assignment: its inline code and its tables are the caption too", async ({ page }) => {
	const own = sessionWithSubagents(0xb1, "Type scale assignment", {});
	appendTaskTurn(own, 0xb1, CALL);
	await page.goto("/");
	await sessionRow(page, "Type scale assignment").click();
	await expect(card(page)).toHaveCount(1);
	await openCard(card(page));

	// The assignment of the first subagent: its own task, in the compact prose. Each subagent of the call opens to it.
	const item = card(page).getByTestId("task-item").first();
	await expect(item).toBeVisible();
	await item.locator("button").click();

	const body = card(page).getByTestId("assignment-body").first();
	await expect(body).toBeVisible();
	await expect(body.locator("code").first(), "the task's inline code").toBeVisible();
	await expect(body.locator("table").first(), "the task's table").toBeVisible();

	const sizes = await sizesUnder(body);
	expect(sizes.length, "text in the assignment").toBeGreaterThan(0);
	for (const size of sizes) expect(size.px, `the size of "${size.text}"`).toBeGreaterThanOrEqual(12);
});
