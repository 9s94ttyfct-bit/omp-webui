import { en as shellEn } from "../../web/src/i18n/shell.ts";
import { zh as chatZh } from "../../web/src/i18n/zh-CN/chat.ts";
import { zh as pagesZh } from "../../web/src/i18n/zh-CN/pages.ts";
import { zh as shellZh } from "../../web/src/i18n/zh-CN/shell.ts";
import { chatEn, pagesEn } from "../support/i18n-en.ts";
import { choose } from "../support/select.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** Interface language: Settings switches to zh-CN, the choice persists, navigator.language sets the default. */

type Mod = { en: Record<string, string>; zh: Record<string, string> };
const chat: Mod = { en: chatEn, zh: chatZh };
const pages: Mod = { en: pagesEn, zh: pagesZh };
const shell: Mod = { en: shellEn, zh: shellZh };
/** The zh-CN string for an English UI string. */
function zh(mod: Mod, english: string): string {
	const key = Object.keys(mod.en).find((k) => mod.en[k] === english);
	if (!key) throw new Error(`No dictionary entry for ${JSON.stringify(english)}`);
	return mod.zh[key];
}

async function chooseLanguage(page: Page, value: string) {
	await page
		.getByRole("complementary")
		.getByRole("button", { name: /^(Settings|设置)$/ })
		.click();
	await choose(page.getByTestId("language"), value);
}

test("Settings switches the interface to Chinese across key surfaces, and the choice persists", async ({ page }) => {
	await page.goto("/");
	await chooseLanguage(page, "zh-CN");
	await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");

	// Settings and sidebar.
	await expect(page.getByRole("heading", { name: zh(pages, "Settings") })).toBeVisible();
	const sidebar = page.getByRole("complementary");
	const nav = (english: string) => sidebar.getByRole("button", { name: zh(shell, english) });
	// The shortcuts row left the sidebar with #639; the pages it holds are all still named here.
	for (const label of ["New chat", "Usage & cost", "Commands & terminal", "Settings"]) {
		await expect(nav(label)).toBeVisible();
	}
	await expect(sidebar).not.toContainText("Usage & cost");

	// Survives a reload.
	await page.reload();
	await expect(nav("New chat")).toBeVisible();

	// Usage page.
	await nav("Usage & cost").click();
	await expect(page.getByRole("heading", { name: zh(pages, "Usage & cost") })).toBeVisible();

	// A conversation's composer.
	await sidebar.getByText("Fixture alpha: zebra protocol").click();
	await expect(page.getByTestId("composer")).toHaveAttribute(
		"placeholder",
		zh(chat, "Message omp… (/ for commands, ! for bash)"),
	);

	// Back to English.
	await chooseLanguage(page, "en");
	await expect(sidebar.getByRole("button", { name: "Usage & cost" })).toBeVisible();
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test.describe("browser language", () => {
	test.use({ locale: "zh-CN" });
	test("defaults to Chinese when the browser prefers it", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByRole("complementary").getByRole("button", { name: zh(shell, "New chat") })).toBeVisible();
	});
});
