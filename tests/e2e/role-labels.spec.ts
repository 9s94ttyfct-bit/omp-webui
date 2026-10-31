import { en as shellEn } from "../../web/src/i18n/shell.ts";
import { zh as panelZh } from "../../web/src/i18n/zh-CN/panel.ts";
import { zh as shellZh } from "../../web/src/i18n/zh-CN/shell.ts";
import { panelEn } from "../support/i18n-en.ts";
import { appReady } from "../support/live.ts";
import { readOptions } from "../support/select.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Search hits and the thinking-level picker name things in the interface language: no `user:` or `low`
 * left over from omp's own words (the palette needs the fixture conversations; the picker a started omp, no model call).
 */

const languages = [
	{ locale: "en-US", panel: panelEn, shell: shellEn },
	{ locale: "zh-CN", panel: panelZh, shell: shellZh },
] as const;

/** The dictionary key of a level omp names: `xhigh` → `thinkingXhigh`. */
const levelKey = (level: string) => `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}` as keyof typeof panelEn;

for (const { locale, panel, shell } of languages) {
	test.describe(locale, () => {
		test.use({ locale });

		test("a message hit says who wrote it in the interface language", async ({ page }) => {
			await page.goto("/");
			await appReady(page);
			await page.keyboard.press("ControlOrMeta+k");
			await page.getByTestId("palette-input").fill("zebra");
			const hits = page.getByTestId("search-hit");
			await expect(hits.first()).toBeVisible();
			// The fixture's zebra prompt (user) and its answer (assistant) both match.
			await expect(hits.filter({ hasText: shell.paletteRoleUser })).not.toHaveCount(0);
			await expect(hits.filter({ hasText: shell.paletteRoleAssistant })).not.toHaveCount(0);
			await expect(hits.filter({ hasText: /\b(user|assistant):/ })).toHaveCount(0);
		});

		test("thinking levels are named, not shown as omp's raw ids", async ({ page }) => {
			await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
			await page.goto("/");
			const picker = page.getByTestId("thinking-picker");
			await expect(picker).toBeVisible({ timeout: 60_000 });
			await expect.poll(async () => (await readOptions(picker)).length).toBeGreaterThan(1);
			const shown = (await readOptions(picker)).map((o) => ({ id: o.value, label: o.text }));
			for (const { id, label } of shown) expect(label, `level ${id}`).toBe(panel[levelKey(id)]);
		});
	});
}
