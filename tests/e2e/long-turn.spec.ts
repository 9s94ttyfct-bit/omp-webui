import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeChatSession } from "../support/chat-session.ts";
import { writeLongFakeOmp } from "../support/long-fake-omp-bin.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A goal run is one turn of thousands of steps, and a conversation can be tens of megabytes. What they cost the page
 * must not grow with how long they have run: the turn on screen draws a window of its rows, Stop answers at once
 * in the middle of it, and an omp that starts on a conversation the page already holds is not sent the whole of it
 * again. The omp is a stand-in that streams a script (tests/support/long-fake-omp.ts): no model is called.
 */

let s: TestServer;
let binDir: string;
const TITLE = "Long turn probe";
const BIG_TITLE = "Long conversation probe";

test.beforeAll(async () => {
	binDir = mkdtempSync(join(tmpdir(), "ompw-fake-omp-"));
	const bin = writeLongFakeOmp(binDir);
	s = await startTestServer(0, { OMP_BIN: bin });
	mkdirSync(s.work, { recursive: true });
	writeChatSession(s.agentDir, { n: 1, title: TITLE, cwd: s.work, turns: [{ prompt: "hello", reply: "hi" }] });
	const turns = Array.from({ length: 400 }, (_, i) => ({
		prompt: `question ${i}`,
		reply: `answer ${i} ${"word ".repeat(60)}`,
	}));
	writeChatSession(s.agentDir, { n: 2, title: BIG_TITLE, cwd: s.work, turns });
});
test.afterAll(async () => {
	await s?.stop();
	rmSync(binDir, { recursive: true, force: true });
});

const script = (o: Record<string, unknown>) =>
	`@@fake ${JSON.stringify({ steps: 150, stepMs: 30, textDeltas: 3, thinkingDeltas: 2, toolUpdates: 1, toolBytes: 300, ...o })}`;

async function open(page: Page, title: string): Promise<void> {
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const row = page.locator('[data-testid="session-item"]', { hasText: title });
	await expect(row).toHaveCount(1, { timeout: 30_000 });
	await row.click();
	await expect(page.getByTestId("composer")).toBeVisible();
}

async function run(page: Page, o: Record<string, unknown>): Promise<void> {
	const composer = page.getByTestId("composer");
	await composer.fill(script(o));
	await composer.press("Enter");
	await expect(page.getByTestId("stop")).toBeVisible({ timeout: 60_000 });
}

/** What the live turn has on screen: its rows (and the button above them), not counting what it streams at the end. */
const drawn = (page: Page) => page.locator('[data-testid="agent-turn"] > *').count();

test("a goal run of hundreds of steps draws a window of its rows, folds when it ends, and lets earlier steps be shown", async ({
	page,
}) => {
	await open(page, TITLE);
	await run(page, { steps: 200, stepMs: 25 });
	// While it runs: the rows on screen stay a few dozen however many steps there are (a step is two rows).
	let most = 0;
	let sawButton = false;
	await expect(async () => {
		most = Math.max(most, await drawn(page));
		sawButton ||= (await page.getByTestId("show-earlier-steps").count()) > 0;
		expect(await page.getByTestId("stop").count()).toBe(0);
	}).toPass({ timeout: 90_000, intervals: [100] });
	expect(sawButton).toBe(true);
	// Rows (< 120), the button, the typing dots and the stats line: nowhere near the 400 rows the run wrote.
	expect(most).toBeLessThan(130);

	// Over, the turn folds to its answer, as any finished turn does.
	await expect(page.getByTestId("work-summary")).toBeVisible();
	await expect(page.locator('[data-testid="agent-turn"] [data-testid="tool-card"]')).toHaveCount(0);

	// Opened, it is windowed too: the last rows, and a button for the earlier ones.
	await page.getByTestId("work-summary").click();
	const toolCards = page.locator('[data-testid="agent-turn"] [data-testid="tool-card"]');
	const before = await toolCards.count();
	expect(before).toBeGreaterThan(20);
	expect(before).toBeLessThan(120);
	const earlier = page.getByTestId("show-earlier-steps");
	await expect(earlier).toBeVisible();
	// Showing more adds rows above the reader without moving what is being read: the card that was first stays where it was.
	const scroller = page.getByTestId("transcript");
	await scroller.evaluate((el) => {
		el.scrollTop = el.scrollHeight / 2;
	});
	const offsetOf = (index: number) =>
		toolCards.nth(index).evaluate((el) => {
			const root = el.closest('[data-testid="transcript"]') as HTMLElement;
			return el.getBoundingClientRect().top - root.getBoundingClientRect().top;
		});
	const beforeClick = await offsetOf(0);
	// A click from the page itself: Playwright's would scroll the button into view first, and move what is measured.
	await earlier.evaluate((el) => (el as HTMLElement).click());
	await expect.poll(() => toolCards.count()).toBeGreaterThan(before);
	const added = (await toolCards.count()) - before;
	expect(Math.abs((await offsetOf(added)) - beforeClick)).toBeLessThan(3);
});

test("Stop answers at once in the middle of a long run, and the next message goes through", async ({ page }) => {
	await open(page, TITLE);
	await run(page, { steps: 600, stepMs: 30 });
	// Well into it.
	await expect
		.poll(() => page.locator('[data-testid="msg-assistant"]').count(), { timeout: 60_000 })
		.toBeGreaterThan(40);
	const stopped = Date.now();
	await page.getByTestId("stop").click();
	await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 5000 });
	expect(Date.now() - stopped).toBeLessThan(5000);
	// Sending is possible again, and the page waits for nothing.
	const composer = page.getByTestId("composer");
	await composer.fill(script({ steps: 1 }));
	await page.getByTestId("send").click();
	await expect(page.getByText(/Working…/)).toHaveCount(0, { timeout: 10_000 });
	await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 30_000 });
});

test("an omp started on a long conversation the page already shows is not sent the whole of it again", async ({
	page,
}) => {
	const tap = await tapSocket(page);
	await open(page, BIG_TITLE);
	await run(page, { steps: 6, stepMs: 300 });
	await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 30_000 });
	// The process of this conversation (the new-chat page starts one of its own, which is empty).
	const liveId = tap.sent.find((m) => m.t === "rpc" && m.command?.type === "prompt")?.liveId;
	const pulls = tap.sent.filter((m) => m.t === "rpc" && m.liveId === liveId && m.command?.type === "get_entries");
	expect(pulls.length).toBeGreaterThan(0);
	// Every pull continues from the last entry of the file the page fetched (its 400th reply); none asks for it all.
	for (const pull of pulls) expect(pull.command?.since).toBeDefined();
	expect(pulls[0].command?.since).toBe("t399r");
});
