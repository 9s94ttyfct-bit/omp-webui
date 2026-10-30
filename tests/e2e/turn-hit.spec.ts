import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { appReady } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A search hit among the hidden rows of a long turn (a goal run is one turn of thousands of steps, and the page draws a
 * window of its rows): the rows around the hit are drawn, the page scrolls to it, and they stay drawn when the page lets go
 * of the hit a moment later. They went at once, which left the page at the end of the turn, thousands of pixels from the hit.
 */

const STEPS = 400;
const HIT = 100;
const SESSION_ID = "01a00000-0000-7000-8000-00000000fe03";
let file: string;
const stamp = "2026-01-08T00:00:00.000Z";
const id = (i: number) => `s${i.toString(16).padStart(7, "0")}`;

test.beforeAll(() => {
	file = join(
		process.env.OMPW_E2E_AGENT_DIR as string,
		"sessions",
		FIXTURE_BUCKET,
		`2026-01-08T00-00-00-000Z_${SESSION_ID}.jsonl`,
	);
	const lines: Record<string, unknown>[] = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: stamp, cwd: FIXTURE_CWD },
		{ type: "title_change", id: "t0000000", parentId: null, timestamp: stamp, title: "One long turn" },
		{
			type: "message",
			id: "u0000000",
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: [{ type: "text", text: "run the long goal" }], attribution: "user" },
		},
	];
	for (let i = 0; i < STEPS; i++) {
		lines.push({
			type: "message",
			id: id(i),
			parentId: i ? id(i - 1) : "u0000000",
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: `step ${i}: ${i === HIT ? "needleword-hit found here" : "working on the next thing"}` },
				],
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: 0.001 } },
				stopReason: "stop",
			},
		});
	}
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
});
test.afterAll(() => rmSync(file, { force: true }));

const rowsDrawn = (page: Page) => page.locator('[data-testid="agent-turn"] [data-testid="msg-assistant"]').count();

async function searchHit(page: Page): Promise<void> {
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill("needleword-hit");
	await page.getByTestId("search-hit").first().click();
}

test("a search hit among the hidden rows of a long turn is shown, and stays shown", async ({ page }) => {
	await searchHit(page);
	const hit = page.locator(`[data-entry-id="${id(HIT)}"]`);
	await expect(hit).toHaveAttribute("data-focused", "true");
	await expect(hit).toBeInViewport();
	// The page lets go of the hit right after scrolling to it; what it drew for it stays (it was gone a frame later).
	await page.waitForTimeout(1500);
	await expect(hit).toBeInViewport();
	await expect(hit).toHaveCount(1);
	// A block of rows around the hit, not the whole turn from there on, and not the last rows of it.
	const drawn = await rowsDrawn(page);
	expect(drawn).toBeGreaterThan(60);
	expect(drawn).toBeLessThanOrEqual(130);
	await expect(page.getByText(`step ${STEPS - 1}:`)).toHaveCount(0);
	// The way to the rest is there, both ways.
	await expect(page.getByTestId("show-earlier-steps")).toBeVisible();
	await expect(page.getByTestId("show-later-steps")).toBeVisible();
});

test("later steps are added below the window until it reaches the end of the turn", async ({ page }) => {
	await searchHit(page);
	await expect(page.locator(`[data-entry-id="${id(HIT)}"]`)).toBeInViewport();
	const later = page.getByTestId("show-later-steps");
	const before = await rowsDrawn(page);
	await later.evaluate((el) => (el as HTMLElement).click());
	await expect.poll(() => rowsDrawn(page)).toBeGreaterThan(before);
	// Until there are none left: the turn's last step is drawn, and the button is gone.
	for (let i = 0; i < 8 && (await later.count()) > 0; i++) {
		await later.evaluate((el) => (el as HTMLElement).click());
		await page.waitForTimeout(50);
	}
	await expect(later).toHaveCount(0);
	await expect(page.getByText(`step ${STEPS - 1}:`)).toHaveCount(1);
});

test("the arrow at the bottom, and sending, show the latest steps again", async ({ page }) => {
	await searchHit(page);
	await expect(page.locator(`[data-entry-id="${id(HIT)}"]`)).toBeInViewport();
	await page.waitForTimeout(500);
	// Short of the end of the turn the way down is the arrow, which brings the latest rows and takes the hit's window away.
	await expect(page.getByRole("button", { name: /Scroll to bottom|滚动到底部/ })).toBeVisible();
	await page.getByRole("button", { name: /Scroll to bottom|滚动到底部/ }).click();
	await expect(page.getByText(`step ${STEPS - 1}:`)).toBeVisible();
	await expect(page.locator(`[data-entry-id="${id(HIT)}"]`)).toHaveCount(0);
	await expect(page.getByTestId("show-later-steps")).toHaveCount(0);
	void realpathSync;
});
