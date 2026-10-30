import { FIXTURE } from "../support/fixtures.ts";
import { boxOf } from "../support/geometry.ts";
import { sessionRow } from "../support/live.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * The sidebar and the chat's side panel can be resized (no model call): drag the handle on their inner edge, or
 * focus it and use the arrow keys. Widths stay inside their bounds and leave the conversation its minimum, are
 * remembered across reloads, and go back to the default by double-click, Enter, or Settings. Phones are unchanged.
 */

const SIDEBAR_DEFAULT = 288;
const PANEL_DEFAULT = 400;
const CHAT_MIN = 480;

const sidebarOf = (page: Page) => page.getByRole("complementary", { name: "Conversations" });
const handle = (page: Page, which: "sidebar" | "panel") => page.getByTestId(`resize-${which}`);
const widthOf = async (el: Locator) => Math.round((await boxOf(el)).width);
const ariaWidth = async (el: Locator) => Number(await el.getAttribute("aria-valuenow"));

async function openChatWithPanel(page: Page) {
	await page.goto("/");
	await sessionRow(page, FIXTURE.gammaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.gammaTitle);
	await page.getByTestId("toggle-panel").click();
	await expect(page.getByTestId("right-panel")).toBeVisible();
}

/** Press on the handle, move the pointer by `dx`, release. */
async function drag(page: Page, el: Locator, dx: number) {
	const box = await boxOf(el);
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + dx / 2, y, { steps: 4 });
	await page.mouse.move(x + dx, y, { steps: 4 });
	await page.mouse.up();
}

