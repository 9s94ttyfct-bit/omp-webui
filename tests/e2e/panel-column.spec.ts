import { FIXTURE } from "../support/fixtures.ts";
import { openSidebar, sessionRow } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The conversation column beside the sidebar and the side panel (no model call): from 1024 px, where the panel is
 * still a column, the conversation keeps a readable width and the composer's controls take at most two rows, and the
 * composer's empty field follows the width it has when the window changes.
 */

async function openChat(page: Page) {
	await page.goto("/");
	await openSidebar(page);
	await sessionRow(page, FIXTURE.gammaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.gammaTitle);
}

test.describe("at 1024 px with the sidebar and the panel open", () => {
	test.use({ viewport: { width: 1024, height: 768 } });

	test("the conversation keeps 480 px and the composer's controls take at most two rows, icons only", async ({
		page,
	}) => {
		await openChat(page);
		await page.getByTestId("toggle-panel").click();
		await expect(page.getByTestId("right-panel")).toBeVisible();
		const width = await page.getByTestId("transcript").evaluate((el) => el.clientWidth);
		expect(width, "a readable conversation beside the sidebar and the panel").toBeGreaterThanOrEqual(480);

		const chips = page.getByTestId("composer-footer").locator("> *");
		await expect(chips).not.toHaveCount(0);
		const tops = await chips.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
		expect(new Set(tops).size, "the controls wrap onto at most two rows").toBeLessThanOrEqual(2);

		// Under 440 px the controls keep their icons and their names: the model's name is a tooltip and the button's
		// accessible name, no longer a label.
		const model = page.getByTestId("model-picker");
		expect((await model.boundingBox())?.width, "an icon, not a labelled chip").toBeLessThanOrEqual(40);
		await expect(model).toHaveAttribute("title", /.+/);
		await expect(model).toHaveAccessibleName(/.+/);
		// The less used ones are behind "⋯" there (C1): it is an icon with a name too, and opens them with their words.
		const more = page.getByTestId("composer-more");
		await expect(more).toHaveAccessibleName("More controls");
		expect((await more.boundingBox())?.width, "an icon").toBeLessThanOrEqual(40);
		await expect(page.getByTestId("thinking-picker")).toBeHidden();
		await more.click();
		await expect(page.getByTestId("composer-more-panel").getByTestId("thinking-picker")).toHaveAccessibleName(
			"Thinking level",
		);
	});
});

test.describe("at 1400 px with the sidebar and the panel open", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("the composer's controls keep their labels", async ({ page }) => {
		await openChat(page);
		await page.getByTestId("toggle-panel").click();
		await expect(page.getByTestId("right-panel")).toBeVisible();
		const model = page.getByTestId("model-picker");
		expect((await model.boundingBox())?.width, "a labelled chip").toBeGreaterThan(80);
		await expect(page.getByTestId("approval-picker")).toContainText(/\S/);
	});
});

/** The composer's footer takes one line: its height is that of one control (32 px), not two rows' worth. */
const footerHeight = (page: Page) =>
	page.getByTestId("composer-footer").evaluate((el) => el.getBoundingClientRect().height);
const settled = (page: Page) =>
	page.evaluate(() => {
		const { promise, resolve } = Promise.withResolvers<void>();
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		return promise;
	});

test.describe("at 1280 px with the sidebar and the panel open", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("the composer's footer is one row: where its controls with their names do not fit, the rest are behind ⋯ (V17)", async ({
		page,
	}) => {
		await openChat(page);
		// The panel closed: the conversation has room, every control is in the row with its name.
		await expect(page.getByTestId("thinking-picker")).toBeVisible();
		await expect(page.getByTestId("composer-more")).toBeHidden();
		expect(await footerHeight(page), "one row").toBeLessThanOrEqual(40);
		expect((await page.getByTestId("model-picker").boundingBox())?.width, "a labelled chip").toBeGreaterThan(80);

		// The panel takes 400 px, and the footer's controls with their names filled two rows (before): now one, with ⋯.
		await page.getByTestId("toggle-panel").click();
		await expect(page.getByTestId("right-panel")).toBeVisible();
		await expect(page.getByTestId("composer-more")).toBeVisible();
		await expect(page.getByTestId("thinking-picker")).toBeHidden();
		expect(await footerHeight(page), "one row").toBeLessThanOrEqual(40);
		expect(
			(await page.getByTestId("model-picker").boundingBox())?.width,
			"an icon, not a labelled chip",
		).toBeLessThanOrEqual(40);
		await page.getByTestId("composer-more").click();
		await expect(page.getByTestId("composer-more-panel").getByTestId("thinking-picker")).toBeVisible();

		// Closing the panel gives the row its names back.
		await page.getByTestId("right-panel-close").click();
		await expect(page.getByTestId("composer-more")).toBeHidden();
		await expect(page.getByTestId("thinking-picker")).toBeVisible();
		expect(await footerHeight(page), "one row").toBeLessThanOrEqual(40);
	});

	test("as the window widens or narrows the footer changes once, never back and forth, and is one row at every width", async ({
		page,
	}) => {
		await openChat(page);
		await page.getByTestId("toggle-panel").click();
		await expect(page.getByTestId("right-panel")).toBeVisible();
		const sweep = async (widths: number[]) => {
			const narrow: boolean[] = [];
			for (const width of widths) {
				await page.setViewportSize({ width, height: 800 });
				await settled(page);
				expect(await footerHeight(page), `one row at ${width} px`).toBeLessThanOrEqual(40);
				narrow.push(
					await page.getByTestId("composer-footer").evaluate((el) => el.hasAttribute("data-composer-narrow")),
				);
			}
			return narrow;
		};
		const turns = (states: boolean[]) => states.filter((s, i) => i > 0 && s !== states[i - 1]).length;
		const widths = Array.from({ length: 41 }, (_, i) => 1100 + i * 10);
		const widening = await sweep(widths);
		expect(widening[0], "icons only at 1100 px").toBe(true);
		expect(widening.at(-1), "names at 1500 px").toBe(false);
		expect(turns(widening), `widening: ${widening.map(Number).join("")}`).toBe(1);
		const narrowing = await sweep(widths.toReversed());
		expect(turns(narrowing), `narrowing: ${narrowing.map(Number).join("")}`).toBe(1);
	});
});

test.describe("when the window narrows", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("an empty field grows to its placeholder, so no line of it is cut off", async ({ page }) => {
		await openChat(page);
		const field = page.getByTestId("composer");
		await expect(field).toHaveAttribute("placeholder", /.+/);
		// Wide, the placeholder is one line; the sidebar is put away so that narrowing opens no drawer over the page.
		await page.getByRole("button", { name: "Hide sidebar" }).click();
		await page.setViewportSize({ width: 320, height: 640 });
		const cutOff = () =>
			field.evaluate((el: HTMLTextAreaElement) => {
				const shown = el.clientHeight;
				const style = el.style.height;
				const value = el.value;
				// The height the placeholder needs: lay it out as the field's own text.
				el.style.height = "auto";
				el.value = el.placeholder;
				const needed = el.scrollHeight;
				el.value = value;
				el.style.height = style;
				return needed - shown;
			});
		await expect.poll(cutOff).toBeLessThanOrEqual(0);
	});
});
