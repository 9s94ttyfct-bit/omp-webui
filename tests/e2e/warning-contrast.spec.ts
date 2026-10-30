import { PALETTES } from "../../shared/prefs.ts";
import { contrastOf } from "../support/style.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A control drawn in the warning tint (the guard picker while the guard is off, the permission picker on a risky mode,
 * a quota running low) stays readable under the pointer (WCAG AA, 4.5:1) in every palette, light and dark. A hover
 * that deepened the tint from 15% to 25% put the warning text at 4.3–4.5:1 in several looks. The look is switched on
 * the page itself (palettes are scoped by `data-palette` and the `dark` class); no model call.
 */

test("the guard picker, off and under the pointer, is at least 4.5:1 in every palette and mode", async ({ page }) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	const picker = page.getByTestId("guard-picker");
	await expect(picker).toContainText("Off", { timeout: 60_000 });
	// No transition: the colours read are the ones the hover ends at.
	await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important}" });
	await picker.hover();
	const label = picker.getByText(/Off/);
	const low: string[] = [];
	for (const palette of PALETTES) {
		for (const dark of [false, true]) {
			await page.evaluate(
				([id, on]) => {
					document.documentElement.dataset.palette = id as string;
					document.documentElement.classList.toggle("dark", on as boolean);
				},
				[palette, dark],
			);
			const ratio = await contrastOf(label, "color");
			if (ratio < 4.5) low.push(`${palette} ${dark ? "dark" : "light"}: ${ratio.toFixed(2)}`);
		}
	}
	expect(low).toEqual([]);
});
