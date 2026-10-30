import { openFeedback } from "../support/feedback.ts";
import { ownSession, startLive } from "../support/live.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Esc asks before it stops a running reply (#606): the first one shows "Stop this reply? Press Esc again to stop", a
 * second within 3 s (or the question's Stop) stops, anything else withdraws it. The Stop button stops at once. No model
 * is called: the reply is a pushed frame, and what omp was told is read off the socket.
 */

/** Every command that stops something that the page sent. */
const aborts = (tap: SocketTap) =>
	tap.sent
		.filter((m) => m.t === "rpc" && String(m.command?.type ?? "").startsWith("abort"))
		.map((m) => m.command?.type);

const question = (page: Page) => page.getByTestId("stop-confirm");

async function replying(page: Page, n: number, title: string): Promise<SocketTap> {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	tap.answer("abort_and_restore_queue", () => ({ ok: true, data: {} }));
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `${title.toLowerCase().replaceAll(" ", "-")}-up`);
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	await expect(page.getByTestId("stop")).toBeVisible();
	return tap;
}

/** Focus off the composer, on the conversation, with nothing else holding Esc. */
const onTranscript = (page: Page) => page.getByTestId("msg-user").first().click();

test("one Esc only asks: nothing is stopped, the question is announced, and the draft keeps the cursor", async ({
	page,
}) => {
	const tap = await replying(page, 0x61, "Esc asks once");
	const composer = page.getByTestId("composer");
	await composer.fill("a draft that stays");
	await composer.press("Escape");

	await expect(question(page)).toBeVisible();
	// A live region of its own, not a dialog: a screen reader reads it as it appears, and the second Esc reaches the page.
	await expect(page.getByRole("status").filter({ hasText: "Stop this reply? Press Esc again to stop" })).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByTestId("stop-confirm-stop")).toBeVisible();
	await expect(page.getByTestId("stop-confirm-cancel")).toBeVisible();
	await expect(composer).toBeFocused();
	await expect(composer).toHaveValue("a draft that stays");
	await page.waitForTimeout(600);
	expect(aborts(tap)).toEqual([]);
});

test("Esc, Esc from the composer stops once; Esc, Esc from the page stops once", async ({ page }) => {
	const tap = await replying(page, 0x62, "Esc twice");
	const composer = page.getByTestId("composer");
	await composer.fill("keep me");
	await composer.press("Escape");
	await expect(question(page)).toBeVisible();
	await composer.press("Escape");
	await expect(question(page)).toHaveCount(0);
	await expect.poll(() => aborts(tap)).toEqual(["abort_and_restore_queue"]);
	await expect(composer).toBeFocused();

	// The question starts over: one more Esc asks again and stops nothing.
	await onTranscript(page);
	await page.keyboard.press("Escape");
	await expect(question(page)).toBeVisible();
	await page.waitForTimeout(400);
	expect(aborts(tap)).toHaveLength(1);
	await page.keyboard.press("Escape");
	await expect.poll(() => aborts(tap)).toHaveLength(2);
});

test("an Esc that is not followed by another within 3 s stops nothing, and the next one starts over", async ({
	page,
}) => {
	const tap = await replying(page, 0x63, "Esc times out");
	await onTranscript(page);
	await page.keyboard.press("Escape");
	await expect(question(page)).toBeVisible();
	// Gone by itself, a little after 3 s.
	await expect(question(page)).toHaveCount(0, { timeout: 5000 });
	expect(aborts(tap)).toEqual([]);

	// An Esc after that is a first one again: it asks, it does not stop.
	await page.keyboard.press("Escape");
	await expect(question(page)).toBeVisible();
	await page.waitForTimeout(400);
	expect(aborts(tap)).toEqual([]);
});

test("a second Esc that is more than 3 s late does not stop either", async ({ page }) => {
	const tap = await replying(page, 0x64, "Esc late");
	await onTranscript(page);
	await page.keyboard.press("Escape");
	await expect(question(page)).toBeVisible();
	await page.waitForTimeout(3300);
	await page.keyboard.press("Escape");
	await expect(question(page)).toBeVisible();
	await page.waitForTimeout(400);
	expect(aborts(tap)).toEqual([]);
});

test("Cancel withdraws the question and gives the keyboard back to the composer", async ({ page }) => {
	const tap = await replying(page, 0x65, "Esc cancel");
	await onTranscript(page);
	await page.keyboard.press("Escape");
	await page.getByTestId("stop-confirm-cancel").click();
	await expect(question(page)).toHaveCount(0);
	await expect(page.getByTestId("composer")).toBeFocused();
	await page.waitForTimeout(400);
	expect(aborts(tap)).toEqual([]);
});

test("the question's Stop stops once", async ({ page }) => {
	const tap = await replying(page, 0x66, "Esc prompt stop");
	await onTranscript(page);
	await page.keyboard.press("Escape");
	await page.getByTestId("stop-confirm-stop").click();
	await expect(question(page)).toHaveCount(0);
	await expect.poll(() => aborts(tap)).toEqual(["abort_and_restore_queue"]);
	await expect(page.getByTestId("composer")).toBeFocused();
});

