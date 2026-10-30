import { FIXTURE } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/** A slow resume must not pull the user back to the conversation they left (no model call). */

test("switching conversations while one resumes keeps the user where they went", async ({ page }) => {
	// Hold the reply to `open` until released, standing in for a slow omp start.
	const opens = new Set<string>();
	let release = () => {};
	const released = new Promise<void>((r) => {
		release = r;
	});
	await page.routeWebSocket(/\/ws$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.t === "open" && msg.target?.kind === "resume") opens.add(msg.req);
			server.send(raw);
		});
		server.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.t === "reply" && opens.has(msg.req)) void released.then(() => ws.send(raw));
			else ws.send(raw);
		});
	});

	await page.goto("/");
	const row = (title: string) => page.locator('[data-testid="session-item"]', { hasText: title });
	const title = page.getByTestId("chat-title");
	await row(FIXTURE.alphaTitle).click();
	await expect(title).toHaveText(FIXTURE.alphaTitle);
	await page.getByTestId("composer").fill("!echo resumed");
	await page.getByTestId("composer").press("Enter");
	await expect.poll(() => opens.size).toBe(1);

	await row(FIXTURE.deltaTitle).click();
	await expect(title).toHaveText(FIXTURE.deltaTitle);
	await page.getByTestId("composer").fill("typed in delta");
	release();
	// The resumed process is registered (its session shows as open in the sidebar)...
	await expect(row(FIXTURE.alphaTitle).getByRole("img", { name: /open|running/i })).toBeVisible({ timeout: 30_000 });
	// ...while the user stays on delta with their draft.
	await expect(title).toHaveText(FIXTURE.deltaTitle);
	await expect(page.getByTestId("composer")).toHaveValue("typed in delta");
});
