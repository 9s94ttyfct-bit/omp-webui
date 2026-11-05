import { FIXTURE } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/**
 * An address that names a process (`#/live/<id>`, after a reload) is attached to again; when that fails the page goes to
 * New chat, but only while it still shows that process (no model call).
 */

test("a failed re-attach leaves alone a page the person has moved on to, and the process is asked for once", async ({
	page,
}) => {
	// Hold the server's replies to `attach gone-1` until released, standing in for a slow or reconnecting server.
	const asked: string[] = [];
	let release = () => {};
	const released = new Promise<void>((r) => {
		release = r;
	});
	await page.routeWebSocket(/\/ws$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.t === "attach" && msg.liveId === "gone-1") asked.push(msg.req);
			server.send(raw);
		});
		server.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.t === "reply" && asked.includes(msg.req)) void released.then(() => ws.send(raw));
			else ws.send(raw);
		});
	});

	await page.goto("/#/live/gone-1");
	await expect.poll(() => asked.length).toBe(1);
	// Another full screen of the same process: the view changes, the process it names does not.
	await page.evaluate(() => {
		location.hash = "#/live/gone-1/agent/scout";
	});
	await expect(page).toHaveURL(/#\/live\/gone-1\/agent\/scout$/);

	// The person opens another conversation before the server has answered.
	const title = page.getByTestId("chat-title");
	await page.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
	await expect(title).toHaveText(FIXTURE.alphaTitle);
	release();
	// The refusal reaches the page; nothing on screen says it was read, so the page is given a moment to act on it.
	await page.waitForTimeout(500);
	await expect(title).toHaveText(FIXTURE.alphaTitle);
	expect(new URL(page.url()).hash).toMatch(/^#\/s\//);
	expect(asked).toHaveLength(1);
});
