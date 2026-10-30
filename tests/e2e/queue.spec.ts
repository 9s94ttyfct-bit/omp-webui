import { expect, test } from "./fixtures.ts";

/** Messages queued while the agent works (real omp + Claude Haiku 5.5). */

test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");

test("Stop withdraws queued messages back into the composer", async ({ page }) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText(/haiku/i, { timeout: 60_000 });
	const composer = page.getByTestId("composer");
	await composer.fill("Run `sleep 20` with the bash tool, then reply FINISHED.");
	await page.getByTestId("send").click();
	await expect(page.locator('[data-testid="tool-card"][data-tool="bash"]')).toBeVisible({ timeout: 90_000 });

	await composer.fill("QUEUED-FOLLOW-UP please");
	await composer.press("Enter");
	await expect(page.getByTestId("queue")).toContainText("QUEUED-FOLLOW-UP");
	await expect(composer).toHaveValue("");

	await page.getByTestId("stop").click();
	await expect(composer).toHaveValue("QUEUED-FOLLOW-UP please");
	await expect(page.getByTestId("queue")).toHaveCount(0);
	await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 30_000 });
	// The withdrawn message was not delivered as a new turn.
	await page.waitForTimeout(2000);
	await expect(page.getByTestId("msg-user").filter({ hasText: "QUEUED-FOLLOW-UP" })).toHaveCount(0);
});
