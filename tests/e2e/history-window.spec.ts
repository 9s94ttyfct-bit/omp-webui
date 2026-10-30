import { realpathSync, rmSync } from "node:fs";
import { appReady } from "../support/live.ts";
import {
	answerText,
	type LongConversation,
	promptText,
	writeFork,
	writeLongConversation,
} from "../support/long-history.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A long conversation opens on its latest part and brings earlier history in as the reader goes there (#590): the page
 * asks for the end of the path, then for the page above as the reader scrolls up, the window around a search hit, the
 * page below it; a fork's other versions come with the page that holds the fork point; a process that starts on the
 * conversation continues from what the page holds. No model call: the conversations are files.
 */

const TURNS = 300;
const SOURCE = "01a00000-0000-7000-8000-00000000fe10";
const NEAR_FORK = "01a00000-0000-7000-8000-00000000fe11";
const FAR_FORK = "01a00000-0000-7000-8000-00000000fe12";
const NEEDLE_TURN = 3;
const NEEDLE = "zephyr-needle";

let agentDir: string;
let source: LongConversation;
let nearFork: LongConversation;
let farFork: LongConversation;
const created: string[] = [];

test.beforeAll(() => {
	agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	source = writeLongConversation(agentDir, {
		id: SOURCE,
		turns: TURNS,
		title: "History window source",
		prompt: (t) => (t === NEEDLE_TURN ? `Where is the ${NEEDLE} in turn ${t}?` : promptText(t)),
	});
	// A fork near the end (its fork point is in the window the conversation opens on) and one far back (it is not).
	nearFork = writeFork(agentDir, source, {
		id: NEAR_FORK,
		atTurn: TURNS - 5,
		text: "Near fork: a different question",
		reply: "Near fork reply.",
		title: "History window near fork",
	});
	farFork = writeFork(agentDir, source, {
		id: FAR_FORK,
		atTurn: 10,
		text: "Far fork: a different question",
		reply: "Far fork reply.",
		title: "History window far fork",
	});
	created.push(source.file, nearFork.file, farFork.file);
});
test.afterAll(() => {
	for (const f of created) rmSync(f, { force: true });
});

const urlOf = (c: LongConversation) => `/#/s/${encodeURIComponent(realpathSync(c.file))}`;

/** What the page asks `/api/family` for, by view (`whole` for a request without one). */
function watchFamily(page: Page) {
	const views: { view: string; at: string | null }[] = [];
	page.on("request", (r) => {
		const u = new URL(r.url());
		if (u.pathname === "/api/family")
			views.push({ view: u.searchParams.get("view") ?? "whole", at: u.searchParams.get("at") });
	});
	return {
		views,
		count: (view: string) => views.filter((v) => v.view === view).length,
	};
}

test("a long conversation opens on its latest part, from a window of its history and not the whole of it", async ({
	page,
}) => {
	const family = watchFamily(page);
	const bodies: number[] = [];
	page.on("response", async (res) => {
		const u = new URL(res.url());
		if (u.pathname === "/api/family" && u.searchParams.get("view") === "tail") bodies.push((await res.body()).length);
	});
	await page.goto(urlOf(source));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(TURNS - 1))).toBeVisible();
	// The end is there; the start and the way to it are not asked for until the reader goes there.
	await expect(transcript.getByText(promptText(0), { exact: false })).toHaveCount(0);
	await expect(page.getByTestId("show-earlier")).toBeVisible();
	expect(family.count("whole")).toBe(0);
	expect(family.count("tail")).toBe(1);
	expect(family.count("before")).toBe(0);
	// A window, not 1,200 entries: well under the whole file's size.
	expect(bodies[0]).toBeLessThan(400_000);
	// What adds up the whole file is asked for apart, and the header has it: 300 turns of two requests at $0.0001.
	await expect(page.getByTestId("session-cost")).toContainText("0.06");
	const elements = await transcript.evaluate((el) => el.getElementsByTagName("*").length);
	expect(elements).toBeLessThan(2500);
});

