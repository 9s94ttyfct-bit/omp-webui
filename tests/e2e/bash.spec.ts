import { expect, test } from "./fixtures.ts";

/** User `!commands` run in the background and can be stopped (omp RPC `bash` / `abort_bash`; no model call). */

test("a long !command leaves the composer usable and Stop cancels it", async ({ page }) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	const composer = page.getByTestId("composer");
	await composer.fill("!sleep 60 && echo never-printed");
	await composer.press("Enter");

	const stop = page.getByTestId("stop");
	await expect(stop).toBeVisible();
	await expect(composer).toBeEnabled();
	await composer.fill("still typing");
	await expect(composer).toHaveValue("still typing");

	const started = Date.now();
	await stop.click();
	await expect(stop).toHaveCount(0, { timeout: 15_000 });
	expect(Date.now() - started).toBeLessThan(15_000);
	await expect(page.getByText("sleep 60 && echo never-printed")).toBeVisible();
	await expect(page.getByText("never-printed", { exact: true })).toHaveCount(0);
});
