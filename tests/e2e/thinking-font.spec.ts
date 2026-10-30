import { realpathSync } from "node:fs";
import { devices, expect, type Page, test, webkit } from "./fixtures.ts";

/**
 * The composer's thinking-level control is a native `<select>`, and a touch screen sets selects at 16px so that iOS does
 * not zoom into one that takes focus. That made the thinking level (and only it) larger than Presets, the model and the
 * permission mode beside it. It must be set like them (size, family, weight) on an iPad and an iPhone, and still be a
 * 16px field underneath. Measured in WebKit with Playwright's device descriptors; no model call.
 */

const SIZES = ["iPad Pro 11", "iPhone 15", "iPhone SE", "iPhone 15 Pro Max"] as const;

/** The type of what a control shows, and of the field behind it when it is a `<select>`. */
async function type(page: Page, testId: string) {
	return page.getByTestId(testId).evaluate((el) => {
		// The words the user reads: a select's are the invisible sizer's, laid over it, in the same cell.
		const words =
			el instanceof HTMLSelectElement
				? (el.parentElement?.querySelector("[data-select-sizer]") ?? el)
				: (el.querySelector("[data-testid=preset-label]") ?? el);
		const s = getComputedStyle(words);
		const f = getComputedStyle(el);
		return {
			size: s.fontSize,
			family: s.fontFamily,
			weight: s.fontWeight,
			visible: s.visibility,
			fieldSize: f.fontSize,
			fieldColor: f.color,
			fieldFamily: f.fontFamily,
			fieldWeight: f.fontWeight,
		};
	});
}

for (const name of SIZES) {
	test(`${name}: the thinking level is set like the controls beside it, and is a 16px field`, async ({
		e2eServer,
		workerStorageState,
	}, testInfo) => {
		const { defaultBrowserType: _browser, ...device } = devices[name];
		const browser = await webkit.launch({ channel: undefined });
		try {
			const context = await browser.newContext({
				...device,
				baseURL: e2eServer.url,
				storageState: workerStorageState,
				locale: "en-US",
			});
			const page = await context.newPage();
			await page.goto(`/#/s/${encodeURIComponent(realpathSync(e2eServer.fixtures.alpha))}`);
			await expect(page.getByTestId("model-picker")).toBeVisible();
			await expect(page.getByTestId("approval-picker")).toBeVisible();
			// A composer too narrow for every control (each phone) keeps the model and the permission mode in its row and has
			// the thinking level behind "⋯" (C1), in a panel that is open for the measuring; an iPad's row holds it itself.
			const more = page.getByTestId("composer-more");
			if (name === "iPad Pro 11") await expect(more).toBeHidden();
			else await more.click();
			await expect(page.getByTestId("thinking-picker")).toBeVisible();

			for (const scheme of ["light", "dark"] as const) {
				await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), scheme === "dark");
				await page
					// The innermost box that holds both the field and the controls under it: the composer.
					.locator("div")
					.filter({ has: page.locator("textarea") })
					.filter({ has: page.getByTestId("thinking-picker") })
					.last()
					.screenshot({
						path: testInfo.outputPath(`${name.replaceAll(" ", "-")}-${scheme}.png`),
						animations: "disabled",
						timeout: 10_000,
					});
			}

			const thinking = await type(page, "thinking-picker");
			const model = await type(page, "model-picker");
			const approval = await type(page, "approval-picker");
			const preset = await type(page, "preset-picker");

			for (const [label, neighbour] of Object.entries({ model, approval, preset })) {
				expect(thinking.size, `font-size beside ${label}`).toBe(neighbour.size);
				expect(thinking.family, `font-family beside ${label}`).toBe(neighbour.family);
				expect(thinking.weight, `font-weight beside ${label}`).toBe(neighbour.weight);
			}
			expect(thinking.visible, "the words the user reads are shown").toBe("visible");
			// What iOS looks at when the field takes focus: the select itself, never under 16px.
			expect(Number.parseFloat(thinking.fieldSize), "the field iOS zooms for").toBeGreaterThanOrEqual(16);
			expect(thinking.fieldColor, "its own words are not drawn over the shown ones").toBe("rgba(0, 0, 0, 0)");

			// Taking focus and choosing still works, and the page is not scaled by it.
			const picker = page.getByTestId("thinking-picker");
			await picker.selectOption("high");
			await expect(picker).toHaveValue("high");
			expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);

			await context.close();
		} finally {
			await browser.close();
		}
	});
}
