import { expect, type Page, test } from "./fixtures.ts";

/** Loved models are listed first in the model picker and stay loved after a reload (no model call). */

/** Model options in the open picker (not the page's <select> options). */
const modelOptions = (page: Page) => page.locator("[cmdk-list]").getByRole("option");

async function openPicker(page: Page) {
	await page.getByTestId("model-picker").click();
	await expect(modelOptions(page).first()).toBeVisible({ timeout: 30_000 });
}

test("loving a model pins it to the top of the picker without switching to it", async ({ page }) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	const picker = page.getByTestId("model-picker");
	await expect(picker).toBeVisible({ timeout: 60_000 });
	const before = await picker.textContent();
	await openPicker(page);
	const options = modelOptions(page);
	test.skip((await options.count()) < 3, "omp lists too few models without provider credentials");

	// Love the last model in the list (far from the top).
	const last = options.last();
	const name = (await last.textContent())?.trim() ?? "";
	await last.hover();
	// The heart is beside the option (in its row), not inside it.
	await page.getByTestId("model-row").last().getByTestId("model-love").click();
	const favorites = page.getByTestId("model-favorites");
	await expect(favorites).toBeVisible();
	await expect(favorites.getByRole("option")).toHaveCount(1);
	await expect(favorites.getByRole("option").first()).toContainText(name);
	await expect(options.first()).toContainText(name);
	// The picker stays open and the session's model is unchanged.
	await expect(favorites).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(picker).toHaveText(before ?? "");

	// Stored by the server: still loved after a reload.
	await page.reload();
	await expect(picker).toBeVisible({ timeout: 60_000 });
	await openPicker(page);
	await expect(page.getByTestId("model-favorites").getByRole("option").first()).toContainText(name);

	// Unlove: the group goes away.
	await page.getByTestId("model-favorites").getByTestId("model-love").click();
	await expect(page.getByTestId("model-favorites")).toHaveCount(0);
});
