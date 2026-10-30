import { rmSync } from "node:fs";
import { type ChatTurn, writeChatSession } from "../support/chat-session.ts";
import { appReady } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A search hit in a conversation of hundreds of turns shows a bounded window around it, not every message from the
 * hit to the latest (800 messages were ~83k elements and about a second). "Show later messages" adds more below,
 * without moving what the reader is looking at, and the scroll-to-bottom button brings the latest back. No model call.
 */

const EARLY = "okapi-lantern-5521";
const LATE = "okapi-lantern-5522";

const turns: ChatTurn[] = Array.from({ length: 400 }, (_, i) => ({
	prompt: `Question ${i}: what does item ${i} do?`,
	reply:
		i === 20
			? `Item 20 hides the ${EARLY}.`
			: i === 395
				? `Item 395 hides the ${LATE}.`
				: `Item ${i} does thing ${i}. `,
}));

async function pickHit(page: Page, needle: string) {
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill(needle);
	const hit = page.getByTestId("search-hit");
	await expect(hit).toHaveCount(1, { timeout: 30_000 });
	await hit.click();
}

const prompts = (page: Page) => page.getByTestId("msg-user");

const offsetOf = (page: Page, entry: string): Promise<number> =>
	page.evaluate((id) => {
		const view = document.querySelector('[data-testid="transcript"]') as HTMLElement;
		const el = view.querySelector(`[data-entry-id="${id}"]`) as HTMLElement;
		return el.getBoundingClientRect().top - view.getBoundingClientRect().top;
	}, entry);

test("a hit near the start mounts a window around it, Show later adds more below without moving the reader, and scroll-to-bottom shows the latest", async ({
	page,
}) => {
	const file = writeChatSession(process.env.OMPW_E2E_AGENT_DIR as string, {
		n: 0xe6,
		title: "Long search window",
		turns,
	});
	try {
		await page.goto("/");
		await appReady(page);
		await pickHit(page, EARLY);
		const hit = page.locator('[data-entry-id="t20r"]');
		await expect(hit).toHaveAttribute("data-focused", "true");
		await expect(hit).toBeInViewport();

		// 3 messages above the hit, 30 below: 17 prompts of 400, not the 380 between the hit and the latest.
		await expect(prompts(page)).toHaveCount(17);
		const later = page.getByTestId("show-later");
		await expect(later).toBeVisible();
		// What is held below the window: the page the server answered around the hit (a window of the history, not the file).
		await expect(later).toHaveText(/Show later messages \(\d+\)/);
		const held = Number(/\((\d+)\)/.exec((await later.textContent()) ?? "")?.[1]);
		expect(held).toBeGreaterThan(60);
		await expect(page.getByTestId("show-earlier")).toBeVisible();
		await expect(page.locator('[data-entry-id="t399r"]')).toHaveCount(0);

		// The reader is at the end of the window, where the button is. One step of 30 more messages (15 prompts) goes
		// below it, and the last message on screen has not moved.
		await later.scrollIntoViewIfNeeded();
		const before = await offsetOf(page, "t35r");
		await later.click();
		await expect(prompts(page)).toHaveCount(32);
		await expect(later).toHaveText(`Show later messages (${held - 30})`);
		expect(Math.abs((await offsetOf(page, "t35r")) - before)).toBeLessThan(2);
		await expect(page.locator('[data-entry-id="t36p"]')).toBeAttached();

		// The latest messages are one click away, and then there is no later window.
		await page.getByRole("button", { name: "Scroll to bottom" }).click();
		await expect(page.locator('[data-entry-id="t399r"]')).toBeInViewport();
		await expect(page.getByTestId("show-later")).toHaveCount(0);
		await expect(prompts(page)).toHaveCount(15);
	} finally {
		rmSync(file, { force: true });
	}
});

test("a hit among the latest messages shows them as it always did, with no Show later", async ({ page }) => {
	const file = writeChatSession(process.env.OMPW_E2E_AGENT_DIR as string, { n: 0xe7, title: "Late search hit", turns });
	try {
		await page.goto("/");
		await appReady(page);
		await pickHit(page, LATE);
		const hit = page.locator('[data-entry-id="t395r"]');
		await expect(hit).toHaveAttribute("data-focused", "true");
		await expect(hit).toBeInViewport();
		await expect(page.getByTestId("show-later")).toHaveCount(0);
		await expect(prompts(page)).toHaveCount(15);
	} finally {
		rmSync(file, { force: true });
	}
});
