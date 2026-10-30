import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, test } from "./fixtures.ts";

/** A server restart kills its omp processes; chats must recover on the next send (real omp + Claude Haiku 5.5). */

let s: TestServer;
test.beforeAll(async () => {
	s = await startTestServer(0);
});
test.afterAll(async () => {
	await s?.stop();
});

test("after a server restart a new chat starts a fresh omp and sends (no model call)", async ({ page }) => {
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await page.evaluate((cwd) => localStorage.setItem("ompw.cwd", cwd), s.work);
	await page.reload();
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });

	await s.restart();
	await expect(page.getByText(/Reconnecting/)).toHaveCount(0, { timeout: 30_000 });
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	const composer = page.getByTestId("composer");
	await composer.fill("!echo restart-$((40+2))");
	await composer.press("Enter");
	await expect(page.getByText("restart-42")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText(/not found/i)).toHaveCount(0);
});

test("after a server restart the open chat resumes on the next send", async ({ page }) => {
	test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await page.evaluate((cwd) => localStorage.setItem("ompw.cwd", cwd), s.work);
	await page.reload();
	await expect(page.getByTestId("model-picker")).toContainText(/haiku/i, { timeout: 60_000 });

	const composer = page.getByTestId("composer");
	await composer.fill("Reply with exactly the word ALPHA and nothing else.");
	await composer.press("Enter");
	await expect(page.getByTestId("msg-assistant").last()).toContainText("ALPHA", { timeout: 90_000 });
	await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 60_000 });

	await s.restart();
	const banner = page.getByText("Reconnecting to the omp-webui server");
	await expect(banner).toHaveCount(0, { timeout: 30_000 });
	await expect(page.getByTestId("exit-notice")).toBeVisible();
	await expect(page.getByText(/The web server ended this conversation's omp process/)).toBeVisible();

	await composer.fill("Reply with exactly the word BRAVO and nothing else.");
	await composer.press("Enter");
	await expect(page.getByTestId("msg-assistant").last()).toContainText("BRAVO", { timeout: 90_000 });
	await expect(page.getByTestId("msg-assistant").first()).toContainText("ALPHA");
	await expect(page.getByText("Live session not found")).toHaveCount(0);
});

test("a paused command survives a server restart: still paused, and Resume finishes it (no model call)", async ({
	page,
}) => {
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await page.evaluate((cwd) => localStorage.setItem("ompw.cwd", cwd), s.work);
	await page.reload();
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });

	const composer = page.getByTestId("composer");
	await composer.fill("!sleep 4 && echo persisted-$((40+2))");
	await composer.press("Enter");
	await expect(page.getByTestId("pending-command")).toHaveCount(1);
	await page.getByTestId("pause").click();
	const banner = page.getByTestId("paused-banner");
	await expect(banner).toBeVisible();
	// The banner says that quitting does not end it.
	await expect(page.getByTestId("paused-kept")).toContainText("stays paused in the background");

	// The server ends; the frozen omp and its command stay, and the next server takes them over.
	await s.restart();
	await expect(page.getByText(/Reconnecting/)).toHaveCount(0, { timeout: 30_000 });
	await expect(banner).toBeVisible();
	await page.getByTestId("paused-resume").click();
	await expect(banner).toHaveCount(0);
	await expect(page.getByText("persisted-42")).toBeVisible({ timeout: 30_000 });
});

test("after the page loads again, a conversation the server holds paused is listed as paused", async ({ page }) => {
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await page.evaluate((cwd) => localStorage.setItem("ompw.cwd", cwd), s.work);
	await page.reload();
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	const composer = page.getByTestId("composer");
	await composer.fill("!sleep 20");
	await composer.press("Enter");
	await expect(page.getByTestId("pending-command")).toHaveCount(1);
	await page.getByTestId("pause").click();
	await expect(page.getByTestId("paused-banner")).toBeVisible();

	await s.restart();
	// A page that has never seen this server (the app, started again) learns of it from the server.
	await page.reload();
	await page
		.getByRole("complementary")
		.getByRole("button", { name: /^Settings$/ })
		.click();
	// The processes the server runs are on the App page.
	await page.locator('[data-testid="settings-page-tab"][data-page="app"]').click();
	const row = page.getByTestId("running-session").filter({ hasText: "paused" });
	await expect(row).toHaveCount(1, { timeout: 30_000 });
	await expect(row.getByTestId("running-status")).toHaveText("paused · stays when you quit");
	await expect(page.getByTestId("running-paused-note")).toContainText("stays frozen in the background");
});
