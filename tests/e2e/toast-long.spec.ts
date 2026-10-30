import { boxOf, overlap } from "../support/geometry.ts";
import { openSidebar, ownSession, startLive } from "../support/live.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A toast is as long as its text: one notice of 400 lines made the stack 16,194 px tall, with the rest of the text off the
 * screen where nothing could scroll it, the Send button under it, and the whole thing gone 4.5 s later. A toast is cut to
 * a few lines with "Show more", which opens the text in a scrolling box of bounded height (and holds the toast while it
 * is open); the stack never reaches the composer, however many long toasts it holds. The notices arrive as pushed frames:
 * no model is called.
 */

async function chat(page: Page, title: string, n: number): Promise<{ tap: SocketTap; liveId: string }> {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.clock.install();
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, `toast-long-${n}`);
	return { tap, liveId };
}

const LINES = 400;
const lines = (tag: string) =>
	Array.from({ length: LINES }, (_, i) => `${tag} line ${i + 1}: ${"x".repeat(30)}`).join("\n");

const notify = (tap: SocketTap, liveId: string, id: string, message: string) =>
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "extension_ui_request", id, method: "notify", message, notifyType: "info" },
	});

/** The element at the middle of `testId` is that element itself or inside it: nothing is drawn over it. */
const uncovered = (page: Page, testId: string) =>
	page.getByTestId(testId).evaluate((el) => {
		const r = el.getBoundingClientRect();
		const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		return hit !== null && el.contains(hit);
	});

async function expectStackClear(page: Page) {
	const stack = await boxOf(page.locator('[aria-live="polite"]').filter({ has: page.getByTestId("toast") }));
	const composer = await boxOf(page.getByTestId("composer"));
	expect(stack.y + stack.height, "the stack ends above the message box").toBeLessThanOrEqual(composer.y);
	expect(await uncovered(page, "send"), "nothing is drawn over Send").toBe(true);
	expect(await uncovered(page, "composer"), "nothing is drawn over the message box").toBe(true);
	expect(overlap(await boxOf(page.getByTestId("send")), stack), "the stack over Send").toBe(false);
}

test.describe("wide window", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("long toasts are cut to a few lines and the stack stays clear of Send and the message box", async ({ page }) => {
		const { tap, liveId } = await chat(page, "Long toasts: the stack", 71);
		for (let i = 1; i <= 5; i++) notify(tap, liveId, `n${i}`, lines(`notice ${i}`));
		const toasts = page.getByTestId("toast");
		// Two are on the screen; the other three wait, and a note says so.
		await expect(toasts).toHaveCount(2);
		await expect(page.getByTestId("toasts-queued")).toHaveText("3 more waiting");
		for (const toast of await toasts.all()) {
			const box = await boxOf(toast);
			expect(box.height, "a long toast is cut").toBeLessThan(150);
			await expect(toast.getByTestId("toast-more")).toHaveText("Show more");
		}
		await expectStackClear(page);
		// The newest is the one nearest the message box, under the one before it.
		await expect(toasts.last()).toContainText("notice 5 line 1:");
		await expect(toasts.first()).toContainText("notice 4 line 1:");
	});

	test("Show more opens the whole text in a scrolling box of bounded height, and holds the toast while it is open", async ({
		page,
	}) => {
		const { tap, liveId } = await chat(page, "Long toasts: Show more", 72);
		notify(tap, liveId, "long-1", lines("opened"));
		const toast = page.getByTestId("toast");
		await expect(toast).toHaveCount(1);

		await toast.getByTestId("toast-more").click();
		await expect(toast.getByTestId("toast-more")).toHaveText("Show less");
		await expect(toast.getByTestId("toast-more")).toHaveAttribute("aria-expanded", "true");
		const text = toast.getByTestId("toast-text");
		const size = await text.evaluate((el) => ({
			shown: el.clientHeight,
			whole: el.scrollHeight,
			view: innerHeight,
			line: Number.parseFloat(getComputedStyle(el).lineHeight),
		}));
		expect(size.shown).toBeLessThanOrEqual(size.view * 0.4 + 1);
		expect(size.shown).toBeGreaterThan(100);
		// The box ends on a whole line: no line is cut in half at its bottom.
		expect(Math.abs(size.shown / size.line - Math.round(size.shown / size.line))).toBeLessThan(0.01);
		expect(size.whole).toBeGreaterThan(size.shown);
		await expectStackClear(page);

		// Every line can be reached: scrolled to the end, the last one is the last thing in the box.
		await text.focus();
		await page.keyboard.press("End");
		await expect(text).toContainText(`opened line ${LINES}:`);
		await expect
			.poll(() => text.evaluate((el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2))
			.toBe(true);

		// Open, it is not taken away: far longer than an info toast lasts, and with nothing pointing at it.
		await page.mouse.move(5, 5);
		await toast.getByTestId("toast-more").focus();
		await page.getByTestId("composer").click();
		await page.clock.fastForward(30_000);
		await expect(toast).toHaveCount(1);
		await expect(toast.getByTestId("toast-text")).toContainText(`opened line ${LINES}:`);

		// Closed again, it goes as any toast goes (after the pause that follows being read).
		await toast.getByTestId("toast-more").click();
		await page.mouse.move(5, 5);
		await page.getByTestId("composer").click();
		await page.clock.fastForward(1000);
		await expect(toast).toHaveCount(1);
		await page.clock.fastForward(10_000);
		await expect(toast).toHaveCount(0);
	});

	test("a short toast has no Show more, and a toast with text of every line break reads as lines", async ({ page }) => {
		const { tap, liveId } = await chat(page, "Long toasts: short ones", 73);
		notify(tap, liveId, "short-1", "Saved.");
		notify(tap, liveId, "short-2", "first line\nsecond line");
		const toasts = page.getByTestId("toast");
		await expect(toasts).toHaveCount(2);
		await expect(toasts.getByTestId("toast-more")).toHaveCount(0);
		const text = await toasts
			.last()
			.getByTestId("toast-text")
			.evaluate((el) => (el as HTMLElement).innerText);
		expect(text).toBe("first line\nsecond line");
	});
});

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("long toasts on a phone leave the message box and Send alone", async ({ page }) => {
		const { tap, liveId } = await chat(page, "Long toasts: phone", 74);
		for (let i = 1; i <= 5; i++) notify(tap, liveId, `p${i}`, lines(`phone ${i}`));
		await expect(page.getByTestId("toast")).toHaveCount(2);
		await expectStackClear(page);
		const toast = page.getByTestId("toast").last();
		await toast.getByTestId("toast-more").click();
		await expectStackClear(page);
		const box = await boxOf(toast);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		expect(box.x).toBeGreaterThanOrEqual(0);
	});
});
