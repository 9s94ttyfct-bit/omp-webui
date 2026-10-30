import { FIXTURE } from "../support/fixtures.ts";
import { boxOf } from "../support/geometry.ts";
import { sessionRow } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Where the sidebar is a column, putting it away leaves a 48px rail: the toggle, New chat, Search, Usage, Commands and
 * Settings are one click away without opening it again (no model call). A phone keeps its drawer and the floating toggle.
 */

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Conversations" });
const rail = (page: Page) => page.getByRole("navigation", { name: "Shortcuts of the hidden sidebar" });

async function openChatAndPutSidebarAway(page: Page) {
	await page.goto("/");
	await sessionRow(page, FIXTURE.gammaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.gammaTitle);
	await page.getByRole("button", { name: "Hide sidebar" }).click();
	await expect(sidebar(page)).toHaveCount(0);
}

test.describe("beside the page (1400 px)", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("a rail replaces the sidebar, and every entry point is one click away", async ({ page }) => {
		await openChatAndPutSidebarAway(page);
		await expect(rail(page)).toBeVisible();
		expect((await boxOf(rail(page))).width).toBe(48);

		await rail(page).getByRole("button", { name: "Settings", exact: true }).click();
		await expect(page.getByTestId("settings-page")).toBeVisible();
		await expect(rail(page).getByRole("button", { name: "Settings", exact: true })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await rail(page).getByRole("button", { name: "Usage & cost" }).click();
		await expect(page.getByTestId("usage-page")).toBeVisible();
		await rail(page).getByRole("button", { name: "Commands & terminal" }).click();
		await expect(page.getByTestId("cli-page")).toBeVisible();
		await rail(page)
			.getByRole("button", { name: /^Search/ })
			.click();
		await expect(page.getByTestId("palette-input")).toBeVisible();
		await page.keyboard.press("Escape");
		await rail(page).getByTestId("new-chat").click();
		await expect(page).toHaveURL(/#\/$/);
		await expect(page.getByTestId("chat-title")).toHaveCount(0);
		await expect(page.getByTestId("composer")).toBeVisible();

		// None of it opened the sidebar again.
		await expect(sidebar(page)).toHaveCount(0);
		await expect(rail(page)).toBeVisible();
	});

	test("the toggle brings the sidebar back in place of the rail", async ({ page }) => {
		await openChatAndPutSidebarAway(page);
		await rail(page).getByTestId("show-sidebar").click();
		await expect(sidebar(page)).toBeVisible();
		await expect(rail(page)).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
	});

	test("the rail comes first in the tab order, and its toggle is on the chat header's line", async ({ page }) => {
		await openChatAndPutSidebarAway(page);
		// The first thing in the page that can take focus: the rail's toggle, where the sidebar's own controls were.
		const first = await page.evaluate(() =>
			document
				.querySelector("button, a[href], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex='-1'])")
				?.getAttribute("data-testid"),
		);
		expect(first).toBe("show-sidebar");
		await rail(page).getByTestId("show-sidebar").focus();
		await page.keyboard.press("Tab");
		await expect(rail(page).getByRole("button", { name: "New chat" })).toBeFocused();

		const toggle = await boxOf(rail(page).getByTestId("show-sidebar"));
		const header = await boxOf(page.locator("header"));
		expect(Math.abs(toggle.y + toggle.height / 2 - (header.y + header.height / 2))).toBeLessThanOrEqual(1);
		// The header no longer leaves room for a floating toggle.
		expect(await page.locator("header").evaluate((el) => getComputedStyle(el).paddingLeft)).toBe("16px");
	});
});

test.describe("at 1024 px with the panel as wide as it goes", () => {
	test.use({ viewport: { width: 1024, height: 768 } });

	test("the conversation keeps 480px beside the rail and the panel", async ({ page }) => {
		await openChatAndPutSidebarAway(page);
		await page.getByTestId("toggle-panel").click();
		const grip = page.getByTestId("resize-panel");
		await grip.focus();
		await page.keyboard.press("End");
		const panel = await boxOf(page.getByTestId("right-panel"));
		expect(panel.width, "the panel took what the rail left").toBeGreaterThan(400);
		expect(await page.getByTestId("transcript").evaluate((el) => el.clientWidth)).toBeGreaterThanOrEqual(480);
	});
});

test.describe("on a phone (390 px)", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("there is no rail: the drawer's toggle floats over the page", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
		await expect(rail(page)).toHaveCount(0);
	});
});
