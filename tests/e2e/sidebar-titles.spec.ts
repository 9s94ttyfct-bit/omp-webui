import { boxOf } from "../support/geometry.ts";
import { openSidebar, ownSession, sessionRow, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { devices, expect, type Page, test } from "./fixtures.ts";

/**
 * A conversation's name in the sidebar has the whole width of its row (no model call): its menu button takes none of
 * it. With a mouse the button shows over the end of the name while the row is hovered, has keyboard focus or is the open
 * conversation, and the name does not move; the live state after the name stays in sight. On a touch screen, where
 * nothing is hovered, every row's button is shown, after the name, and opens its menu.
 */

const LONG = "Heron ledger: a conversation whose name runs far past the end of any sidebar row it is drawn in";
const SHORT = "Heron short";
const LIVE = "Heron live: another conversation whose name runs far past the end of the row, with omp running";

/** A row's parts: the name's button, the row around it, the name itself, the actions over it and their menu button. */
function parts(page: Page, title: string) {
	const item = sessionRow(page, title);
	const row = item.locator("..");
	return {
		item,
		row,
		name: item.getByText(title, { exact: true }),
		actions: row.getByTestId("session-actions"),
		menu: row.getByTestId("session-menu"),
	};
}

/** The pointer away from the sidebar, over the empty conversation. */
async function pointerAway(page: Page) {
	await page.mouse.move(1000, 600);
}

test.describe("mouse", () => {
	test("a long name runs to the end of its row; the actions show on hover, focus and the open row", async ({
		page,
	}) => {
		ownSession(0x47, LONG);
		ownSession(0x48, SHORT);
		await page.goto("/");
		const long = parts(page, LONG);
		await expect(long.item).toHaveCount(1, { timeout: 15_000 });
		await pointerAway(page);

		// The name is cut at the end of the row (its padding), not where a button would start, and it is cut.
		const row = await boxOf(long.row);
		const name = await boxOf(long.name);
		const room = row.x + row.width - (name.x + name.width);
		test.info().annotations.push({ type: "name", description: `${name.width}px of a ${row.width}px row` });
		expect(room).toBeLessThanOrEqual(12);
		expect(await long.name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

		// At rest the actions are not seen.
		await expect(long.menu).toHaveCSS("opacity", "0");
		await expect(long.actions).toHaveCSS("opacity", "0");

		// Hovered: seen, over the end of the name, and neither the name nor the row moves.
		await long.item.hover();
		await expect(long.menu).toHaveCSS("opacity", "1");
		await expect(long.actions).toHaveCSS("opacity", "1");
		expect(await boxOf(long.name)).toEqual(name);
		expect((await boxOf(long.row)).height).toBe(row.height);
		const over = await boxOf(long.actions);
		expect(over.x).toBeLessThan(name.x + name.width);
		expect(over.x + over.width).toBeGreaterThanOrEqual(name.x + name.width - 1);
		await pointerAway(page);
		await expect(long.menu).toHaveCSS("opacity", "0");

		// Keyboard: focus on the row shows its actions, and Tab goes on to its menu button, named for the row.
		await long.item.focus();
		await expect(long.menu).toHaveCSS("opacity", "1");
		await page.keyboard.press("Tab");
		await expect(long.menu).toBeFocused();
		await expect(long.menu).toHaveAccessibleName(`Actions for ${LONG}`);
		await expect(long.menu).toHaveCSS("opacity", "1");
		await page.keyboard.press("Enter");
		await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("menu")).toHaveCount(0);
		await expect(long.menu).toBeFocused();
		// Focus that leaves the list takes them away again.
		await page.getByTestId("session-filter").focus();
		await expect(long.menu).toHaveCSS("opacity", "0");

		// The open conversation's actions are seen without a hover or focus; the other rows' are not.
		const short = parts(page, SHORT);
		await short.item.click();
		await expect(short.item).toHaveAttribute("aria-current", "page");
		await pointerAway(page);
		await page.getByTestId("session-filter").focus();
		await expect(short.menu).toHaveCSS("opacity", "1");
		await expect(short.actions).toHaveCSS("opacity", "1");
		await expect(long.menu).toHaveCSS("opacity", "0");
	});

	test("the live state after the name stays in sight next to the open row's actions", async ({ page }) => {
		ownSession(0x49, LIVE);
		// Auto-titling would send a prompt of its own when the command's turn ends.
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		const tap = await tapSocket(page);
		await page.goto("/");
		await startLive(page, tap, LIVE, "heron-live-probe");
		const live = parts(page, LIVE);
		const dot = live.item.getByRole("img", { name: "Open", exact: true });
		await expect(dot).toBeVisible({ timeout: 15_000 });
		await pointerAway(page);
		await expect(live.menu).toHaveCSS("opacity", "1");

		const marks = await boxOf(dot);
		const name = await boxOf(live.name);
		const over = await boxOf(live.actions);
		// The name stops before the dot, the actions cover the end of the name, and they stop before the dot too.
		expect(name.x + name.width).toBeLessThanOrEqual(marks.x);
		expect(over.x).toBeLessThan(name.x + name.width);
		expect(over.x + over.width).toBeLessThanOrEqual(marks.x);
	});
});

const { defaultBrowserType: _browser, ...pixel } = devices["Pixel 5"];

test.describe("touch screen", () => {
	test.use(pixel);

	test("every row's actions are in reach without a hover, after the name", async ({ page }) => {
		ownSession(0x47, LONG);
		await page.goto("/");
		expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
		await openSidebar(page);
		const long = parts(page, LONG);
		await expect(long.item).toHaveCount(1, { timeout: 15_000 });
		await expect(long.item).not.toHaveAttribute("aria-current", "page");
		await expect(long.menu).toHaveCSS("opacity", "1");
		const name = await boxOf(long.name);
		const menu = await boxOf(long.menu);
		expect(name.x + name.width).toBeLessThanOrEqual(menu.x);

		await long.menu.tap();
		await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("menu")).toHaveCount(0);
	});
});
