import { rmSync } from "node:fs";
import { writeSimpleSession } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/** The control that needs omp starts it on the first click, and a double click starts one process, not two (no model call). */

test("a double click on the model picker sends one open request, and its list opens", async ({ page }) => {
	const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0x66, "Resume once");
	let opens = 0;
	await page.routeWebSocket(/\/ws$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.t === "open" && msg.target?.kind === "resume") opens++;
			server.send(raw);
		});
		server.onMessage((raw) => ws.send(raw));
	});
	try {
		await page.goto("/");
		await page.locator('[data-testid="session-item"]', { hasText: "Resume once" }).click();
		await page.getByTestId("model-picker").dblclick();
		// The list opens once omp runs.
		await expect(page.getByPlaceholder("Search models…")).toBeVisible({ timeout: 30_000 });
		expect(opens).toBe(1);
	} finally {
		rmSync(file, { force: true });
	}
});
