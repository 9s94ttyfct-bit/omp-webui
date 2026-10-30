import { FIXTURE } from "../support/fixtures.ts";
import { topTabs } from "../support/panel.ts";
import { expect, type Locator, test } from "./fixtures.ts";

/**
 * The side panel scrolls one thing at a time. Test browsers hide scrollbars, so what is checked is what decides
 * whether a real one (macOS with a mouse: always-visible bars) shows: an agent's view had a second scroller around
 * it that scrolled its header and steer box away, and the tab strip showed a bar because a global rule overrode
 * its `scrollbar-width: none`.
 */

const scrollsVertically = (l: Locator) => l.evaluate((el) => /auto|scroll/.test(getComputedStyle(el).overflowY));

test("an agent's view has one scroller, its transcript, and the tab strip shows no scrollbar", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("complementary").getByText(FIXTURE.gammaTitle).click();
	await page.getByTestId("toggle-panel").click();
	const panel = page.getByTestId("right-panel");
	await expect.poll(() => topTabs(panel).evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe("none");

	// The list scrolls by itself.
	const list = panel.getByTestId("subagent-list");
	await expect(list).toBeVisible();
	expect(await scrollsVertically(list)).toBe(true);

	// In one agent's view only the transcript scrolls: nothing between it and the panel does.
	await panel.locator(`[data-testid="subagent-item"][data-agent-id="${FIXTURE.subagentId}"]`).click();
	const scroller = panel.getByTestId("subagent-scroll");
	await expect(scroller).toBeVisible();
	const outer = await scroller.evaluate((start) => {
		const found: string[] = [];
		for (let el = start.parentElement; el && el.getAttribute("data-testid") !== "right-panel"; el = el.parentElement)
			if (/auto|scroll/.test(getComputedStyle(el).overflowY)) found.push(el.className);
		return found;
	});
	expect(outer).toEqual([]);
	expect(await scrollsVertically(scroller)).toBe(true);
	// It fills the space under the view's header.
	const [view, inner] = await Promise.all([panel.getByTestId("subagent-detail").boundingBox(), scroller.boundingBox()]);
	expect(Math.abs((view?.y ?? 0) + (view?.height ?? 0) - ((inner?.y ?? 0) + (inner?.height ?? 0)))).toBeLessThan(2);
});
