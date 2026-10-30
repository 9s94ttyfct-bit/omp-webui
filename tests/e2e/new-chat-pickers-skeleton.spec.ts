import { expect, type Page, test } from "./fixtures.ts";

/**
 * The pickers in New chat's composer footer (preset, model, thinking level, permission mode, guard) are a chunk of their
 * own, fetched when the warm-up process starts. Until it lands the footer held nothing, so the row of controls appeared
 * and the composer's field and the page around it shifted by that row — on the widths where the row wraps onto a second
 * line, by 36 px. The placeholder is a bar where each control will be, at its width, in the footer's own flex, so it wraps
 * exactly when the controls do (`display: contents`: the bars are the footer's children, not a row of their own).
 *
 * The widths swept are where the row goes from one line to two and back (measured: 600–740 px of viewport at this
 * composer's width, and 920–1020), in both languages: `zh`'s controls are a few pixels wider, which moves that band.
 */

const PICKERS_CHUNK = /\/assets\/NewChatPickers-[^/]+\.js$/;

/** The viewports where the footer's row is one line, two, and one again (the band is entered and left). */
const WIDTHS = [600, 700, 920, 1020, 1400];

/** The composer footer's box and the message field's: neither may move when the chunk lands. */
async function boxes(page: Page) {
	const footer = await page.getByTestId("composer-footer").boundingBox();
	const field = await page.getByTestId("composer").boundingBox();
	if (!footer || !field) throw new Error("the composer or its footer is not on screen");
	return { footer, field };
}

for (const lang of ["en", "zh-CN"]) {
	test(`while the pickers' chunk is on its way the footer keeps its height and the field its place (${lang})`, async ({
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

			// The placeholder: nothing to read or tab to, and the footer is as tall as the controls will make it.
			const skeleton = page.getByTestId("pickers-skeleton");
			await expect(skeleton).toBeVisible({ timeout: 60_000 });
			await expect(skeleton).toHaveAttribute("aria-hidden", "true");
			const before = await boxes(page);
			// The bars are 32 px tall wherever they are: one row, or two when the footer is too narrow for them.
			expect([32, 68]).toContain(before.footer.height);

			// The controls land: the placeholder goes, and neither the footer nor the field moved.
			gate.resolve();
			await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
			// The guidance control (#641) is a chunk of its own inside the pickers': the row is whole once it is there too.
			await expect(page.getByTestId("guidance-picker")).toBeVisible({ timeout: 60_000 });
			await expect(skeleton).toHaveCount(0);
			const after = await boxes(page);
			expect({ width, footer: after.footer.height, field: Math.round(after.field.y) }).toEqual({
				width,
				footer: before.footer.height,
				field: Math.round(before.field.y),
			});
		}
		open.resolve();
	});
}

test("the placeholder is not in the page's text: nothing announces it, and no translation key is shown for it", async ({
	page,
}) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	// Once the controls are there the placeholder is gone; what remains is the controls' own words.
	await expect(page.getByTestId("pickers-skeleton")).toHaveCount(0);
	await expect(page.getByTestId("composer-footer")).not.toContainText("pickers.");
});