test("scrolling up reveals what is held and then asks for the page above, without moving what is being read", async ({
	page,
}) => {
	const family = watchFamily(page);
	await page.goto(urlOf(source));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(TURNS - 1))).toBeVisible();
	// The page only brings more in for a reader who scrolls by hand: one nudge says so.
	await transcript.hover();
	await page.mouse.wheel(0, -40);
	// Each round the reader is put at the top of what is drawn; the first message in view is where it was once the ones above it are.
	let pages = 0;
	let moves: { round: number; held: number; moved: number }[] = [];
	for (let round = 0; round < 40 && pages < 2; round++) {
		const result = await transcript.evaluate(async (el) => {
			const offset = (segment: Element) =>
				Math.round(segment.getBoundingClientRect().top - el.getBoundingClientRect().top);
			const count = () => el.querySelectorAll("[data-segment]").length;
			el.scrollTop = 0;
			// The reader's hand is on the scroll (the page holds that for a couple of seconds after the last wheel).
			el.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
			const first = el.querySelector("[data-segment]");
			if (!first) return null;
			const held = count();
			const before = offset(first);
			const started = performance.now();
			while (count() === held && performance.now() - started < 20_000)
				await new Promise((r) => requestAnimationFrame(r));
			// Let the layout settle: the scroll that keeps the reader in place is made with the new messages.
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			return { held, grew: count() - held, moved: Math.abs(offset(first) - before) };
		});
		expect(result, `round ${round}`).not.toBeNull();
		expect(result?.grew, `round ${round} brought nothing in`).toBeGreaterThan(0);
		moves = [...moves, { round, held: result?.held ?? 0, moved: result?.moved ?? 0 }];
		// The message the reader was on is where it was (a few pixels for the scrollbar's rounding), through reveals and pages alike.
		expect(result?.moved, `round ${round}`).toBeLessThanOrEqual(4);
		pages = family.count("before");
	}
	expect(pages, JSON.stringify(moves)).toBeGreaterThanOrEqual(2);
	// What came is the conversation just above, in order: no turn is missing between the pages.
	// (textContent: the browser leaves the pages that are off screen unpainted, and innerText with them.)
	const prompts = await transcript
		.locator('[data-testid="msg-user"]')
		.evaluateAll((els) => els.map((e) => e.textContent ?? ""));
	const turns = prompts.map((p) => Number(/turn (\d+)/.exec(p)?.[1])).filter((n) => Number.isFinite(n));
	expect(turns.length).toBeGreaterThan(60);
	for (let i = 1; i < turns.length; i++) expect(turns[i]).toBe((turns[i - 1] as number) + 1);
});

test("Go to the first message brings the whole way in, and the first message is the conversation's first", async ({
	page,
}) => {
	const family = watchFamily(page);
	await page.goto(urlOf(source));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(TURNS - 1))).toBeVisible();
	await page.getByTestId("show-first").click();
	await expect(transcript.getByText(promptText(0))).toBeVisible();
	await expect(page.getByTestId("show-earlier")).toHaveCount(0);
	// 1,200 entries in pages of a window each: more than one page was asked for, none of them the whole.
	expect(family.count("before")).toBeGreaterThan(2);
	expect(family.count("whole")).toBe(0);
});

test("a search hit far back opens the window around it, Show later messages goes on from it, and the latest is one click away", async ({
	page,
}) => {
	const family = watchFamily(page);
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill(NEEDLE);
	// The fork files copy the conversation up to their fork point, the prompt with the needle in it too: the hit is the source's.
	const hit = page.getByTestId("search-hit").filter({ hasText: "History window source" }).first();
	await expect(hit).toContainText(NEEDLE);
	await hit.click();
	const target = page.locator(`[data-entry-id="u${NEEDLE_TURN}"]`);
	await expect(target).toHaveAttribute("data-focused", "true");
	await expect(target).toBeInViewport();
	// The window around it, not the conversation and not its end first: the first thing asked for is the hit's window.
	expect(family.views.filter((v) => v.view !== "stats").map((v) => `${v.view}:${v.at}`)).toEqual([
		`around:u${NEEDLE_TURN}`,
	]);
	expect(family.count("whole")).toBe(0);
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(TURNS - 1))).toHaveCount(0);
	// The messages between are not mounted at once: more come as the reader asks, and the page below is brought in when held ones run out.
	await expect(transcript.getByText(answerText(NEEDLE_TURN + 20))).toHaveCount(0);
	await page.getByTestId("show-later").click();
	await expect(transcript.getByText(answerText(NEEDLE_TURN + 20))).toHaveCount(1);
	// The latest is one click away: the end of the conversation takes the place of the window.
	await page.getByRole("button", { name: "Scroll to bottom" }).click();
	await expect(transcript.getByText(answerText(TURNS - 1))).toBeVisible();
	await expect(transcript.getByText(promptText(NEEDLE_TURN))).toHaveCount(0);
	await expect(page.getByTestId("show-later")).toHaveCount(0);
});

