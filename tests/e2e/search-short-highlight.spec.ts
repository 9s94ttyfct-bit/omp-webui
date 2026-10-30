import { rmSync } from "node:fs";
import { writeChatSession } from "../support/chat-session.ts";
import { appReady } from "../support/live.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The search palette marks what matched in each hit for a query of any length. Chinese words are mostly 1-2 characters,
 * which trigram full-text search cannot take (it needs 3), and the substring scan that serves them left every snippet
 * unmarked, so a Chinese user never saw a highlight (#299). No model call.
 */

const turns = [
	{
		prompt: "请解释斑马协议的数据包结构，并给出示例。",
		reply: `${"字".repeat(150)}斑马协议使用条纹数据包。${"字".repeat(150)}`,
	},
];

for (const query of ["斑", "斑马", "斑马协议"]) {
	test(`${query}: every hit in the palette has the match marked, and a cut snippet shows where`, async ({ page }) => {
		const file = writeChatSession(process.env.OMPW_E2E_AGENT_DIR as string, {
			n: 0x5a,
			title: "斑马笔记",
			turns,
		});
		try {
			await page.goto("/");
			await appReady(page);
			await page.keyboard.press("ControlOrMeta+k");
			await page.getByTestId("palette-input").fill(query);
			const hits = page.getByTestId("search-hit");
			await expect(hits).toHaveCount(2, { timeout: 30_000 });
			for (let i = 0; i < 2; i++) {
				const marks = hits.nth(i).locator("mark");
				expect(await marks.count(), `hit ${i}`).toBeGreaterThan(0);
				for (const text of await marks.allTextContents()) expect(text).toBe(query);
			}
			// The reply goes on past the snippet on both sides: `…` says so; the short prompt is shown whole.
			const reply = hits.filter({ hasText: "条纹数据包" });
			await expect(reply).toHaveCount(1);
			await expect(reply).toContainText(/^.*….*…/s);
			await expect(hits.filter({ hasText: "请解释" })).not.toContainText("…");
		} finally {
			rmSync(file, { force: true });
		}
	});
}
