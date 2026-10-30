import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PALETTES } from "../../shared/prefs.ts";
import { makeWorld, realOmp } from "../support/fake-install.ts";
import { startTestServer } from "../support/server.ts";
import { contrastOf } from "../support/style.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The accent badge ("Recommended" on the install screen) is readable (WCAG AA, 4.5:1) in every palette, light and
 * dark (#297). It sits inside the selected install option, whose own fill is the accent tint: a tint of the accent
 * under a label in the accent was 3.5–4.4:1 in six of the ten looks. The server has no omp so that screen shows;
 * the look is switched on the page itself (palettes are scoped by `data-palette` and the `dark` class).
 */

test.skip(realOmp() === null, "needs an omp on this machine for the launcher to hand its commands to");

test("the 'Recommended' badge is at least 4.5:1 in all ten palette and mode combinations", async ({ page }) => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-world-"));
	const world = makeWorld(dir, { version: "18.12.1", installers: true });
	const server = await startTestServer(0, { PATH: world.path, OMP_BIN: "omp" });
	try {
		await page.goto(`${server.url}/?token=${server.accessToken}`);
		const badge = page.getByTestId("install-option-homebrew").getByText("Recommended");
		await expect(badge).toBeVisible();
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
				const ratio = await contrastOf(badge, "color");
				if (ratio < 4.5) low.push(`${palette} ${dark ? "dark" : "light"}: ${ratio.toFixed(2)}`);
			}
		}
		expect(low).toEqual([]);
	} finally {
		await server.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});
