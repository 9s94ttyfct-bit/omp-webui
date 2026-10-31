import { choose } from "../support/select.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Both buttons that save the model roles as a preset ("Save as preset…" in the roles editor and "Save current as…" in the
 * presets card) save what omp has stored, not the editor's unsaved edits: so both wait until the edits are saved or
 * discarded (#439). Nothing here is saved, and no model is called.
 */

test("while the roles editor has unsaved edits, no button saves the stored roles as a preset", async ({ page }) => {
	await page.goto("/#/settings/models");
	const saveCurrent = page.getByTestId("save-current-preset");
	const saveAsPreset = page.getByTestId("roles-save-preset");
	await expect(saveCurrent).toBeEnabled();
	await expect(saveAsPreset).toBeEnabled();

	// Fast (smol): another thinking level than the stored one.
	const level = page.locator('[data-testid="role-row"][data-role="smol"]').getByTestId("role-thinking");
	const stored = await level.getAttribute("data-value");
	await choose(level, stored === "low" ? "high" : "low");
	await expect(page.getByTestId("roles-unsaved")).toBeVisible();
	await expect(saveAsPreset).toBeDisabled();
	await expect(saveCurrent).toBeDisabled();
	await expect(saveCurrent).toHaveAttribute("title", "Save your changes first.");

	// Discarded, the stored roles are what is on screen again, and both buttons work.
	await page.getByTestId("discard-roles").click();
	await expect(saveCurrent).toBeEnabled();
	await expect(saveAsPreset).toBeEnabled();
	await saveCurrent.click();
	await expect(page.getByRole("dialog")).toBeVisible();
});
