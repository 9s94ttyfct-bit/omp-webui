import { en as pagesEn } from "../../web/src/i18n/pages-later.ts";
import { en } from "../../web/src/i18n/shell.ts";
import { zh as pagesZh } from "../../web/src/i18n/zh-CN/pages.ts";
import { zh } from "../../web/src/i18n/zh-CN/shell.ts";
import { SHORTCUTS } from "../../web/src/lib/shortcut-list.ts";
import { appReady } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** A list name, from the namespace its key names (`shell.…` or `pages.…`). */
const labelOf = (key: string, lang: "en" | "zh"): string => {
	const [ns, name] = key.split(".") as [string, string];
	const strings: Record<string, string> =
		ns === "shell" ? (lang === "en" ? en : zh) : lang === "en" ? pagesEn : pagesZh;
	return strings[name] ?? key;
};

/**
 * Settings › Keyboard shortcuts (#639): the list that used to be a dialog opened from the sidebar is a card of Settings,
 * and the sidebar keeps all its room for the conversations. `?` opens the card, in the page's language, and a `?` typed
 * into the message box stays text. No model call.
 */

const card = (page: Page) => page.getByTestId("shortcuts");
const settings = (page: Page) => page.getByTestId("shortcuts-settings");

test("? opens Settings at the shortcuts card, listing every binding", async ({ page }) => {
	await page.goto("/");
	await appReady(page);
	await page.locator("body").click({ position: { x: 600, y: 10 } });
	await page.keyboard.press("?");
	// The card is near the foot of a long page: it is drawn, and the page is brought to it.
	await expect(settings(page)).toBeVisible();
	await settings(page).scrollIntoViewIfNeeded();
	expect(new URL(page.url()).hash, "the route is Settings, on the page that holds the card").toBe("#/settings/look");
	for (const s of Object.values(SHORTCUTS)) {
		const label = labelOf(s.labelKey, "en");
		await expect(card(page).getByText(label, { exact: true })).toBeVisible();
	}
	// The groups keep their headings.
	for (const scope of ["Global", "Composer", "Subagent full screen", "Command menu", "Model picker"]) {
		await expect(card(page).getByRole("heading", { name: scope, exact: true })).toBeVisible();
	}

	// `?` typed into the composer is text, not the shortcut.
	await page.goto("/#/");
	await expect(page.getByTestId("composer")).toBeVisible();
	await page.getByTestId("composer").fill("");
	await page.getByTestId("composer").press("?");
	await expect(page.getByTestId("composer")).toHaveValue("?");
	await expect(settings(page)).toHaveCount(0);
});

test("the sidebar has no shortcuts block, and its row is not there to open", async ({ page }) => {
	await page.goto("/");
	await appReady(page);
	const side = page.getByRole("complementary");
	// The pages are still in its foot (Send feedback moved to Settings, #660); the shortcuts row that used to sit between them is gone.
	await expect(side.getByTestId("sidebar-feedback")).toHaveCount(0);
	for (const name of [/^Settings$/, /^Usage & cost$/]) await expect(side.getByRole("button", { name })).toBeVisible();
	await expect(side.getByRole("button", { name: /Keyboard shortcuts/ })).toHaveCount(0);
	await expect(side.getByText("Keyboard shortcuts")).toHaveCount(0);
	expect(await side.innerText()).not.toContain("Keyboard shortcuts");
});

test("the card is in the page's language: zh-CN lists the same bindings in Chinese", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	await page.goto("/#/settings");
	await expect(settings(page)).toBeVisible();
	await settings(page).evaluate((el) => el.scrollIntoView({ block: "start" }));
	await expect(settings(page).getByRole("heading", { level: 2 })).toHaveText(zh.shortcutsTitle);
	for (const s of Object.values(SHORTCUTS)) {
		const label = labelOf(s.labelKey, "zh");
		await expect(card(page).getByText(label, { exact: true })).toBeVisible();
	}
	await expect(card(page).getByRole("heading", { name: "子代理全屏", exact: true })).toBeVisible();
	// English is not left under the Chinese.
	await expect(settings(page)).not.toContainText("Keyboard shortcuts");
});

/** Settings at the shortcuts card, with the row of one binding. */
async function openCard(page: Page) {
	await page.goto("/#/settings");
	await expect(settings(page)).toBeVisible();
	await settings(page).evaluate((el) => el.scrollIntoView({ block: "start" }));
}
const row = (page: Page, id: string) => page.getByTestId(`shortcut-${id}`);

