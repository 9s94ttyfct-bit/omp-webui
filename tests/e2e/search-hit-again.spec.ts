import { rmSync } from "node:fs";
import { type ChatTurn, writeChatSession } from "../support/chat-session.ts";
import { appReady } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Choosing the same search hit again — after scrolling away from it — scrolls to its message and highlights it again.
 * The view names the same file and entry both times, so the page was not remounted and did nothing. No model call.
 */

const NEEDLE = "quokka-lantern-7734";

const turns: ChatTurn[] = Array.from({ length: 40 }, (_, i) => ({
	prompt: `Question ${i}: what does item ${i} do?`,
	reply: i === 30 ? `Item 30 hides the ${NEEDLE}.` : `Item ${i} does thing ${i}. `.repeat(12),
}));

async function pickHit(page: Page) {
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill(NEEDLE);
	const hit = page.getByTestId("search-hit");
	await expect(hit).toHaveCount(1, { timeout: 30_000 });
	await hit.click();
}

test("picking the same search hit again scrolls to it and highlights it again", async ({ page }) => {
	const file = writeChatSession(process.env.OMPW_E2E_AGENT_DIR as string, {
		n: 0x2f,
		title: "Same hit twice",
		turns,
	});
	try {
		await page.goto("/");
		await appReady(page);
		await pickHit(page);
		const target = page.locator('[data-entry-id="t30r"]');
		await expect(target).toHaveAttribute("data-focused", "true");
		await expect(target).toBeInViewport();

		// Away from it, and let the first highlight go.
		await page.getByTestId("transcript").evaluate((el) => {
			el.scrollTop = 0;
		});
		await expect(target).not.toBeInViewport();
		await expect(target).not.toHaveAttribute("data-focused", "true", { timeout: 6000 });

		await pickHit(page);
		await expect(target).toHaveAttribute("data-focused", "true");
		await expect(target).toBeInViewport();
	} finally {
		rmSync(file, { force: true });
	}
});
