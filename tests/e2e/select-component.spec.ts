import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { devices, expect, type Page, test } from "@playwright/test";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build } from "vite";

/**
 * The app's `Select` (web/src/components/Select.tsx) on a page of its own (`tests/support/select-harness`), built with
 * Vite and served from memory: no omp, no server. On a computer it is the app's own listbox, with the keyboard of a
 * select; on a phone it is the system's `<select>`, so iOS shows its wheel and Android its list.
 */

const root = join(import.meta.dirname, "..", "..");
const ORIGIN = "http://select.test";
let dist: string;

test.beforeAll(async () => {
	dist = mkdtempSync(join(tmpdir(), "ompw-select-harness-"));
	await build({
		configFile: false,
		root: join(root, "tests", "support", "select-harness"),
		base: "./",
		logLevel: "error",
		plugins: [react(), tailwindcss()],
		resolve: { alias: { "@shared": join(root, "shared") } },
		build: { outDir: dist, emptyOutDir: true },
	});
});

test.afterAll(() => {
	if (dist) rmSync(dist, { recursive: true, force: true });
});

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

async function openHarness(page: Page) {
	await page.route(`${ORIGIN}/**`, (route) => {
		const path = new URL(route.request().url()).pathname;
		const file = join(dist, path === "/" ? "index.html" : path);
		try {
			return route.fulfill({
				body: readFileSync(file),
				contentType: TYPES[extname(file)] ?? "application/octet-stream",
			});
		} catch {
			return route.fulfill({ status: 404 });
		}
	});
	await page.goto(`${ORIGIN}/`);
	await expect(page.getByTestId("fruit")).toBeVisible();
}

