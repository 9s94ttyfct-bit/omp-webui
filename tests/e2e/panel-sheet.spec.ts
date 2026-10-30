import { FIXTURE } from "../support/fixtures.ts";
import { boxOf } from "../support/geometry.ts";
import { openSidebar, sessionRow } from "../support/live.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * Below 1024 px the chat's side panel is a sheet laid over the page (no model call): the transcript keeps its width and
 * a tap beside the sheet closes it. From 1024 px it is a column beside the conversation, which gives up room for it.
 */

async function openChat(page: Page) {
	await page.goto("/");
	await openSidebar(page);
	await sessionRow(page, FIXTURE.gammaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.gammaTitle);
}

const widthOf = (el: Locator) => el.evaluate((node) => node.clientWidth);

for (const [width, height] of [
	[390, 844],
	[820, 768],
	[1023, 768],
] as const) {
	test.describe(`a sheet over the conversation (${width} px)`, () => {
		test.use({ viewport: { width, height } });

		test("the panel is laid over the page, the transcript keeps its width and the backdrop closes it", async ({
			page,
		}) => {
			await openChat(page);
			const transcript = page.getByTestId("transcript");
			const before = await widthOf(transcript);
			expect(before, "the conversation has room to start with").toBeGreaterThan(300);

			await page.getByTestId("toggle-panel").click();
			const panel = page.getByTestId("right-panel");
			await expect(panel).toBeVisible();
			expect(await panel.evaluate((el) => getComputedStyle(el).position), "a sheet floats above the page").toBe(
				"fixed",
			);
			expect(await widthOf(transcript), "the transcript is not squeezed beside it").toBe(before);
			const box = await boxOf(panel);
			expect(box.x + box.width, "the sheet is flush with the window's right edge").toBe(width);
			expect(box.height, "and runs the window's full height").toBe(height);

			await page.getByTestId("right-panel-backdrop").click({ position: { x: 4, y: 200 } });
			await expect(panel).toHaveCount(0);
			expect(await widthOf(transcript)).toBe(before);
		});
	});
}

test.describe("beside the conversation (1024 px)", () => {
	test.use({ viewport: { width: 1024, height: 768 } });

	test("the panel is a column with a drag handle that takes room from the conversation", async ({ page }) => {
		await openChat(page);
		const transcript = page.getByTestId("transcript");
		const before = await widthOf(transcript);
		await page.getByTestId("toggle-panel").click();
		const panel = page.getByTestId("right-panel");
		await expect(panel).toBeVisible();
		expect(await panel.evaluate((el) => getComputedStyle(el).position)).toBe("relative");
		await expect(page.getByTestId("resize-panel")).toBeVisible();
		expect(await widthOf(transcript), "the column took its room from the conversation").toBeLessThan(before);
		await expect(page.getByTestId("right-panel-backdrop")).toHaveCount(0);
	});
});
