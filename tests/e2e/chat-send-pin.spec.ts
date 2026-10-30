import { rmSync } from "node:fs";
import { type ChatTurn, writeChatSession } from "../support/chat-session.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Sending a message brings the reader back to the end of the conversation, wherever they had scrolled to, and the
 * view keeps following from there. No model is called: the conversation is a file and the prompt is stubbed.
 */

let agentDir: string;
test.beforeAll(() => {
	agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
});

/** Pixels of transcript below the visible part: 0 when the last message is in view. */
const gap = (page: Page) =>
	page.getByTestId("transcript").evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));

const turns = (n: number): ChatTurn[] =>
	Array.from({ length: n }, (_, i) => ({
		prompt: `Question ${i}: what does item ${i} do?`,
		reply: `Item ${i} does thing ${i}. `.repeat(12),
	}));

const open = async (page: Page, title: string) => {
	await page.goto("/");
	const row = page.getByRole("complementary").locator('[data-testid="session-item"]', { hasText: title });
	await expect(row).toHaveCount(1, { timeout: 15_000 });
	await row.click();
	await expect(page.getByTestId("chat-title")).toHaveText(title);
};

test("sending while scrolled up scrolls to the end and keeps following", async ({ page }) => {
	const file = writeChatSession(agentDir, { n: 0x2e, title: "Send repins", turns: turns(40) });
	try {
		const tap = await tapSocket(page);
		tap.answer("prompt", () => ({ ok: true, data: { agentInvoked: true } }));
		await open(page, "Send repins");
		await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
		await page.getByTestId("transcript").evaluate((el) => {
			el.scrollTop = 0;
		});
		await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();

		await page.getByTestId("composer").fill("Where was I?");
		await page.getByTestId("composer").press("Enter");
		await expect.poll(() => gap(page), { timeout: 3000 }).toBeLessThanOrEqual(2);
		await expect(page.getByRole("button", { name: "Scroll to bottom" })).toHaveCount(0);
		await expect.poll(() => tap.commands("prompt").length).toBe(1);
	} finally {
		rmSync(file, { force: true });
	}
});
