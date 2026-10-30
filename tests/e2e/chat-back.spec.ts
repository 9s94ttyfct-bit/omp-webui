import { rmSync } from "node:fs";
import { type ChatTurn, writeChatSession } from "../support/chat-session.ts";
import { appReady, ownSession, sessionRow } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Leaving a conversation and pressing Back reopens it as it was left: the messages that had been shown (not only the
 * latest ones) and the message at the top of the view where it was. Opening a conversation from the sidebar still
 * starts at its end. No model call: the conversations are files.
 */

const TITLE = "Back probe";
const turns: ChatTurn[] = Array.from({ length: 80 }, (_, i) => ({
	prompt: `Question ${i}: what does item ${i} do?`,
	reply: `Item ${i} does thing ${i}. `.repeat(6),
}));

const prompts = (page: Page) => page.getByTestId("msg-user");

/** How far below the top of the transcript's view a message starts (negative: above it). */
const offsetOf = (page: Page, entry: string): Promise<number> =>
	page.evaluate((id) => {
		const view = document.querySelector('[data-testid="transcript"]') as HTMLElement;
		const el = view.querySelector(`[data-entry-id="${id}"]`) as HTMLElement;
		return el.getBoundingClientRect().top - view.getBoundingClientRect().top;
	}, entry);

test("Back reopens a conversation with the messages that were shown and the place in them, and the sidebar opens it at the end", async ({
	page,
}) => {
	const file = writeChatSession(process.env.OMPW_E2E_AGENT_DIR as string, { n: 0xe2, title: TITLE, turns });
	ownSession(0xe3, "Back elsewhere");
	try {
		await page.goto(`/#/s/${encodeURIComponent(file)}`);
		await appReady(page);
		await expect(page.locator('[data-entry-id="t79r"]')).toBeVisible();
		// A window of the latest messages: 30 of them are 15 prompts.
		await expect(prompts(page)).toHaveCount(15);

		// Read further back: two steps of "Show earlier messages", then a message from the middle at a place of its own.
		await page.getByTestId("show-earlier").click();
		await page.getByTestId("show-earlier").click();
		await expect(prompts(page)).toHaveCount(45);
		const target = page.locator('[data-entry-id="t60p"]');
		await target.scrollIntoViewIfNeeded();
		await page.getByTestId("transcript").evaluate((view, id) => {
			const el = view.querySelector(`[data-entry-id="${id}"]`) as HTMLElement;
			view.scrollTop += el.getBoundingClientRect().top - view.getBoundingClientRect().top - 180;
		}, "t60p");
		// The reader's place has settled once the offset stops changing.
		await expect.poll(() => offsetOf(page, "t60p")).toBeCloseTo(180, -1);
		const left = await offsetOf(page, "t60p");

		// Another conversation, then Back.
		await sessionRow(page, "Back elsewhere").click();
		await expect(page.getByText("Back elsewhere.", { exact: true })).toBeVisible();
		await expect(page.locator('[data-entry-id="t60p"]')).toHaveCount(0);
		await page.goBack();

		await expect(target).toBeVisible();
		await expect(prompts(page)).toHaveCount(45);
		// The messages fade in again (a 4 px slide for 0.18 s moves their boxes): the place is compared once that is over.
		await expect.poll(async () => Math.abs((await offsetOf(page, "t60p")) - left)).toBeLessThan(1);

		// Forward and then the sidebar: a conversation opened from the list is shown from its end, as it always was.
		await page.goForward();
		await expect(page.getByText("Back elsewhere.", { exact: true })).toBeVisible();
		await sessionRow(page, TITLE).click();
		await expect(page.locator('[data-entry-id="t79r"]')).toBeInViewport();
		await expect(prompts(page)).toHaveCount(15);
	} finally {
		rmSync(file, { force: true });
	}
});

test("Back to a conversation left at its end opens it at its end, following new messages", async ({ page }) => {
	const file = writeChatSession(process.env.OMPW_E2E_AGENT_DIR as string, {
		n: 0xe4,
		title: "Back at the end",
		turns: turns.slice(0, 40),
	});
	ownSession(0xe5, "Back other end");
	try {
		await page.goto(`/#/s/${encodeURIComponent(file)}`);
		await appReady(page);
		await expect(page.locator('[data-entry-id="t39r"]')).toBeInViewport();
		await sessionRow(page, "Back other end").click();
		await expect(page.getByText("Back other end.", { exact: true })).toBeVisible();
		await page.goBack();
		await expect(page.locator('[data-entry-id="t39r"]')).toBeInViewport();
		await expect(prompts(page)).toHaveCount(15);
		// At the end it is followed: the scroll-to-bottom button is not offered.
		await expect(page.getByRole("button", { name: "Scroll to bottom" })).toHaveCount(0);
	} finally {
		rmSync(file, { force: true });
	}
});