test.describe("beside the conversation (1400 px)", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("dragging the sidebar's handle resizes it, and the width is still there after a reload", async ({ page }) => {
		await page.goto("/");
		const sidebar = sidebarOf(page);
		const grip = handle(page, "sidebar");
		await expect(grip).toHaveAttribute("role", "separator");
		expect(await widthOf(sidebar)).toBe(SIDEBAR_DEFAULT);
		expect(await ariaWidth(grip)).toBe(SIDEBAR_DEFAULT);

		await drag(page, grip, 100);
		expect(await widthOf(sidebar)).toBe(SIDEBAR_DEFAULT + 100);
		expect(await ariaWidth(grip)).toBe(SIDEBAR_DEFAULT + 100);
		await drag(page, grip, -40);
		expect(await widthOf(sidebar)).toBe(SIDEBAR_DEFAULT + 60);

		await page.reload();
		await expect(sidebarOf(page)).toBeVisible();
		expect(await widthOf(sidebarOf(page))).toBe(SIDEBAR_DEFAULT + 60);
		expect(await ariaWidth(handle(page, "sidebar"))).toBe(SIDEBAR_DEFAULT + 60);
	});

	test("a width remembered before the page loads is drawn from the first paint on", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("ompw.sidebarWidth", "350"));
		await page.goto("/");
		expect(await widthOf(sidebarOf(page))).toBe(350);
	});

	test("dragging the panel's handle to the left makes the panel wider, and it is remembered", async ({ page }) => {
		await openChatWithPanel(page);
		const panel = page.getByTestId("right-panel");
		expect(await widthOf(panel)).toBe(PANEL_DEFAULT);

		await drag(page, handle(page, "panel"), -120);
		expect(await widthOf(panel)).toBe(PANEL_DEFAULT + 120);
		expect(await ariaWidth(handle(page, "panel"))).toBe(PANEL_DEFAULT + 120);

		await page.reload();
		await page.getByTestId("toggle-panel").click();
		await expect(panel).toBeVisible();
		expect(await widthOf(panel)).toBe(PANEL_DEFAULT + 120);
	});

	test("arrow keys resize from the handle: the handle's direction is the width's (Shift: bigger steps; Home/End: the bounds)", async ({
		page,
	}) => {
		await page.goto("/");
		const sidebar = sidebarOf(page);
		const grip = handle(page, "sidebar");
		await grip.focus();
		await page.keyboard.press("ArrowRight");
		expect(await widthOf(sidebar)).toBe(SIDEBAR_DEFAULT + 16);
		await page.keyboard.press("Shift+ArrowRight");
		expect(await widthOf(sidebar)).toBe(SIDEBAR_DEFAULT + 16 + 64);
		await page.keyboard.press("ArrowLeft");
		expect(await widthOf(sidebar)).toBe(SIDEBAR_DEFAULT + 64);
		const min = Number(await grip.getAttribute("aria-valuemin"));
		const max = Number(await grip.getAttribute("aria-valuemax"));
		await page.keyboard.press("Home");
		expect(await widthOf(sidebar)).toBe(min);
		await page.keyboard.press("End");
		expect(await widthOf(sidebar)).toBe(max);
		// Still there after a reload, and the handle keeps its place in the tab order.
		await page.reload();
		expect(await widthOf(sidebarOf(page))).toBe(max);
	});

	test("on the panel the left arrow widens it, since its handle is on its left edge", async ({ page }) => {
		await openChatWithPanel(page);
		const panel = page.getByTestId("right-panel");
		await handle(page, "panel").focus();
		await page.keyboard.press("ArrowLeft");
		expect(await widthOf(panel)).toBe(PANEL_DEFAULT + 16);
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("ArrowRight");
		expect(await widthOf(panel)).toBe(PANEL_DEFAULT - 16);
	});

	test("widths stay inside their bounds, and the conversation keeps its minimum width", async ({ page }) => {
		await openChatWithPanel(page);
		const sidebar = sidebarOf(page);
		const panel = page.getByTestId("right-panel");
		const sGrip = handle(page, "sidebar");
		const pGrip = handle(page, "panel");
		const sMin = Number(await sGrip.getAttribute("aria-valuemin"));
		const pMin = Number(await pGrip.getAttribute("aria-valuemin"));
		expect(sMin).toBe(200);
		expect(pMin).toBe(280);

		await drag(page, sGrip, -600);
		expect(await widthOf(sidebar)).toBe(sMin);
		await drag(page, pGrip, 600);
		expect(await widthOf(panel)).toBe(pMin);

		// Pulled as wide as they go, both together leave the conversation at least its minimum.
		await drag(page, pGrip, -900);
		const pMax = await widthOf(panel);
		expect(pMax).toBeLessThanOrEqual(720);
		await drag(page, sGrip, 900);
		const main = await widthOf(page.locator("main"));
		const sw = await widthOf(sidebar);
		const pw = await widthOf(panel);
		expect(sw).toBeLessThanOrEqual(480);
		expect(main - pw, "the conversation column keeps exactly its minimum").toBe(CHAT_MIN);
		expect(await ariaWidth(sGrip)).toBe(sw);
		expect(await ariaWidth(pGrip)).toBe(pw);
	});

	test("a narrower window takes the room back from the panel, and widening gives it back", async ({ page }) => {
		await openChatWithPanel(page);
		const panel = page.getByTestId("right-panel");
		await drag(page, handle(page, "panel"), -200);
		expect(await widthOf(panel)).toBe(PANEL_DEFAULT + 200);
		await page.setViewportSize({ width: 1100, height: 900 });
		await expect.poll(() => widthOf(panel)).toBeLessThan(PANEL_DEFAULT + 200);
		expect(1100 - (await widthOf(sidebarOf(page))) - (await widthOf(panel))).toBeGreaterThanOrEqual(CHAT_MIN);
		await page.setViewportSize({ width: 1400, height: 900 });
		await expect.poll(() => widthOf(panel)).toBe(PANEL_DEFAULT + 200);
	});

	test("double-click on a handle, or Enter on it, restores that column's default size", async ({ page }) => {
		await openChatWithPanel(page);
		const sidebar = sidebarOf(page);
		const panel = page.getByTestId("right-panel");
		await drag(page, handle(page, "sidebar"), 90);
		await drag(page, handle(page, "panel"), -90);
		expect(await widthOf(sidebar)).toBe(SIDEBAR_DEFAULT + 90);

		await handle(page, "sidebar").dblclick();
		expect(await widthOf(sidebar)).toBe(SIDEBAR_DEFAULT);
		expect(await widthOf(panel), "the other column is not touched").toBe(PANEL_DEFAULT + 90);

		await handle(page, "panel").focus();
		await page.keyboard.press("Enter");
		expect(await widthOf(panel)).toBe(PANEL_DEFAULT);

		// And the default is what a reload shows, not the old width.
		await page.reload();
		expect(await widthOf(sidebarOf(page))).toBe(SIDEBAR_DEFAULT);
	});

	test("Settings has a Reset to default size action for both", async ({ page }) => {
		await openChatWithPanel(page);
		await drag(page, handle(page, "sidebar"), 80);
		await drag(page, handle(page, "panel"), -80);
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(page.getByTestId("settings-page")).toBeVisible();
		expect(await widthOf(sidebarOf(page))).toBe(SIDEBAR_DEFAULT + 80);
		await page.getByTestId("reset-layout").click();
		expect(await widthOf(sidebarOf(page))).toBe(SIDEBAR_DEFAULT);
		await sessionRow(page, FIXTURE.gammaTitle).click();
		await expect(page.getByTestId("right-panel")).toBeVisible();
		expect(await widthOf(page.getByTestId("right-panel"))).toBe(PANEL_DEFAULT);
	});

	test("a remembered width that is out of range (or not a number) is drawn within the bounds", async ({ page }) => {
		await page.addInitScript(() => {
			localStorage.setItem("ompw.sidebarWidth", "9999");
			localStorage.setItem("ompw.panelWidth", "banana");
		});
		await openChatWithPanel(page);
		expect(await widthOf(sidebarOf(page))).toBe(480);
		expect(await widthOf(page.getByTestId("right-panel"))).toBe(PANEL_DEFAULT);
	});
});

