import { FIXTURE } from "../support/fixtures.ts";
import { boxOf, viewportOf } from "../support/geometry.ts";
import { openSidebar, sessionRow } from "../support/live.ts";
import { topTab } from "../support/panel.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * The chat's side panel (no model call): its Close button is always on screen and each pane's tabs share one line.
 * Below `lg` it is a sheet over the conversation: a tap beside it or Escape closes it, and it stays behind when
 * you open another conversation. Beside the conversation (wide windows) it is a column that stays open.
 */

async function openChat(page: Page, title: string) {
	await page.goto("/");
	await openSidebar(page);
	await sessionRow(page, title).click();
	await expect(page.getByTestId("chat-title")).toHaveText(title);
}

/**
 * Close is inside the window; in every pane the tabs are on the row's single line, none of them is hidden behind its scroll,
 * and each pane lists the tabs it is given (a tab is in one row only: six above and five below by default, all eleven in a
 * sheet's one).
 */
async function expectReachable(page: Page, panel: Locator, panes: Partial<Record<"top" | "bottom", number>>) {
	const { width } = viewportOf(page);
	const close = await boxOf(panel.getByTestId("right-panel-close"));
	expect(close.x).toBeGreaterThanOrEqual(0);
	expect(close.x + close.width).toBeLessThanOrEqual(width);

	for (const [which, count] of Object.entries(panes) as ["top" | "bottom", number][]) {
		const pane = panel.getByTestId(`panel-pane-${which}`);
		const tabs = pane.getByRole("tab");
		await expect(tabs).toHaveCount(count);
		const boxes = await tabs.evaluateAll((els) =>
			els.map((el) => {
				const r = el.getBoundingClientRect();
				return { top: Math.round(r.top), height: r.height, right: r.right };
			}),
		);
		// Each row ends with its own buttons: the fold button (a sheet has none: Close is its last button).
		const fold = pane.getByTestId(`pane-fold-${which}`);
		const stop = (await fold.count()) ? (await boxOf(fold)).x : close.x;
		expect(new Set(boxes.map((b) => b.top)).size, `tabs of the ${which} pane share one line`).toBe(1);
		for (const b of boxes) {
			expect(b.height, "a tab's label does not wrap").toBeLessThan(34);
			expect(b.right, "tabs end before the row's buttons").toBeLessThanOrEqual(stop);
		}
		const strip = pane.getByRole("tablist");
		expect(
			await strip.evaluate((el) => el.scrollWidth <= el.clientWidth),
			"no tab sits behind the strip's scroll",
		).toBe(true);
	}
}

test.describe("beside the conversation (1400 px)", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("Close is inside the window, the tabs share one line, and the panel has no backdrop", async ({ page }) => {
		await openChat(page, FIXTURE.gammaTitle);
		await page.getByTestId("toggle-panel").click();
		const panel = page.getByTestId("right-panel");
		await expect(panel).toBeVisible();
		await expectReachable(page, panel, { top: 7, bottom: 6 });
		await expect(page.getByTestId("right-panel-backdrop")).toHaveCount(0);
		// At the default width the tabs that are not shown are icons (with their counts) so that seven tabs and the pane's buttons
		// fit one line: each still has a name for a screen reader and a tooltip.
		await expect(topTab(panel, /^Agents/).getByText(/^Agents$/)).toBeVisible();
		for (const which of ["top", "bottom"] as const) {
			for (const tab of await panel.getByTestId(`panel-pane-${which}`).getByRole("tab").all()) {
				await expect(tab).toHaveAccessibleName(/\S/);
				await expect(tab).toHaveAttribute("title", /\S/);
			}
		}
	});

	test("with room for them every tab of both panes shows its label", async ({ page }) => {
		// The panel's widest width (`LIMITS.panel.max`): the labels do not fit in less. The window must leave the sidebar
		// and the conversation's own least width beside it, so it is wide.
		await page.setViewportSize({ width: 1700, height: 900 });
		await page.addInitScript(() => localStorage.setItem("ompw.panelWidth", "720"));
		await openChat(page, FIXTURE.gammaTitle);
		await page.getByTestId("toggle-panel").click();
		const panel = page.getByTestId("right-panel");
		await expect(panel).toBeVisible();
		expect(Math.round((await boxOf(panel)).width)).toBe(720);
		await expectReachable(page, panel, { top: 7, bottom: 6 });
		for (const [which, tabs] of [
			[
				"top",
				[
					[/^Agents/, /^Agents$/],
					[/^Todos/, /^Todos$/],
					[/^Jobs/, /^Jobs$/],
					[/^Branches$/, /^Branches$/],
					[/^Info$/, /^Info$/],
					[/^Guidance$/, /^Guidance$/],
					[/^Questions$/, /^Questions$/],
				],
			],
			[
				"bottom",
				[
					[/^Files$/, /^Files$/],
					[/^Issues$/, /^Issues$/],
					[/^Ask$/, /^Ask$/],
					[/^Host$/, /^Host$/],
					[/^Terminal$/, /^Terminal$/],
					[/^Worktrees$/, /^Worktrees$/],
				],
			],
		] as const) {
			const pane = panel.getByTestId(`panel-pane-${which}`);
			for (const [tab, label] of tabs) {
				await expect(pane.getByRole("tab", { name: tab }).getByText(label)).toBeVisible();
			}
		}

		await panel.getByTestId("right-panel-close").click();
		await expect(panel).toHaveCount(0);
	});

	test("Escape does not close it (that key stops a running turn), and it stays open in the next conversation", async ({
		page,
	}) => {
		await openChat(page, FIXTURE.gammaTitle);
		await page.getByTestId("toggle-panel").click();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("right-panel")).toBeVisible();

		await sessionRow(page, FIXTURE.alphaTitle).click();
		await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
		await expect(page.getByTestId("right-panel")).toBeVisible();
	});
});

