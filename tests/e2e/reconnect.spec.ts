import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE, FIXTURE_BUCKET, FIXTURE_FILES } from "../support/fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** After a dropped connection the UI resyncs what changed meanwhile (no model call). */

/** Proxies the app's WebSocket so a test can drop it and hold it down. */
async function controllableSocket(page: Page) {
	const state = { offline: false, drop: () => {} };
	await page.routeWebSocket(/\/ws$/, (ws) => {
		if (state.offline) {
			ws.close();
			return;
		}
		const server = ws.connectToServer();
		ws.onMessage((m) => server.send(m));
		server.onMessage((m) => ws.send(m));
		state.drop = () => {
			ws.close();
			server.close();
		};
	});
	return state;
}

test("a terminal whose connection dropped is shown as stopped, not running", async ({ page }) => {
	const sock = await controllableSocket(page);
	await page.goto("/");
	// omp's TUI on a fixture conversation keeps running until stopped.
	const row = page.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle });
	await row.hover();
	await page.getByRole("button", { name: `Actions for ${FIXTURE.alphaTitle}` }).click();
	await page.getByRole("menuitem", { name: "Open in terminal" }).click();
	const status = page.getByTestId("terminal-status");
	await expect(status).toHaveText("running", { timeout: 30_000 });
	sock.drop();
	await expect(status).toHaveText("disconnected");
	await expect(page.getByText(/connection to omp-webui lost/)).toBeVisible();
});

test("sessions created while disconnected appear after reconnecting", async ({ page }) => {
	const sock = await controllableSocket(page);
	await page.goto("/");
	const rows = page.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle });
	await expect(rows).toHaveCount(1);

	// While offline the list is answered as it was: a reload a change scheduled before the drop (the new-chat page's
	// own process writes its file) must not be what shows the new conversation. Only reconnecting may.
	const before = await (await page.request.get("/api/sessions")).text();
	await page.route("**/api/sessions", (route) => route.fulfill({ contentType: "application/json", body: before }));
	sock.offline = true;
	sock.drop();
	const bucket = join(process.env.OMPW_E2E_AGENT_DIR as string, "sessions", FIXTURE_BUCKET);
	const copy = join(bucket, "2026-01-09T00-00-00-000Z_01a00000-0000-7000-8000-0000000c0c0c.jsonl");
	copyFileSync(join(bucket, FIXTURE_FILES.alpha), copy);
	try {
		// The server lists the file (its watcher fired) while this tab is offline...
		await expect
			.poll(
				async () =>
					((await (await page.request.get("/api/sessions")).json()) as { file: string }[]).some((s) =>
						s.file.endsWith("0000000c0c0c.jsonl"),
					),
				{ timeout: 15_000 },
			)
			.toBe(true);
		// ...and its `sessions_changed` broadcast (400 ms debounce in SessionStore) goes nowhere.
		// A real delay is needed: the broadcast is unobservable from an offline tab.
		await page.waitForTimeout(600);
		await expect(rows).toHaveCount(1);
		await page.unroute("**/api/sessions");
		sock.offline = false;
		await expect(page.getByText(/Reconnecting/)).toHaveCount(0, { timeout: 30_000 });
		await expect(rows).toHaveCount(2);
	} finally {
		rmSync(copy, { force: true });
	}
	await expect(rows).toHaveCount(1, { timeout: 15_000 });
});
