import { writeChatSession } from "../support/chat-session.ts";
import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { costPerToken } from "../support/stream-cost.ts";
import { expect, test } from "./fixtures.ts";

/**
 * What a streamed token costs must depend on the token, not on what the reply or the conversation already holds. Each
 * pair is measured in one page, in one run (see `costPerToken`), so the machine does not matter.
 */

const ITEMS = 1500;
const item = (i: number) => `Item ${i}: **bold** and \`code\`, see [the docs](https://example.com/${i}) and more words`;

test("a token of a long list or table costs what a token of as long a text in paragraphs does", async ({ page }) => {
	const title = "Stream list probe";
	ownSession(0x84, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "stream-list-probe");

	const shapes = {
		paragraphs: {
			before: Array.from({ length: ITEMS }, (_, i) => `${item(i)}\n\n`).join(""),
			token: (i: number) => (i % 10 === 9 ? `\n\n${item(ITEMS + i)}\n\n` : `word${i} `),
		},
		list: {
			before: Array.from({ length: ITEMS }, (_, i) => `- ${item(i)}\n`).join(""),
			token: (i: number) => (i % 10 === 9 ? `\n- ${item(ITEMS + i)}\n` : `word${i} `),
		},
		table: {
			before: `| Name | Note |\n| --- | --- |\n${Array.from({ length: ITEMS }, (_, i) => `| ${item(i)} | n${i} |\n`).join("")}`,
			token: (i: number) => (i % 10 === 9 ? `\n| ${item(ITEMS + i)} | n |\n` : `word${i} `),
		},
	};
	await costPerToken(page, tap, liveId, 30, shapes.paragraphs);
	const cost: Record<string, number> = {};
	for (const [name, shape] of Object.entries(shapes)) cost[name] = await costPerToken(page, tap, liveId, 120, shape);
	console.log(
		`ms per token after ${ITEMS} items: ${Object.entries(cost)
			.map(([k, v]) => `${k} ${v.toFixed(2)}`)
			.join(", ")}`,
	);
	expect(cost.list).toBeLessThan(cost.paragraphs * 2 + 1);
	expect(cost.table).toBeLessThan(cost.paragraphs * 2 + 1);
});

const TURNS = 750;

test("a token costs the page the same with hundreds of messages opened as with the latest ones", async ({ page }) => {
	const title = "Stream history probe";
	writeChatSession(process.env.OMPW_E2E_AGENT_DIR as string, {
		n: 0x6a,
		title,
		turns: Array.from({ length: TURNS }, (_, i) => ({
			prompt: `Question ${i}: what does item ${i} do?`,
			reply: `Answer ${i}: item ${i} reads the **config**, then:\n\n- validates it\n- starts \`workers\`\n\n| a | b |\n| - | - |\n| ${i} | ${i + 1} |\n\n${"More words. ".repeat(20)}`,
		})),
	});
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "stream-history-probe");

	const segments = page.locator("[data-segment]");
	await costPerToken(page, tap, liveId, 30);
	const latest = await costPerToken(page, tap, liveId, 150);
	const shown = await segments.count();
	// Every page of the history in ("Go to the first message" brings them all, and shows from the first), then every message mounted.
	await page.getByTestId("show-first").click();
	await expect(page.getByTestId("show-earlier")).toHaveCount(0, { timeout: 60_000 });
	// Every window of what is held, one press at a time.
	const later = page.getByTestId("show-later");
	for (let n = 0; (await later.count()) > 0 && n < 100; n++) await later.click();
	await expect(page.getByTestId("show-later")).toHaveCount(0);
	const opened = await segments.count();
	const all = await costPerToken(page, tap, liveId, 150);
	console.log(`ms per token: ${latest.toFixed(2)} with ${shown} messages, ${all.toFixed(2)} with ${opened}`);
	expect(opened).toBeGreaterThan(shown * 10);
	expect(all).toBeLessThan(latest * 1.5 + 0.5);
});
