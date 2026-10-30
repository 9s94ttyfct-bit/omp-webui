import { expect, test } from "./fixtures.ts";

/** When omp's word predictor lacks its prompt history, Settings says so (no model call). */

test("a missing prompt-history table is explained in Settings", async ({ page }) => {
	let predictions = 0;
	await page.routeWebSocket(/\/ws$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.t === "rpc" && msg.command?.type === "predict_word") {
				predictions++;
				ws.send(JSON.stringify({ t: "reply", req: msg.req, ok: false, error: "no such table: history" }));
				return;
			}
			server.send(raw);
		});
		server.onMessage((raw) => ws.send(raw));
	});
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await page.getByTestId("composer").pressSequentially("Please refa");
	await expect.poll(() => predictions).toBeGreaterThan(0);
	await expect(page.getByTestId("ghost")).toHaveCount(0);
	await page
		.getByRole("complementary")
		.getByRole("button", { name: /^Settings$/ })
		.click();
	// The note is in the Conversations card, on the Chats page.
	await page.locator('[data-testid="settings-page-tab"][data-page="chats"]').click();
	await expect(page.getByTestId("prediction-unavailable")).toContainText("prompt history");
});
