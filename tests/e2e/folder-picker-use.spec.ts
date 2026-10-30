import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * "Use this folder" takes the path that is in the field, whether or not it was ever listed with Go or Enter (#437): a
 * pasted path and one click is the natural way. A path that cannot be used leaves the dialog open and says why. The
 * process the page starts for the chosen folder makes no model call.
 */

let base: string;
test.beforeAll(() => {
	base = mkdtempSync(join(process.env.OMPW_E2E_WORK as string, "picker-use-"));
});
test.afterAll(() => rmSync(base, { recursive: true, force: true }));

async function openPicker(page: Page, folder = process.env.OMPW_E2E_WORK as string) {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), folder);
	await page.goto("/");
	await page.getByTestId("cwd-picker").click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByTestId("dir-up")).toBeVisible();
	return { dialog, path: dialog.getByLabel("Path") };
}

test("Use this folder takes the path in the field, also when it was never listed with Go", async ({ page }) => {
	const typed = join(base, "typed");
	mkdirSync(typed);
	const { dialog, path } = await openPicker(page);
	// The dialog lists the folder the page has now; the field says another one, as after a paste.
	await path.fill(typed);
	await dialog.getByRole("button", { name: "Use this folder" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId("cwd-picker")).toContainText(typed);
});

test("a path that cannot be used keeps the dialog open and says why; the folder does not change", async ({ page }) => {
	const { dialog, path } = await openPicker(page);
	const chip = await page.getByTestId("cwd-picker").innerText();
	await path.fill(join(base, "nowhere"));
	await dialog.getByRole("button", { name: "Use this folder" }).click();
	await expect(dialog).toContainText(`${join(base, "nowhere")} does not exist.`);
	await expect(dialog).toContainText("Choose a working folder");
	await expect(page.getByTestId("cwd-picker")).toHaveText(chip);
});

/** Whether the path field is scrolled to its end, with its text longer than the field. */
const showsEnd = (path: Locator) =>
	path.evaluate((el: HTMLInputElement) => ({
		overflows: el.scrollWidth > el.clientWidth,
		atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
	}));

test("a long path shows the folder that is open, with the field focused as it opens and after Enter in it", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const deep = join(base, "a-rather-long-folder-name", "another-long-folder-name", "the-folder-that-is-open");
	const deeper = join(deep, "and-one-more-folder-below-it");
	mkdirSync(deeper, { recursive: true });
	const { dialog, path } = await openPicker(page, deep);
	await expect(path).toHaveValue(deep);
	await expect(dialog.getByTestId("dir-up")).toHaveText("Up to another-long-folder-name");
	// The field has the focus as the dialog opens (nothing moved it), and its end is what shows: the open folder's name.
	await expect(path).toBeFocused();
	await expect.poll(() => showsEnd(path)).toEqual({ overflows: true, atEnd: true });

	// Enter in the field lists what is typed there, and the focus stays: the end of the new path shows.
	await path.fill(deeper);
	await path.press("Enter");
	await expect(dialog.getByTestId("dir-up")).toHaveText("Up to the-folder-that-is-open");
	await expect(path).toBeFocused();
	await expect.poll(() => showsEnd(path)).toEqual({ overflows: true, atEnd: true });
});

test("while New project folder's form is open, its Create is the only way on", async ({ page }) => {
	const { dialog } = await openPicker(page);
	const use = dialog.getByRole("button", { name: "Use this folder" });
	await expect(use).toBeVisible();
	await dialog.getByTestId("new-project").click();
	await expect(dialog.getByRole("button", { name: "Create and use" })).toBeVisible();
	await expect(use).toBeHidden();
	await dialog.getByRole("button", { name: "Back", exact: true }).click();
	await expect(use).toBeVisible();
});
