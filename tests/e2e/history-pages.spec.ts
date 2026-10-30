import { appendFileSync, realpathSync, rmSync } from "node:fs";
import { appReady } from "../support/live.ts";
import {
	answerText,
	type LongConversation,
	promptText,
	turnLines,
	writeLongConversation,
} from "../support/long-history.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The pages of a long conversation held by a page (#590) when things happen to them: the file grows under a reader who is
 * far from its end, "Go to the first message" is pressed while a page is on its way or twice, a page fails and the next
 * one comes, the figures of the whole file are late, the keyboard goes through the pages to the first message, and what is
 * held does not grow without end. No model call: the conversations are files.
 */

const TURNS = 300;
const LONG_TURNS = 700;
const NEEDLE = "quasar-needle";
const NEEDLE_TURN = 3;
const GROW = "01a00000-0000-7000-8000-00000000fe70";
const WALK = "01a00000-0000-7000-8000-00000000fe71";
const FAIL = "01a00000-0000-7000-8000-00000000fe72";
const LATE = "01a00000-0000-7000-8000-00000000fe73";
const KEYS = "01a00000-0000-7000-8000-00000000fe74";
const LONG = "01a00000-0000-7000-8000-00000000fe75";

const made: LongConversation[] = [];
let grow: LongConversation;
let walk: LongConversation;
let fail: LongConversation;
let late: LongConversation;
let keys: LongConversation;
let long: LongConversation;

test.beforeAll(() => {
	const dir = process.env.OMPW_E2E_AGENT_DIR as string;
	const write = (id: string, title: string, turns = TURNS, prompt?: (t: number) => string) => {
		const c = writeLongConversation(dir, { id, turns, title, prompt });
		made.push(c);
		return c;
	};
	grow = write(GROW, "Pages grow", TURNS, (t) =>
		t === NEEDLE_TURN ? `Where is the ${NEEDLE} in turn ${t}?` : promptText(t),
	);
	walk = write(WALK, "Pages walk");
	fail = write(FAIL, "Pages fail");
	late = write(LATE, "Pages late");
	keys = write(KEYS, "Pages keys");
	long = write(LONG, "Pages long", LONG_TURNS);
});
test.afterAll(() => {
	for (const c of made) rmSync(c.file, { force: true });
});

const urlOf = (c: LongConversation) => `/#/s/${encodeURIComponent(realpathSync(c.file))}`;

function watchFamily(page: Page) {
	const views: string[] = [];
	page.on("request", (r) => {
		const u = new URL(r.url());
		if (u.pathname === "/api/family") views.push(u.searchParams.get("view") ?? "whole");
	});
	return { views, count: (view: string) => views.filter((v) => v === view).length };
}

/** The reader goes up with the wheel until `enough()` is true. */
async function wheelUp(page: Page, enough: () => boolean, rounds = 80) {
	await page.getByTestId("transcript").hover();
	await page.mouse.wheel(0, -40);
	for (let i = 0; i < rounds && !enough(); i++) {
		await page.mouse.wheel(0, -4000);
		await page.waitForTimeout(120);
	}
}

test("a reader at a search hit far from the end stays there when the file grows (a terminal's omp writes to it)", async ({
	page,
}) => {
	const family = watchFamily(page);
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill(NEEDLE);
	const hit = page.getByTestId("search-hit").filter({ hasText: "Pages grow" }).first();
	await expect(hit).toContainText(NEEDLE);
	await hit.click();
	const target = page.locator(`[data-entry-id="u${NEEDLE_TURN}"]`);
	await expect(target).toHaveAttribute("data-focused", "true");
	await expect(target).toBeInViewport();
	const tails = family.count("tail");
	// Another process writes one more turn to the file; the page asks for the end of the file again.
	appendFileSync(
		grow.file,
		turnLines(TURNS, `a${TURNS - 1}y`)
			.lines.map((l) => `${JSON.stringify(l)}\n`)
			.join(""),
	);
	await expect.poll(() => family.count("tail"), { timeout: 30_000 }).toBeGreaterThan(tails);
	await page.waitForTimeout(1000);
	const transcript = page.getByTestId("transcript");
	// The reader was not taken from the hit to the end of the conversation.
	await expect(target).toHaveCount(1);
	await expect(target).toBeInViewport();
	await expect(transcript.getByText(answerText(TURNS))).toHaveCount(0);
	await expect(page.getByTestId("show-later")).toBeVisible();
	// The new turn is where it belongs: the end, one click away.
	await page.getByRole("button", { name: "Scroll to bottom" }).click();
	await expect(transcript.getByText(answerText(TURNS))).toBeVisible();
});

test("Go to the first message pressed while an earlier page is on its way goes on to the first message", async ({
	page,
}) => {
	const family = watchFamily(page);
	let held = 0;
	await page.route(/\/api\/family\?.*view=before/, async (route) => {
		// The first page is slow, so that the press comes while it is on its way.
		if (held++ === 0) await new Promise((r) => setTimeout(r, 3000));
		await route.continue();
	});
	await page.goto(urlOf(walk));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(TURNS - 1))).toBeVisible();
	await wheelUp(page, () => family.count("before") >= 1);
	expect(family.count("before")).toBe(1);
	await page.getByTestId("show-first").click();
	await expect(transcript.getByText(promptText(0))).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("show-earlier")).toHaveCount(0);
});

