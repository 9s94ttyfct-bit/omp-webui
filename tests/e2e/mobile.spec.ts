import { FIXTURE, FIXTURE_FILES } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/** Phone layout: the sidebar is a drawer that closes when the user navigates (no model call). */

test.use({ viewport: { width: 390, height: 844 } });

test("choosing a page from the drawer closes it; the toggle stays reachable", async ({ page }) => {
	await page.goto("/");
	const toggle = page.getByRole("button", { name: "Show sidebar" });
	const drawer = page.getByRole("complementary");
	await expect(drawer).toHaveCount(0);

	await toggle.click();
	await drawer.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
	await expect(drawer).toHaveCount(0);
	const title = page.getByTestId("chat-title");
	await expect(title).toHaveText(FIXTURE.alphaTitle);
	// The toggle sits beside the title, not under it.
	const t = await toggle.boundingBox();
	const h = await title.boundingBox();
	expect(t && h && t.x + t.width <= h.x).toBe(true);

	await toggle.click();
	await drawer.getByRole("button", { name: /^Settings$/ }).click();
	await expect(drawer).toHaveCount(0);
	await expect(page.getByTestId("settings-page")).toBeVisible();
});

test("the drawer stays open when the view changes without another page being chosen", async ({ page }) => {
	// The server's frames, and a way to tell the page one more: the process moving to another session file, as a branch,
	// a fork or /new does, without a model call.
	let alphaLive: { t: "live"; info: { sessionFile: string } } | null = null;
	let tell: (frame: unknown) => void = () => {};
	await page.routeWebSocket(/\/ws$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((raw) => server.send(raw));
		server.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.t === "live" && msg.info?.sessionFile?.endsWith(FIXTURE_FILES.alpha)) alphaLive = msg;
			ws.send(raw);
		});
		tell = (frame) => ws.send(JSON.stringify(frame));
	});
	await page.goto("/");
	const toggle = page.getByRole("button", { name: "Show sidebar" });
	const drawer = page.getByRole("complementary");
	await toggle.click();
	await drawer.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
	await expect(drawer).toHaveCount(0);
	// A `!command` starts the conversation's omp without calling the model: the page now holds its process.
	await page.getByTestId("composer").fill("!echo drawer-held");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByText("drawer-held", { exact: true })).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => alphaLive !== null).toBe(true);

	await toggle.click();
	await expect(drawer).toBeVisible();
	const live = alphaLive as unknown as { t: "live"; info: { sessionFile: string } };
	const moved = live.info.sessionFile.replace(FIXTURE_FILES.alpha, FIXTURE_FILES.beta);
	tell({ ...live, info: { ...live.info, sessionFile: moved } });
	// The view follows the process to its new file (the address says so); the drawer the person opened stays.
	await expect(page).toHaveURL(new RegExp(encodeURIComponent(FIXTURE_FILES.beta).replace(/[.]/g, "\\.")));
	await expect(drawer).toBeVisible();
});