test("with the keyboard alone: Esc in the composer, Shift+Tab reaches Stop and Cancel, Enter answers", async ({
	page,
}) => {
	const tap = await replying(page, 0x67, "Esc keyboard");
	const composer = page.getByTestId("composer");
	await composer.focus();
	await composer.press("Escape");
	await expect(question(page)).toBeVisible();

	await page.keyboard.press("Shift+Tab");
	await expect(page.getByTestId("stop-confirm-cancel")).toBeFocused();
	// Walking to the buttons does not withdraw the question.
	await expect(question(page)).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(question(page)).toHaveCount(0);
	await expect(composer).toBeFocused();
	expect(aborts(tap)).toEqual([]);

	await composer.press("Escape");
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Shift+Tab");
	await expect(page.getByTestId("stop-confirm-stop")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect.poll(() => aborts(tap)).toEqual(["abort_and_restore_queue"]);
	await expect(question(page)).toHaveCount(0);
	await expect(composer).toBeFocused();
});

test("any other key, or a press elsewhere, withdraws the question", async ({ page }) => {
	const tap = await replying(page, 0x68, "Esc other key");
	const composer = page.getByTestId("composer");
	await composer.focus();
	await composer.press("Escape");
	await expect(question(page)).toBeVisible();
	await composer.press("x");
	await expect(question(page)).toHaveCount(0);
	await expect(composer).toHaveValue("x");

	// The next Esc is a first one again.
	await composer.press("Escape");
	await expect(question(page)).toBeVisible();
	await page.getByTestId("msg-user").first().click();
	await expect(question(page)).toHaveCount(0);
	await page.waitForTimeout(400);
	expect(aborts(tap)).toEqual([]);
});

test("Esc in an open dialog only closes it, and a dialog opened over the question takes it away", async ({ page }) => {
	const tap = await replying(page, 0x69, "Esc dialog");
	await onTranscript(page);
	await page.keyboard.press("Escape");
	await expect(question(page)).toBeVisible();
	await openFeedback(page);
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(question(page)).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.waitForTimeout(400);
	await expect(question(page)).toHaveCount(0);
	expect(aborts(tap)).toEqual([]);
});

test("the Stop button stops at once, with no question", async ({ page }) => {
	const tap = await replying(page, 0x6a, "Esc button");
	await page.getByTestId("stop").click();
	await expect.poll(() => aborts(tap)).toEqual(["abort_and_restore_queue"]);
	await expect(question(page)).toHaveCount(0);
});

test("the same rule stops a running ! command: one Esc asks, the second stops it", async ({ page }) => {
	const title = "Esc command";
	ownSession(0x6b, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, title, "esc-command-up");
	const composer = page.getByTestId("composer");
	await composer.fill("!sleep 30 && echo never-printed-by-esc-confirm");
	await composer.press("Enter");
	await expect(page.getByTestId("pending-command")).toHaveCount(1);

	await composer.press("Escape");
	await expect(question(page)).toBeVisible();
	await page.waitForTimeout(500);
	expect(tap.commands("abort_bash")).toHaveLength(0);
	await expect(page.getByTestId("pending-command")).toHaveCount(1);

	await composer.press("Escape");
	await expect(page.getByTestId("pending-command")).toHaveCount(0, { timeout: 15_000 });
	expect(tap.commands("abort_bash")).toHaveLength(1);
});

test("the question going by itself while its button has the keyboard gives the draft its caret back", async ({
	page,
}) => {
	const tap = await replying(page, 0x6c, "Esc focus back");
	const composer = page.getByTestId("composer");
	await composer.fill("draft with a caret");
	await composer.press("Escape");
	await expect(question(page)).toBeVisible();
	await page.keyboard.press("Shift+Tab");
	await expect(page.getByTestId("stop-confirm-cancel")).toBeFocused();
	// Nobody answers: it times out under the focus.
	await expect(question(page)).toHaveCount(0, { timeout: 6000 });
	await expect(composer).toBeFocused();
	expect(aborts(tap)).toEqual([]);
});

test("the question goes when the reply ends by itself, and the keyboard goes back to the draft", async ({ page }) => {
	const title = "Esc reply ends";
	ownSession(0x6d, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "esc-reply-ends-up");
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	await expect(page.getByTestId("stop")).toBeVisible();
	const composer = page.getByTestId("composer");
	await composer.press("Escape");
	await expect(question(page)).toBeVisible();
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Shift+Tab");
	await expect(page.getByTestId("stop-confirm-stop")).toBeFocused();

	tap.push({ t: "frame", liveId, frame: { type: "agent_end", messages: [] } });
	await expect(page.getByTestId("stop")).toHaveCount(0);
	await expect(question(page)).toHaveCount(0);
	await expect(composer).toBeFocused();
	expect(aborts(tap)).toEqual([]);
	// A later Esc with nothing running is not a first Esc.
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
	await expect(question(page)).toHaveCount(0);
});

test("the question does not follow to another conversation or to New chat", async ({ page }) => {
	const tap = await replying(page, 0x6e, "Esc switch");
	await onTranscript(page);
	await page.keyboard.press("Escape");
	await expect(question(page)).toBeVisible();
	await page.evaluate(() => {
		location.hash = "#/";
	});
	await expect(page.getByTestId("chat-title")).toHaveCount(0);
	await expect(question(page)).toHaveCount(0);
	await page.waitForTimeout(400);
	expect(aborts(tap)).toEqual([]);
});