test("a shortcut is changed by pressing the new keys: they do it, on this device, and Reset brings the old ones back", async ({
	page,
}) => {
	await openCard(page);
	await row(page, "search").getByTestId("shortcut-change").click();
	await expect(row(page, "search").getByTestId("shortcut-record")).toBeFocused();
	// A modifier alone is waited through; the key with it is the binding.
	await page.keyboard.down("Shift");
	await page.keyboard.up("Shift");
	await page.keyboard.press("ControlOrMeta+j");
	await expect(row(page, "search").getByTestId("shortcut-keys")).toContainText("J");
	// The keys pressed in the recorder did nothing else: no palette.
	await expect(page.getByTestId("palette-input")).toHaveCount(0);

	// Kept across a reload, and what the key handlers match.
	await page.goto("/");
	await appReady(page);
	await page.locator("body").click({ position: { x: 600, y: 10 } });
	await page.keyboard.press("ControlOrMeta+k");
	await expect(page.getByTestId("palette-input")).toHaveCount(0);
	await page.keyboard.press("ControlOrMeta+j");
	await expect(page.getByTestId("palette-input")).toBeVisible();
	await page.keyboard.press("Escape");

	await openCard(page);
	await row(page, "search").getByTestId("shortcut-reset").click();
	await expect(row(page, "search").getByTestId("shortcut-keys")).toContainText("K");
	await expect(page.getByTestId("shortcuts-reset-all")).toHaveCount(0);
});

test("a key another action has is a swap, a surface's own key is refused, a typed letter and the system's keys are told", async ({
	page,
}) => {
	await openCard(page);
	// Send on ⌘↵ collides with Steer: they trade keys.
	await row(page, "send").getByTestId("shortcut-change").click();
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(row(page, "send").getByTestId("shortcut-message")).toContainText(
		"is already “Steer: interrupt omp with this message now” (Composer)",
	);
	await expect(row(page, "send").getByTestId("shortcut-message")).toContainText("gets ");
	await row(page, "send").getByTestId("shortcut-swap").click();
	await expect(row(page, "send").getByTestId("shortcut-keys")).not.toHaveText(
		await row(page, "steer").getByTestId("shortcut-keys").innerText(),
	);
	expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ompw.shortcuts") ?? "{}"))).toEqual({
		send: "Mod+Enter",
		steer: "Enter",
	});

	// Shift+Enter is the message box's own line break: refused, nothing to swap.
	await row(page, "presetCycle").getByTestId("shortcut-change").click();
	await page.keyboard.press("Shift+Enter");
	await expect(row(page, "presetCycle").getByTestId("shortcut-message")).toContainText("“New line”");
	await expect(row(page, "presetCycle").getByTestId("shortcut-swap")).toHaveCount(0);
	await row(page, "presetCycle").getByTestId("shortcut-cancel").click();

	// A letter alone would be typed into the message box: the recorder says so and keeps listening.
	await row(page, "presetCycle").getByTestId("shortcut-change").click();
	await page.keyboard.press("j");
	await expect(row(page, "presetCycle").getByTestId("shortcut-message")).toContainText("on its own it would go into");
	await expect(row(page, "presetCycle").getByTestId("shortcut-record")).toBeFocused();
	// Esc leaves the recorder with the binding as it was.
	await page.keyboard.press("Escape");
	await expect(row(page, "presetCycle").getByTestId("shortcut-record")).toHaveCount(0);
	await expect(row(page, "presetCycle").getByTestId("shortcut-keys")).toContainText("M");

	// ⌘W is the browser's: warned, and kept only on Use anyway.
	await row(page, "goal").getByTestId("shortcut-change").click();
	await page.keyboard.press("ControlOrMeta+w");
	await expect(row(page, "goal").getByTestId("shortcut-message")).toContainText("used by the browser or macOS");
	await row(page, "goal").getByTestId("shortcut-use-anyway").click();
	await expect(row(page, "goal").getByTestId("shortcut-keys")).toContainText("W");

	await page.getByTestId("shortcuts-reset-all").click();
	expect(await page.evaluate(() => localStorage.getItem("ompw.shortcuts"))).toBe("{}");
	await expect(row(page, "goal").getByTestId("shortcut-keys")).toContainText("G");
});
