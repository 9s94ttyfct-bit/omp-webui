import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { type ChatTurn, solidPng, writeChatSession } from "../support/chat-session.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The end of a conversation stays in view while the reader is at it — a picture decodes late, a long draft makes the
 * composer taller — and sending a message brings the reader back to it. No model is called: files, and stubbed prompts.
 */

let agentDir: string;
test.beforeAll(() => {
	agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
});
const HASH = "cd".repeat(32);

/** Pixels of transcript below the visible part: 0 when the last message is in view. */
const gap = (page: Page) =>
	page.getByTestId("transcript").evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));

const turns = (n: number, image?: string): ChatTurn[] =>
	Array.from({ length: n }, (_, i) => ({
		prompt: `Question ${i}: what does item ${i} do?`,
		reply: `Item ${i} does thing ${i}. `.repeat(12),
		image,
	}));

const open = async (page: Page, title: string) => {
	await page.goto("/");
	const row = page.getByRole("complementary").locator('[data-testid="session-item"]', { hasText: title });
	await expect(row).toHaveCount(1, { timeout: 15_000 });
	await row.click();
	await expect(page.getByTestId("chat-title")).toHaveText(title);
};

test("a conversation with pictures that decode after it opened still ends in view", async ({ page }) => {
	const file = writeChatSession(agentDir, { n: 0x2b, title: "Pictures arrive late", turns: turns(10, HASH) });
	try {
		await page.route(`**/api/blob/${HASH}`, async (route) => {
			await sleep(700);
			await route.fulfill({ body: solidPng(400, 400), contentType: "image/png" });
		});
		await open(page, "Pictures arrive late");
		await page.waitForFunction(() => {
			const pictures = [...document.querySelectorAll('[data-testid="msg-user"] img')] as HTMLImageElement[];
			return pictures.length >= 10 && pictures.every((i) => i.complete && i.naturalWidth > 0);
		});
		await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
		await expect(page.getByRole("button", { name: "Scroll to bottom" })).toHaveCount(0);
	} finally {
		rmSync(file, { force: true });
	}
});

test("typing a tall draft keeps the last message above the composer", async ({ page }) => {
	const file = writeChatSession(agentDir, { n: 0x2c, title: "Tall draft", turns: turns(12) });
	try {
		await open(page, "Tall draft");
		await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
		await page.getByTestId("composer").fill(Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n"));
		await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
		const hidden = await page.evaluate(() => {
			const last = [...document.querySelectorAll('[data-testid="msg-assistant"]')].at(-1) as HTMLElement;
			const scroller = document.querySelector('[data-testid="transcript"]') as HTMLElement;
			return Math.round(last.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom);
		});
		expect(hidden).toBeLessThanOrEqual(0);
	} finally {
		rmSync(file, { force: true });
	}
});

test("a reader who scrolled up is not pulled down by a taller draft", async ({ page }) => {
	const file = writeChatSession(agentDir, { n: 0x2d, title: "Reader stays", turns: turns(12) });
	try {
		await open(page, "Reader stays");
		await page.getByTestId("transcript").evaluate((el) => {
			el.scrollTop = 0;
		});
		await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();
		await page.getByTestId("composer").fill(Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n"));
		await sleep(500);
		expect(await page.getByTestId("transcript").evaluate((el) => el.scrollTop)).toBe(0);
	} finally {
		rmSync(file, { force: true });
	}
});
