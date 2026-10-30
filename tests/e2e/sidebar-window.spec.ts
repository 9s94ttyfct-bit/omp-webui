import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_CWD } from "../support/fixtures.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * A library of hundreds of conversations: the sidebar draws only the rows in view (and a few around them), and still
 * behaves as one whole list — keyboard navigation reaches every row, the row with focus keeps it when it is scrolled
 * away, filtering and selecting act on all rows (no model call).
 */

const COUNT = 400;
/**
 * The sidebar lists by modification time, and the worker's server is shared with the spec files that ran before this one in
 * it: their conversations (`writeSimpleSession` dates one `n` seconds ahead, and `guard.spec.ts` uses n beyond 1700) are
 * still in the list. These are dated further ahead than any of them, so "the highest number is the newest" holds whichever
 * files ran before (the list was headed by "Guard other 2" when guard.spec.ts ran first in the worker).
 */
const AHEAD = 100_000;
let dir: string;
const title = (n: number) => `Windowed ${String(n).padStart(3, "0")}`;

test.beforeAll(() => {
	dir = join(process.env.OMPW_E2E_AGENT_DIR as string, "sessions", "--ompw-window--");
	mkdirSync(dir, { recursive: true });
	const now = Date.now() / 1000;
	for (let n = 1; n <= COUNT; n++) {
		const id = `01a00000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
		const stamp = new Date(Date.UTC(2026, 0, 7, 0, 0, n)).toISOString();
		const lines = [
			{ type: "session", version: 3, id, timestamp: stamp, cwd: FIXTURE_CWD },
			{ type: "title_change", id: `t${n}`, parentId: null, timestamp: stamp, title: title(n) },
			{
				type: "message",
				id: `u${n}`,
				parentId: null,
				timestamp: stamp,
				message: { role: "user", content: [{ type: "text", text: `question ${n}` }] },
			},
			{
				type: "message",
				id: `a${n}`,
				parentId: `u${n}`,
				timestamp: stamp,
				message: { role: "assistant", content: [{ type: "text", text: `answer ${n}` }] },
			},
		];
		const file = join(dir, `2026-01-07T00-00-${String(n % 60).padStart(2, "0")}-000Z_${id}.jsonl`);
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		// The highest number is the newest.
		utimesSync(file, now + AHEAD + n, now + AHEAD + n);
	}
});
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

const list = (page: Page) => page.getByTestId("session-list");
const rows = (page: Page) => list(page).getByTestId("session-item");
const scrollTo = (page: Page, top: number) =>
	list(page).evaluate((el, y) => {
		el.scrollTop = y;
	}, top);
const focusedLabel = (page: Page) => page.evaluate(() => document.activeElement?.textContent ?? "");

async function openSidebar(page: Page) {
	await page.goto("/");
	await expect(rows(page).first()).toContainText(title(COUNT), { timeout: 30_000 });
}

test("only the rows in view are in the page, and scrolling brings the others", async ({ page }) => {
	await openSidebar(page);
	expect(await rows(page).count()).toBeLessThan(80);
	await expect(list(page).getByText("Today", { exact: true })).toBeVisible();

	// The whole list is there to scroll through: its height is that of every row.
	expect(await list(page).evaluate((el) => el.scrollHeight)).toBeGreaterThan(COUNT * 28);
	await scrollTo(page, 200 * 32);
	await expect(rows(page).first()).not.toContainText(title(COUNT));
	await expect(
		list(page)
			.getByText(title(COUNT - 200), { exact: false })
			.first(),
	).toBeAttached();
	expect(await rows(page).count()).toBeLessThan(80);
	await scrollTo(page, 0);
	await expect(rows(page).first()).toContainText(title(COUNT));
});

test("the keyboard reaches every row: arrows, Home, End and Tab", async ({ page }) => {
	await openSidebar(page);
	await rows(page).first().focus();
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	expect(await focusedLabel(page)).toContain(title(COUNT - 2));
	await page.keyboard.press("ArrowUp");
	expect(await focusedLabel(page)).toContain(title(COUNT - 1));

	// Tab goes from the row to its menu button, then to the next row.
	await page.keyboard.press("Tab");
	await expect(page.locator(":focus")).toHaveAttribute("data-testid", "session-menu");
	await page.keyboard.press("Tab");
	await expect(page.locator(":focus")).toHaveAttribute("data-testid", "session-item");
	expect(await focusedLabel(page)).toContain(title(COUNT - 2));
	await page.keyboard.press("Shift+Tab");
	await expect(page.locator(":focus")).toHaveAttribute("data-testid", "session-menu");

	// End goes to the last row of the whole list, which was not in the page.
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("End");
	await expect(page.locator(":focus")).toHaveAttribute("data-testid", "session-item");
	expect(await list(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(COUNT * 20);
	await page.keyboard.press("Home");
	await expect(rows(page).first()).toBeFocused();
	await expect(rows(page).first()).toContainText(title(COUNT));
});

test("Tab past the last row in the page goes on to the next row of the list", async ({ page }) => {
	await openSidebar(page);
	// Walk down with Tab (row, menu, row, ...) until the row that was last in the page has been passed several times over.
	await rows(page).first().focus();
	const seen = new Set<string>();
	for (let i = 0; i < 200; i++) {
		seen.add((await focusedLabel(page)).trim());
		await page.keyboard.press("Tab");
	}
	// 100 rows were passed: well beyond the few dozen the page holds at any moment.
	expect(seen.size).toBeGreaterThan(90);
	expect(await rows(page).count()).toBeLessThan(80);
});

test("a row with focus keeps it when the list is scrolled far away", async ({ page }) => {
	await openSidebar(page);
	const row: Locator = rows(page).nth(3);
	await row.focus();
	const label = (await row.textContent()) ?? "";
	await scrollTo(page, 300 * 32);
	await expect(rows(page).filter({ hasText: label.trim() })).toHaveCount(1);
	await expect(rows(page).filter({ hasText: label.trim() })).toBeFocused();
});

test("the filter and selection act on every row, drawn or not", async ({ page }) => {
	await openSidebar(page);
	await page.getByTestId("session-filter").fill("Windowed 123");
	await expect(rows(page)).toHaveCount(1);
	await expect(rows(page).first()).toContainText(title(123));
	await page.getByTestId("session-filter").fill("");
	await expect(rows(page).first()).toContainText(title(COUNT));

	await page.getByTestId("select-sessions").click();
	await page.getByTestId("selection-bar").getByRole("button", { name: "Select all", exact: true }).click();
	const count = await page.getByTestId("selection-count").textContent();
	expect(Number(/\d+/.exec(count ?? "")?.[0])).toBeGreaterThanOrEqual(COUNT);
});