test("Go to the first message pressed twice while the walk goes on is one walk, and it shows that it is going", async ({
	page,
}) => {
	await page.route(/\/api\/family\?.*view=before/, async (route) => {
		await new Promise((r) => setTimeout(r, 250));
		await route.continue();
	});
	await page.goto(urlOf(walk));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(TURNS - 1))).toBeVisible();
	const first = page.getByTestId("show-first");
	await first.click();
	await expect(first).toHaveAttribute("aria-busy", "true");
	await page.waitForTimeout(400);
	await first.click({ timeout: 2000 });
	await expect(transcript.getByText(promptText(0))).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("show-earlier")).toHaveCount(0);
	await expect(page.getByTestId("show-first")).toHaveCount(0);
});

test("a page that failed does not leave the could-not-load banner up when the next one comes", async ({ page }) => {
	const family = watchFamily(page);
	let seen = 0;
	await page.route(/\/api\/family\?.*view=before/, async (route) => {
		if (seen++ === 0) return route.abort();
		return route.continue();
	});
	await page.goto(urlOf(fail));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(TURNS - 1))).toBeVisible();
	await wheelUp(page, () => family.count("before") >= 1);
	await expect(page.getByTestId("load-error")).toBeVisible();
	await wheelUp(page, () => family.count("before") >= 3);
	expect(family.count("before")).toBeGreaterThanOrEqual(3);
	await expect(page.getByTestId("load-error")).toHaveCount(0);
});

test("the header's cost says that it is only the part held until the figures of the whole file come, and when they do not", async ({
	page,
}) => {
	let answered = 0;
	await page.route(/\/api\/family\?.*view=stats/, async (route) => {
		answered++;
		await new Promise((r) => setTimeout(r, 1500));
		await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
	});
	await page.goto(urlOf(late));
	await expect(page.getByTestId("transcript").getByText(answerText(TURNS - 1))).toBeVisible();
	const cost = page.getByTestId("session-cost");
	await expect(cost).toHaveAttribute("data-partial", "");
	await expect(cost).toContainText("≥");
	await expect.poll(() => answered).toBeGreaterThan(0);
	await page.waitForTimeout(2500);
	// The figures did not come: it is still the part held, and says so.
	await expect(cost).toHaveAttribute("data-partial", "");
	await expect(cost).toContainText("≥");
});

test("the keyboard goes through the pages to the first message and the focus stays in the conversation", async ({
	page,
}) => {
	await page.goto(urlOf(keys));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(TURNS - 1))).toBeVisible();
	await page.getByTestId("show-earlier").focus();
	for (let presses = 0; presses < 200 && (await page.getByTestId("show-earlier").count()) > 0; presses++) {
		await page.keyboard.press("Enter");
		await page.waitForTimeout(120);
	}
	await expect(transcript.getByText(promptText(0))).toBeVisible();
	await expect(page.getByTestId("show-earlier")).toHaveCount(0);
	// Not on the page: on the message that is now first, where the next key goes on from.
	const where = await page.evaluate(() => {
		const el = document.activeElement;
		return { body: el === document.body, entry: el?.getAttribute("data-entry-id") ?? null };
	});
	expect(where).toEqual({ body: false, entry: "u0" });
});

test("a reader who goes up through more than the page keeps has the far end let go, and gets it back when they come down", async ({
	page,
}) => {
	const family = watchFamily(page);
	await page.goto(urlOf(long));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(LONG_TURNS - 1))).toBeVisible();
	await page.getByTestId("show-first").click();
	await expect(page.getByTestId("show-earlier")).toHaveCount(0, { timeout: 60_000 });
	await expect(transcript.getByText(promptText(0))).toBeVisible();
	const later = page.getByTestId("show-later");
	await expect(later).toBeVisible();
	// 2,800 entries are 1,400 messages; the page holds no more than 1,200 entries, 600 messages (a few more than are shown).
	const held = Number(/\((\d+)\)/.exec((await later.textContent()) ?? "")?.[1]);
	expect(held).toBeGreaterThan(400);
	expect(held).toBeLessThan(650);
	expect(family.count("after")).toBe(0);
	// Coming down: what was let go is asked for as the later pages are, and joins what is held.
	const turnPastTheEnd = 320;
	for (let n = 0; n < 80 && (await transcript.getByText(answerText(turnPastTheEnd)).count()) === 0; n++)
		await later.click();
	await expect(transcript.getByText(answerText(turnPastTheEnd))).toHaveCount(1);
	expect(family.count("after")).toBeGreaterThan(0);
	// The turns are in order, none missing between the first and the one past the cut.
	const prompts = await transcript
		.locator('[data-testid="msg-user"]')
		.evaluateAll((els) => els.map((e) => e.textContent ?? ""));
	const turns = prompts.map((p) => Number(/turn (\d+)/.exec(p)?.[1])).filter((n) => Number.isFinite(n));
	for (let i = 1; i < turns.length; i++) expect(turns[i]).toBe((turns[i - 1] as number) + 1);
});