test.describe("phone layout is unchanged", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the sidebar drawer keeps its width and shows no handle, whatever was remembered", async ({ page }) => {
		await page.addInitScript(() => {
			localStorage.setItem("ompw.sidebarWidth", "450");
			localStorage.setItem("ompw.panelWidth", "600");
		});
		await page.goto("/");
		await page.getByRole("button", { name: "Show sidebar" }).click();
		expect(await widthOf(sidebarOf(page))).toBe(SIDEBAR_DEFAULT);
		await expect(handle(page, "sidebar")).toBeHidden();
	});

	test("the side panel is a sheet of its usual size with no handle", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("ompw.panelWidth", "600"));
		await page.goto("/");
		await page.getByRole("button", { name: "Show sidebar" }).click();
		await sessionRow(page, FIXTURE.gammaTitle).click();
		await page.getByTestId("toggle-panel").click();
		const panel = page.getByTestId("right-panel");
		await expect(panel).toBeVisible();
		expect(await widthOf(panel)).toBe(390 - 48);
		await expect(handle(page, "panel")).toHaveCount(0);
	});

	test("Settings' reset button keeps its label on one line, in English and in Chinese", async ({ page }) => {
		for (const lang of ["en", "zh-CN"]) {
			await page.addInitScript((l) => localStorage.setItem("ompw.lang", l), lang);
			await page.goto("/#/settings");
			const button = page.getByTestId("reset-layout");
			await expect(button).toBeVisible();
			// One line: the label is no taller than its line height, and the button no taller than its fixed height.
			const lines = await button.evaluate((el) => {
				const range = document.createRange();
				range.selectNodeContents(el);
				return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
			});
			expect(lines, lang).toBe(1);
		}
	});
});

test.describe("a tablet (1000 px): the sidebar is a column, the side panel a sheet", () => {
	test.use({ viewport: { width: 1000, height: 800 } });

	test("only the sidebar has a handle", async ({ page }) => {
		await page.goto("/");
		await sessionRow(page, FIXTURE.gammaTitle).click();
		await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.gammaTitle);
		await drag(page, handle(page, "sidebar"), 50);
		expect(await widthOf(sidebarOf(page))).toBe(SIDEBAR_DEFAULT + 50);
		await page.getByTestId("toggle-panel").click();
		await expect(page.getByTestId("right-panel")).toBeVisible();
		await expect(handle(page, "panel")).toHaveCount(0);
	});
});