test.describe("a sheet over the conversation (phone)", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("Close is inside the screen, the tabs share one line and scroll to the last, and a tap beside the sheet closes it", async ({
		page,
	}) => {
		await openChat(page, FIXTURE.gammaTitle);
		await page.getByTestId("toggle-panel").click();
		const panel = page.getByTestId("right-panel");
		await expect(panel).toBeVisible();
		const close = await boxOf(panel.getByTestId("right-panel-close"));
		expect(close.x + close.width).toBeLessThanOrEqual(390);
		// Thirteen labelled tabs are wider than a phone's sheet, so its one row of tabs scrolls sideways: every tab stays
		// on one line with its name (P1: none shrinks to a bare icon), and the last is brought into view before Close.
		const tabs = panel.getByRole("tab");
		await expect(tabs).toHaveCount(13);
		const tops = await tabs.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
		expect(new Set(tops).size, "the tabs share one line").toBe(1);
		await expect(panel.getByRole("tablist")).not.toHaveAttribute("data-compact");
		for (const text of await tabs.allInnerTexts()) expect(text.trim(), "every tab shows its name").not.toBe("");
		const last = tabs.last();
		await last.scrollIntoViewIfNeeded();
		const end = await boxOf(last);
		const strip = await boxOf(panel.getByRole("tablist"));
		expect(end.x + end.width, "the last tab, scrolled to, is inside the strip").toBeLessThanOrEqual(
			strip.x + strip.width,
		);
		expect(end.x + end.width / 2, "and Close does not cover it").toBeLessThan(close.x);
		// A click lands on the tab itself (Playwright checks nothing is over the point it clicks).
		await last.click();
		await expect(last).toHaveAttribute("aria-selected", "true");

		// The sheet leaves a strip of the conversation uncovered: that strip is the backdrop.
		const box = await boxOf(panel);
		expect(box.x).toBeGreaterThanOrEqual(40);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		const backdrop = page.getByTestId("right-panel-backdrop");
		await expect(backdrop).toBeVisible();
		await backdrop.click({ position: { x: 10, y: 400 } });
		await expect(panel).toHaveCount(0);
	});

	test("the Close button closes it", async ({ page }) => {
		await openChat(page, FIXTURE.gammaTitle);
		await page.getByTestId("toggle-panel").click();
		await page.getByTestId("right-panel-close").click();
		await expect(page.getByTestId("right-panel")).toHaveCount(0);
	});

	test("Escape closes it and focus goes back to the button that opened it", async ({ page }) => {
		await openChat(page, FIXTURE.gammaTitle);
		const toggle = page.getByTestId("toggle-panel");
		await toggle.focus();
		await page.keyboard.press("Enter");
		const panel = page.getByTestId("right-panel");
		await expect(panel).toBeVisible();
		// Focus moved into the sheet, so a keyboard user is not left behind it.
		await expect(panel).toBeFocused();

		await page.keyboard.press("Escape");
		await expect(panel).toHaveCount(0);
		await expect(toggle).toBeFocused();
	});

	test("it does not follow you into another conversation", async ({ page }) => {
		await openChat(page, FIXTURE.alphaTitle);
		await page.getByTestId("toggle-panel").click();
		const panel = page.getByTestId("right-panel");
		await topTab(panel, /^Branches$/).click();
		// Beta branched off alpha: opening it from the panel is a new conversation.
		await panel.getByTestId("branch-list").getByText(FIXTURE.betaTitle).click();
		await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.betaTitle);
		await expect(page.getByTestId("right-panel")).toHaveCount(0);
		await expect(page.getByTestId("right-panel-backdrop")).toHaveCount(0);
	});
});
