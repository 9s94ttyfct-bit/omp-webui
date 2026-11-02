import { newChatIn } from "../support/new-chat.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The pickers in New chat's settings bar, under its composer (preset, model, thinking level, Full / Light, guard,
 * guidance, permission mode, unattended mode), are a chunk of their own, fetched when the warm-up process starts. Until
 * it lands the bar would hold nothing, so the row of controls would appear and the page around it, centred in the
 * window, would shift by that row. The placeholder is a bar where each control will be, at its width, in the settings
 * bar's own flex, so it wraps exactly when the controls do (`display: contents`: the bars are the settings bar's
 * children, not a row of their own).
 *
 * The widths swept go from a bar that wraps onto more than one line to one that holds them all, in both languages:
 * `zh`'s controls are a few pixels wider, which moves where it wraps.
 */

const PICKERS_CHUNK = /\/assets\/NewChatPickers-[^/]+\.js$/;

/** The viewports where the bar wraps and where it does not; 370 px: a narrow bar of icons on the edge of wrapping. */
const WIDTHS = [370, 600, 700, 920, 1020, 1400];

/** The settings bar's box and the message field's: neither may move when the chunk lands. */
async function boxes(page: Page) {
	const bar = await page.getByTestId("new-chat-settings").boundingBox();
	const field = await page.getByTestId("composer").boundingBox();
	if (!bar || !field) throw new Error("the composer or its settings bar is not on screen");
	return { bar, field };
}

for (const lang of ["en", "zh-CN"]) {
	test(`while the pickers' chunk is on its way the bar keeps its height and the field its place (${lang})`, async ({
		page,
	}) => {
		// One gate per width: the chunk is held until this test lets it go, so what is measured is the second in which
		// the warm-up process starts. The route is registered once, before the first load.
		let open = Promise.withResolvers<void>();
		await page.route(PICKERS_CHUNK, async (route) => {
			await open.promise;
			await route.continue();
		});
		await page.addInitScript((l) => localStorage.setItem("ompw.lang", l), lang);
		await page.goto("/");
		await page.evaluate((l) => localStorage.setItem("ompw.lang", l), lang);

		for (const width of WIDTHS) {
			const gate = Promise.withResolvers<void>();
			open = gate;
			await page.setViewportSize({ width, height: 900 });
			await page.goto("/");

			// The placeholder: nothing to read or tab to, and the bar is as tall as the controls will make it.
			const skeleton = page.getByTestId("pickers-skeleton");
			await expect(skeleton).toBeVisible({ timeout: 60_000 });
			await expect(skeleton).toHaveAttribute("aria-hidden", "true");
			const before = await boxes(page);
			// The bars are 32 px tall wherever they are: one row, or more (4 px apart) when the bar is too narrow for them.
			expect([32, 68, 104]).toContain(before.bar.height);

			// The controls land: the placeholder goes, and neither the bar nor the field moved.
			gate.resolve();
			await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
			// The guidance control (#641) is a chunk of its own inside the pickers': the row is whole once it is there too.
			await expect(page.getByTestId("guidance-picker")).toBeVisible({ timeout: 60_000 });
			await expect(skeleton).toHaveCount(0);
			const after = await boxes(page);
			expect({ width, bar: after.bar.height, field: Math.round(after.field.y) }).toEqual({
				width,
				bar: before.bar.height,
				field: Math.round(before.field.y),
			});
		}
		open.resolve();
	});
}

test("the placeholder is not in the page's text: nothing announces it, and no translation key is shown for it", async ({
	page,
}) => {
	await page.goto(newChatIn(process.env.OMPW_E2E_WORK as string));
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	// Once the controls are there the placeholder is gone; what remains is the controls' own words.
	await expect(page.getByTestId("pickers-skeleton")).toHaveCount(0);
	await expect(page.getByTestId("new-chat-settings")).not.toContainText("pickers.");
});
