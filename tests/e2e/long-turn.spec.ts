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

declare global {
	interface Window {
		/** What `watchRun` saw of the run, frame by frame. */
		__longRun?: { most: number; sawButton: boolean };
		/** When the page got the press on Stop, and drew the first frame without it (`timeStop`), on its own clock. */
		__stopTimes?: { pressed?: number; gone?: number };
	}
}

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
	// The conversation, not New chat's message box, which is on screen until the conversation's code has loaded. The page
	// opens on New chat, so a conversation's header is this one's.
	await expect(page.getByTestId("chat-title")).toBeVisible();
	await expect(page.getByTestId("composer")).toBeVisible();
}

async function run(page: Page, o: Record<string, unknown>): Promise<void> {
	const composer = page.getByTestId("composer");
	await composer.fill(script(o));
	await composer.press("Enter");
	await expect(page.getByTestId("stop")).toBeVisible({ timeout: 60_000 });
}

/**
 * What the live turn had on screen while the run went on, taken in the page on every frame it draws: the most rows it
 * had (what it streams at the end included, and the button above them), and whether the button for the earlier
 * steps was up while Stop still was. A page busy with the stream answers each query from the test a second or two late
 * on a slow machine: sampled from the test, a run of a few seconds was looked at twice, once before the button came and
 * once after the turn had folded.
 */
async function watchRun(page: Page): Promise<() => Promise<{ most: number; sawButton: boolean }>> {
	await page.evaluate(() => {
		const seen = { most: 0, sawButton: false };
		window.__longRun = seen;
		const tick = () => {
			if (document.querySelector('[data-testid="stop"]')) {
				seen.most = Math.max(seen.most, document.querySelectorAll('[data-testid="agent-turn"] > *').length);
				seen.sawButton ||= document.querySelector('[data-testid="show-earlier-steps"]') !== null;
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	return () => page.evaluate(() => window.__longRun ?? { most: 0, sawButton: false });
}

/**
 * How long Stop took to go, from the press: both on the page's own clock, the press when the page got it and the end when
 * the page drew a frame without the button. Playwright's click spends seconds of its own on a page that is busy (each of
 * its checks waits its turn in the page), and that is not Stop's. Null until both have happened.
 */
async function timeStop(page: Page): Promise<() => Promise<number | null>> {
	await page.evaluate(() => {
		const times: { pressed?: number; gone?: number } = {};
		window.__stopTimes = times;
		document.addEventListener(
			"click",
			(e) => {
				if (e.target instanceof Element && e.target.closest('[data-testid="stop"]'))
					times.pressed ??= performance.now();
			},
			true,
		);
		const tick = () => {
			if (times.pressed !== undefined && !document.querySelector('[data-testid="stop"]')) {
				times.gone = performance.now();
				return;
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	return () =>
		page.evaluate(() => {
			const times = window.__stopTimes;
			return times?.pressed === undefined || times.gone === undefined ? null : times.gone - times.pressed;
		});
}

test("a goal run of hundreds of steps draws a window of its rows, folds when it ends, and lets earlier steps be shown", async ({
	page,
}) => {
	await open(page, TITLE);
	const seen = await watchRun(page);
	await run(page, { steps: 200, stepMs: 25 });
	// While it runs: the rows on screen stay a few dozen however many steps there are (a step is two rows).
	await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 90_000 });
	const { most, sawButton } = await seen();
	expect(sawButton, "the button for the earlier steps, while the run went on").toBe(true);
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
	// Paced at a rate the page keeps up with on a slow machine: a CI runner's page drew about 19 steps a second of this
	// script, and at 30 ms a step (33 a second) it was 7 s behind the run by the time Stop was pressed, so that what Stop
	// was timed against was a backlog of frames the run had sent long before, not the run.
	await run(page, { steps: 600, stepMs: 150 });
	// Well into it.
	await expect
		.poll(() => page.locator('[data-testid="msg-assistant"]').count(), { timeout: 60_000 })
		.toBeGreaterThan(40);
	const took = await timeStop(page);
	await page.getByTestId("stop").click();
	await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 15_000 });
	await expect.poll(took, { message: "the time from the press to Stop's end" }).not.toBeNull();
	expect(await took()).toBeLessThan(5000);
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