test.describe("on a computer: the app's own listbox", () => {
	test("the control is a combobox named by its label, showing what is chosen", async ({ page }) => {
		await openHarness(page);
		const fruit = page.getByRole("combobox", { name: /Fruit fruit/ });
		await expect(fruit).toHaveAttribute("data-testid", "fruit");
		await expect(fruit).toHaveJSProperty("tagName", "BUTTON");
		await expect(fruit).toHaveText("Banana");
		await expect(fruit).toHaveAttribute("data-value", "banana");
		await expect(fruit).toHaveAttribute("aria-expanded", "false");
		// No system select anywhere: every one of the page's selects is the app's own.
		await expect(page.locator("select:not([aria-hidden])")).toHaveCount(0);
	});

	test("a click opens the list; a click on an option chooses it and gives focus back", async ({ page }) => {
		await openHarness(page);
		const fruit = page.getByTestId("fruit");
		await fruit.click();
		const list = page.getByRole("listbox");
		await expect(list).toBeVisible();
		await expect(fruit).toHaveAttribute("aria-expanded", "true");
		await expect(list.getByRole("option")).toHaveText(["None", "Apple", "Banana", "Cherry", "Date", "Lemon", "Lime"]);
		await expect(list.getByRole("option", { name: "Banana" })).toHaveAttribute("aria-selected", "true");
		await expect(list.getByRole("group")).toContainText("Citrus");
		await list.getByRole("option", { name: "Date" }).click();
		await expect(list).toHaveCount(0);
		await expect(fruit).toHaveAttribute("data-value", "date");
		await expect(fruit).toHaveText("Date");
		await expect(page.getByTestId("fruit-changes")).toHaveText("[date]");
		await expect(fruit).toBeFocused();
	});

	test("a disabled option is shown and cannot be chosen, by keyboard or by click", async ({ page }) => {
		await openHarness(page);
		const fruit = page.getByTestId("fruit");
		const list = page.getByRole("listbox");
		await fruit.focus();
		await page.keyboard.press("ArrowDown");
		await expect(list.getByRole("option", { name: "Banana" })).toBeFocused();
		const cherry = list.getByRole("option", { name: "Cherry" });
		await expect(cherry).toHaveAttribute("aria-disabled", "true");
		// From Banana, the next option the arrow reaches is Date: Cherry is passed over.
		await page.keyboard.press("ArrowDown");
		await expect(list.getByRole("option", { name: "Date" })).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(list).toHaveCount(0);

		await fruit.click();
		await cherry.click({ force: true });
		await expect(list).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(fruit).toHaveAttribute("data-value", "banana");
		await expect(page.getByTestId("fruit-changes")).toHaveText("");
	});

	test("the keyboard: arrows open it, Home/End, type-ahead, Enter and Space choose, Esc leaves it as it was", async ({
		page,
	}) => {
		await openHarness(page);
		const fruit = page.getByTestId("fruit");
		const list = page.getByRole("listbox");
		const changes = page.getByTestId("fruit-changes");
		await fruit.focus();

		// ArrowDown opens it on what is chosen; Esc closes it without a change, and focus stays on the control.
		await page.keyboard.press("ArrowDown");
		await expect(list).toBeVisible();
		await expect(list.getByRole("option", { name: "Banana" })).toBeFocused();
		await page.keyboard.press("ArrowUp");
		await expect(list.getByRole("option", { name: "Apple" })).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(list).toHaveCount(0);
		await expect(fruit).toHaveAttribute("data-value", "banana");
		await expect(fruit).toBeFocused();
		await expect(changes).toHaveText("");

		// End, then Enter: the last option.
		await page.keyboard.press("Enter");
		await expect(list).toBeVisible();
		await page.keyboard.press("End");
		await expect(list.getByRole("option", { name: "Lime" })).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(fruit).toHaveAttribute("data-value", "lime");
		await expect(fruit).toBeFocused();

		// Home, then Space: the first option, whose value is "".
		await page.keyboard.press("Space");
		await expect(list).toBeVisible();
		await page.keyboard.press("Home");
		await expect(list.getByRole("option", { name: "None" })).toBeFocused();
		await page.keyboard.press("Space");
		await expect(list).toHaveCount(0);
		await expect(fruit).toHaveAttribute("data-value", "");
		await expect(fruit).toHaveText("None");
		await expect(fruit).toBeFocused();

		// Type-ahead in the open list.
		await page.keyboard.press("ArrowDown");
		await expect(list).toBeVisible();
		await page.keyboard.type("le");
		await expect(list.getByRole("option", { name: "Lemon" })).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(fruit).toHaveAttribute("data-value", "lemon");
		await expect(fruit).toBeFocused();

		// And on the closed control, as a select does: a letter chooses without opening the list.
		await page.waitForTimeout(1100); // the type-ahead forgets what was typed after a second
		await page.keyboard.type("a");
		await expect(list).toHaveCount(0);
		await expect(fruit).toHaveAttribute("data-value", "apple");
		await expect(changes).toHaveText("[lime][][lemon][apple]");
	});

	test("a disabled select does not open", async ({ page }) => {
		await openHarness(page);
		const off = page.getByTestId("off");
		await expect(off).toBeDisabled();
		await off.click({ force: true });
		await expect(page.getByRole("listbox")).toHaveCount(0);
		await expect(off).toHaveAttribute("data-value", "banana");
	});

	test("a box that clips its content does not clip the list", async ({ page }) => {
		await openHarness(page);
		await page.getByTestId("clipped").click();
		const list = page.getByRole("listbox");
		await expect(list).toBeVisible();
		const box = await page.getByTestId("clip").boundingBox();
		const lime = page.getByRole("option", { name: "Lime" });
		const limeBox = await lime.boundingBox();
		expect(box && limeBox && limeBox.y > box.y + box.height, "Lime is drawn below the clipping box").toBe(true);
		await lime.click();
		await expect(page.getByTestId("clipped")).toHaveAttribute("data-value", "lime");
	});

	test("in a dialog: the list is over the dialog, and Esc closes the list, not the dialog", async ({ page }) => {
		await openHarness(page);
		await page.getByTestId("open-dialog").click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		const select = dialog.getByTestId("in-dialog");
		await select.click();
		const list = page.getByRole("listbox");
		await expect(list).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(list).toHaveCount(0);
		await expect(dialog).toBeVisible();
		await select.click();
		await page.getByRole("option", { name: "Apple" }).click();
		await expect(select).toHaveAttribute("data-value", "apple");
		await expect(dialog).toBeVisible();
	});
});

for (const name of ["Pixel 5", "iPhone 13"] as const) {
	test.describe(`on a phone (${name}): the system's own picker`, () => {
		const { defaultBrowserType: _browser, ...device } = devices[name];
		test.use(device);

		test("the control is a <select> with the same options, disabled one and group included", async ({ page }) => {
			await openHarness(page);
			const fruit = page.getByTestId("fruit");
			await expect(fruit).toHaveJSProperty("tagName", "SELECT");
			await expect(page.getByRole("combobox", { name: /Fruit fruit/ })).toHaveAttribute("data-testid", "fruit");
			await expect(fruit).toHaveValue("banana");
			await expect(fruit).toHaveAttribute("data-value", "banana");
			await expect(fruit.locator("option")).toHaveText(["None", "Apple", "Banana", "Cherry", "Date", "Lemon", "Lime"]);
			await expect(fruit.locator("option[disabled]")).toHaveText("Cherry");
			await expect(fruit.locator("optgroup")).toHaveAttribute("label", "Citrus");
			// 16px: iOS does not zoom the page into a field this size when it takes focus.
			await expect(fruit).toHaveCSS("font-size", "16px");
			await fruit.selectOption("date");
			await expect(fruit).toHaveAttribute("data-value", "date");
			await expect(page.getByTestId("fruit-changes")).toHaveText("[date]");
			await fruit.selectOption("");
			await expect(page.getByTestId("fruit-changes")).toHaveText("[date][]");
			await expect(page.getByTestId("off")).toBeDisabled();
		});
	});
}
