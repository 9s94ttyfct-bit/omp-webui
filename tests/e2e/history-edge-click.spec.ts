import { realpathSync, rmSync } from "node:fs";
import { answerText, type LongConversation, writeLongConversation } from "../support/long-history.ts";
import { expect, test } from "./fixtures.ts";

/**
 * "Show later messages" is a button like any other (#590): whoever brings it into the view, by scrolling to it, by
 * the keyboard, or by a pointer that clicked something else a moment before, finds it where it was and can press it.
 * Messages are brought in by themselves only for a reader whose hand is scrolling toward them (the wheel, the keys
 * that scroll, the scrollbar), and a click on "Go to the first message" is not that: it used to leave the page ready to
 * bring the next messages in the moment the button came near, which put them above it and the button a page further
 * down, so a click on the place it had been landed on a message.
 */

const TURNS = 300;
let conversation: LongConversation;

test.beforeAll(() => {
	conversation = writeLongConversation(process.env.OMPW_E2E_AGENT_DIR as string, {
		id: "01a00000-0000-7000-8000-00000000fe60",
		turns: TURNS,
		title: "History edge click",
	});
});
test.afterAll(() => {
	rmSync(conversation.file, { force: true });
});

const address = () => `/#/s/${encodeURIComponent(realpathSync(conversation.file))}`;

test("Show later messages is pressed as it is after Go to the first message, one window at a time", async ({
	page,
}) => {
	await page.goto(address());
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(TURNS - 1))).toBeVisible();
	// A click on "Go to the first message" shows the first window of the whole conversation, with the rest below it.
	await page.getByTestId("show-first").click();
	await expect(page.getByTestId("show-earlier")).toHaveCount(0, { timeout: 60_000 });
	const later = page.getByTestId("show-later");
	await expect(later).toBeVisible();
	const segments = transcript.locator("[data-segment]");
	for (let n = 0; n < 8; n++) {
		const shown = await segments.count();
		// Scrolled to, the button is where it was a moment later: nothing is brought in by itself above it.
		await later.scrollIntoViewIfNeeded();
		await page.waitForTimeout(300);
		await expect(later).toBeInViewport();
		expect(await segments.count()).toBe(shown);
		// A plain click presses it where it is, and is not retried onto a message that has been put there.
		await later.click({ timeout: 10_000 });
		await expect.poll(() => segments.count()).toBeGreaterThan(shown);
		// And nothing else came by itself behind it: the next window is for the next click.
		await page.waitForTimeout(300);
		expect(await segments.count()).toBeLessThanOrEqual(shown + 30);
	}
});

test("Show later messages that holds the keyboard focus stays in the view", async ({ page }) => {
	await page.goto(address());
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(TURNS - 1))).toBeVisible();
	await page.getByTestId("show-first").click();
	await expect(page.getByTestId("show-earlier")).toHaveCount(0, { timeout: 60_000 });
	const later = page.getByTestId("show-later");
	const segments = transcript.locator("[data-segment]");
	// Focus brings the button into the view; the messages that come by Enter come after it was pressed, not before.
	await later.focus();
	await page.waitForTimeout(600);
	await expect(later).toBeInViewport();
	const shown = await segments.count();
	await page.keyboard.press("Enter");
	await expect.poll(() => segments.count()).toBeGreaterThan(shown);
});