test("a fork whose fork point is in the window shows its versions at once, and switching opens the fork's own end", async ({
	page,
}) => {
	await page.goto(urlOf(source));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(TURNS - 1))).toBeVisible();
	const prompt = transcript.locator(`[data-entry-id="u${TURNS - 5}"]`);
	await prompt.scrollIntoViewIfNeeded();
	await prompt.hover();
	const nav = prompt.getByTestId("sibling-nav");
	await expect(nav).toContainText("1 / 2");
	await nav.getByRole("button", { name: /next/i }).click();
	// The fork is another file: its end (the fork's own prompt and reply) is on screen.
	await expect(transcript.getByText("Near fork reply.")).toBeVisible();
	await expect(transcript.getByText(answerText(TURNS - 1))).toHaveCount(0);
	await expect.poll(() => decodeURIComponent(page.url())).toContain(`${NEAR_FORK}`);
	// Back to the other version.
	const forked = transcript.locator(`[data-entry-id="v${TURNS - 5}"]`);
	await forked.hover();
	await forked
		.getByTestId("sibling-nav")
		.getByRole("button", { name: /previous/i })
		.click();
	await expect(transcript.getByText(answerText(TURNS - 1))).toBeVisible();
});

test("a fork point far back shows its versions when the page that holds it is loaded", async ({ page }) => {
	await page.goto(urlOf(source));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(TURNS - 1))).toBeVisible();
	// The fork point (turn 10) is not in what is held: no versions of it yet.
	await expect(transcript.locator('[data-entry-id="u10"]')).toHaveCount(0);
	await page.getByTestId("show-first").click();
	const prompt = transcript.locator('[data-entry-id="u10"]');
	await prompt.scrollIntoViewIfNeeded();
	await prompt.hover();
	await expect(prompt.getByTestId("sibling-nav")).toContainText("1 / 2");
	// The fork's own file, opened on its own: its end, with the path above it.
	await page.goto(urlOf(farFork));
	await expect(page.getByTestId("transcript").getByText("Far fork reply.")).toBeVisible();
	await expect(page.getByTestId("transcript").getByText(answerText(TURNS - 1))).toHaveCount(0);
});

test("a fork of a long conversation lists its family in the side panel, each with its last prompt and its size", async ({
	page,
}) => {
	await page.goto(urlOf(nearFork));
	await expect(page.getByTestId("transcript").getByText("Near fork reply.")).toBeVisible();
	await page.getByTestId("toggle-panel").click();
	await page.getByTestId("right-panel-tabs").getByTestId("pane-tab-tree").click();
	const list = page.getByTestId("branch-list");
	await expect(list.getByRole("button")).toHaveCount(3);
	await expect(list).toContainText("Near fork: a different question");
	await expect(list).toContainText("Far fork: a different question");
	await expect(list).toContainText(promptText(TURNS - 1));
	// The number of entries is the file's, not the stretch held.
	await expect(list).toContainText(/1200 entries|1,200 entries/);
});

test("a process started on a conversation of which the page holds the end continues from it, and earlier pages still come", async ({
	page,
}) => {
	const tap = await tapSocket(page);
	const family = watchFamily(page);
	await page.goto(urlOf(source));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(TURNS - 1))).toBeVisible();
	// A `!command` starts the conversation's omp without calling a model.
	await page.getByTestId("composer").fill("!echo live-after-tail-$((6*7))");
	await page.getByTestId("composer").press("Enter");
	await expect(transcript.getByText("live-after-tail-42")).toBeVisible({ timeout: 30_000 });
	// omp was asked for what came after the last entry the page held, not for everything it has.
	const asks = tap.commands("get_entries");
	expect(asks.length).toBeGreaterThan(0);
	for (const ask of asks) expect(ask.since, JSON.stringify(ask)).toBeTruthy();
	// The end the page held is still one message each: the process's entries joined it, they did not repeat it.
	await expect(transcript.getByText(answerText(TURNS - 1))).toHaveCount(1);
	// And the history above is still there to bring in.
	await transcript.hover();
	await transcript.evaluate((el) => {
		el.scrollTop = 0;
	});
	await page.mouse.wheel(0, -40);
	await expect.poll(() => family.count("before"), { timeout: 30_000 }).toBeGreaterThan(0);
});
