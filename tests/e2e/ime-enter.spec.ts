import { FIXTURE } from "../support/fixtures.ts";
import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * Enter that confirms a Chinese (or any IME) composition must not send, save or stop. WebKit (the macOS app's
 * WKWebView) ends the composition *before* the Enter's keydown, which then has keyCode 229 and isComposing false:
 * the sequence below is what it dispatches. No model is called: `prompt` is answered by the spec.
 */

/** What WebKit delivers when Enter picks a candidate: compositionend first, then keydown Enter with keyCode 229. */
async function webkitConfirm(field: Locator): Promise<void> {
	await field.evaluate((el) => {
		el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
		el.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, bubbles: true, cancelable: true }),
		);
	});
}

async function openAlpha(page: Page) {
	const tap = await tapSocket(page);
	tap.answer("prompt", () => ({ ok: true, data: { agentInvoked: true } }));
	await page.goto("/");
	await page.getByRole("complementary").getByText(FIXTURE.alphaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
	return tap;
}

test("composer: the Enter that confirms a composition (keyCode 229 after compositionend) does not send; a later Enter does", async ({
	page,
}) => {
	const tap = await openAlpha(page);
	const composer = page.getByTestId("composer");
	await composer.fill("nihao");

	await webkitConfirm(composer);
	// An Enter with an ordinary keyCode, but in the same breath as compositionend, is still the IME's.
	await composer.evaluate((el) => {
		el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
		el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
	});
	await page.waitForTimeout(300);
	expect(tap.commands("prompt")).toHaveLength(0);
	await expect(composer).toHaveValue("nihao");

	await composer.press("Enter");
	await expect.poll(() => tap.commands("prompt").length, { timeout: 30_000 }).toBe(1);
	expect(tap.commands("prompt")[0]).toMatchObject({ message: "nihao" });
});

test("queued message editor: that Enter does not save the half-typed word; a later Enter does", async ({ page }) => {
	const title = "IME queue edit probe";
	ownSession(0x20, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "ime-queue-up");
	tap.answer("remove_queued_message", () => ({ ok: true, data: { removed: true } }));
	tap.answer("prompt", () => ({ ok: true, data: { agentInvoked: true } }));
	tap.push({ t: "frame", liveId, frame: { type: "queue_update", steering: [], followUp: ["first"], liveSteered: 0 } });

	await page.getByTestId("queue-edit-open").click();
	const text = page.getByTestId("queue-edit-text");
	await text.press("End");
	await text.pressSequentially(" nihao");
	await webkitConfirm(text);
	await page.waitForTimeout(300);
	expect(tap.commands("remove_queued_message")).toHaveLength(0);
	await expect(page.getByTestId("queue-edit")).toBeVisible();

	await text.press("Enter");
	await expect.poll(() => tap.commands("remove_queued_message").length).toBe(1);
	expect(tap.commands("prompt").at(-1)).toMatchObject({ message: "first nihao" });
});

test("paused banner: Esc that belongs to an IME does not stop the command", async ({ page }) => {
	const title = "IME paused probe";
	ownSession(0x21, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, title, "ime-paused-up");
	await page.getByTestId("composer").fill("!sleep 30 && echo never-printed-by-ime");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByTestId("pending-command")).toHaveCount(1);
	await page.getByTestId("pause").click();
	await expect(page.getByTestId("paused-banner")).toBeVisible();

	await page.getByTestId("paused-resume").evaluate((el) => {
		el.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 229, bubbles: true, cancelable: true }),
		);
	});
	await page.waitForTimeout(300);
	await expect(page.getByTestId("paused-banner")).toBeVisible();
	await expect(page.getByTestId("stop-confirm")).toHaveCount(0);
	expect(tap.commands("abort_bash")).toHaveLength(0);

	await page.getByTestId("paused-resume").focus();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("stop-confirm")).toBeVisible();
	expect(tap.commands("abort_bash")).toHaveLength(0);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("paused-banner")).toHaveCount(0);
	expect(tap.commands("abort_bash")).toHaveLength(1);
});
