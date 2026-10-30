import { boxOf, overlap } from "../support/geometry.ts";
import { openSidebar, ownSession, sessionRow } from "../support/live.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * Error toasts (a rejected send raises one; the `prompt` reply is forced to fail, no model call): they sit at the
 * bottom right, above the composer and clear of the header, give a 28 px target to dismiss, and wait while someone is
 * reading them.
 */

async function failPrompts(page: Page) {
	await page.routeWebSocket(/\/ws$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.t === "rpc" && msg.command?.type === "prompt") {
				ws.send(JSON.stringify({ t: "reply", req: msg.req, ok: false, error: "forced prompt failure" }));
				return;
			}
			server.send(raw);
		});
		server.onMessage((raw) => ws.send(raw));
	});
}

/** Open a conversation of the spec's own (with the side panel beside it, when asked), type a draft and send it: the send fails, and its toast is returned. */
async function sendThatFails(page: Page, n: number, panel = false): Promise<Locator> {
	const title = `Toast probe ${n}`;
	ownSession(n, title);
	await failPrompts(page);
	await page.goto("/");
	await openSidebar(page);
	await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, title).click();
	if (panel) await page.getByTestId("toggle-panel").click();
	await page.getByTestId("composer").fill("retry this");
	await page.getByTestId("send").click();
	const toast = page.getByTestId("toast");
	await expect(toast).toContainText("forced prompt failure");
	return toast;
}

test.describe("wide window", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("an error toast sits bottom right, above the message box, and covers neither Send nor the header", async ({
		page,
	}) => {
		const toast = await sendThatFails(page, 0xb0);
		const t = await boxOf(toast);
		const send = await boxOf(page.getByTestId("send"));
		const composer = await boxOf(page.getByTestId("composer"));
		expect(overlap(t, send), "toast over Send").toBe(false);
		expect(t.x + t.width, "toast is at the right").toBeGreaterThan(1400 - 40);
		expect(t.y + t.height, "toast is above the message box").toBeLessThanOrEqual(composer.y);
		// Under the chat header, so its own buttons (Export, Goal, panel) and its token and cost stay clear too.
		const header = await boxOf(page.locator("header"));
		expect(overlap(t, header), "toast over the header").toBe(false);
	});

	test("an error toast stays clear of the side panel beside the chat, whose first row's Stop it must not cover", async ({
		page,
	}) => {
		const toast = await sendThatFails(page, 0x4f, true);
		const panel = await boxOf(page.getByTestId("right-panel"));
		const t = await boxOf(toast);
		expect(overlap(t, panel), "toast over the side panel").toBe(false);
		const composer = await boxOf(page.getByTestId("composer"));
		expect(t.y + t.height, "toast is above the message box").toBeLessThanOrEqual(composer.y);
		// It sits against the panel's edge, not wandering off to the middle of the page.
		expect(panel.x - (t.x + t.width), "toast beside the panel").toBeLessThan(40);
		const send = await boxOf(page.getByTestId("send"));
		expect(overlap(t, send), "toast over Send").toBe(false);
	});

	test("the dismiss button is at least 28 px and closes the toast", async ({ page }) => {
		const toast = await sendThatFails(page, 0xb1);
		const dismiss = toast.getByTestId("toast-dismiss");
		// The entrance translates the toast: CDP's transformed bounds can round 28px down to 27.99999px mid-frame.
		await toast.evaluate(async (el) => {
			await Promise.all(el.getAnimations().map((animation) => animation.finished));
		});
		const box = await boxOf(dismiss);
		expect(box.width).toBeGreaterThanOrEqual(28);
		expect(box.height).toBeGreaterThanOrEqual(28);
		await dismiss.click();
		await expect(toast).toHaveCount(0);
	});

	test("a toast waits while the pointer is over it or focus is on its button, then goes", async ({ page }) => {
		await page.clock.install();
		const toast = await sendThatFails(page, 0xb2);

		// Pointer: still there long after the 9 s an error toast lasts.
		await toast.hover();
		await page.clock.runFor(60_000);
		await expect(toast).toBeVisible();
		// Let go: it stays a moment more, then leaves.
		await page.mouse.move(5, 5);
		await page.clock.runFor(1_000);
		await expect(toast).toBeVisible();
		await page.clock.runFor(2_000);
		await expect(toast).toHaveCount(0);

		// Focus: the draft is still in the composer, so Send raises the next toast.
		await page.getByTestId("send").click();
		await expect(toast).toBeVisible();
		await toast.getByTestId("toast-dismiss").focus();
		await page.clock.runFor(60_000);
		await expect(toast).toBeVisible();
		await page.getByTestId("composer").focus();
		await page.clock.runFor(3_000);
		await expect(toast).toHaveCount(0);
	});
});

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the toast fits the screen, sits above the message box, and covers neither Send nor the header", async ({
		page,
	}) => {
		const toast = await sendThatFails(page, 0xb3);
		const t = await boxOf(toast);
		const send = await boxOf(page.getByTestId("send"));
		const composer = await boxOf(page.getByTestId("composer"));
		const header = await boxOf(page.locator("header"));
		expect(overlap(t, send), "toast over Send").toBe(false);
		expect(overlap(t, header), "toast over the header").toBe(false);
		expect(t.x, "toast starts on screen").toBeGreaterThanOrEqual(0);
		expect(t.x + t.width, "toast ends on screen").toBeLessThanOrEqual(390);
		expect(t.y + t.height, "toast is above the message box").toBeLessThanOrEqual(composer.y);
	});
});
