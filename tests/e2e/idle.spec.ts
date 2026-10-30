import { FIXTURE } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/** Off-screen idle omp processes are released for the server to reap, and can be closed (no model call). */

test("leaving an idle conversation releases its process; returning re-attaches; Settings closes it", async ({
	page,
}) => {
	await page.goto("/");
	const side = page.getByRole("complementary");
	const row = (title: string) => side.locator('[data-testid="session-item"]', { hasText: title });
	await row(FIXTURE.alphaTitle).click();
	await page.getByTestId("composer").fill("!echo idle-$((3*3))");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByText("idle-9")).toBeVisible({ timeout: 30_000 });

	const running = page.locator('[data-testid="running-session"]', { hasText: FIXTURE.alphaTitle });
	const settings = side.getByRole("button", { name: /^Settings$/ });
	// Running processes are on the App page of Settings.
	const openApp = async () => {
		await settings.click();
		await page.locator('[data-testid="settings-page-tab"][data-page="app"]').click();
	};
	await openApp();
	await expect(running.getByTestId("running-status")).toHaveText("idle · closes after 15 min");

	// Back on the conversation, this tab watches the process again and can use it.
	await row(FIXTURE.alphaTitle).click();
	await page.getByTestId("composer").fill("!echo again-$((4*4))");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByText("again-16")).toBeVisible({ timeout: 30_000 });
	await openApp();
	await expect(running).toHaveCount(1);
	await running.getByRole("button", { name: `Close ${FIXTURE.alphaTitle}` }).click();
	await expect(running).toHaveCount(0, { timeout: 15_000 });
});
