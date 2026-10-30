import { realpathSync, rmSync } from "node:fs";
import { appReady } from "../support/live.ts";
import { type LongConversation, promptText, writeLongConversation, writeLongTurns } from "../support/long-history.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The direction gate of the transcript's edge loads (#590, `Transcript.tsx`, `hand-scroll.ts`): a hand that scrolls up brings
 * in what is above and not what is below, and the other way round.
 *
 * Other specs cannot see the gate: their windows mount more than a screen of messages, so only one end is ever near the view
 * and the direction never decides anything. Here the view is 6000 px tall and the window is a hit in the middle of a 300-turn
 * conversation, so both ends are inside the 600 px margin at once; whatever is brought in, and from which end, is the
 * direction's doing. Without the `heading() ===` line in `Transcript.tsx` the six directional tests fail (a wheel up brings in
 * the page below, a wheel down the page above).
 *
 * The last test is a reader who flicks down and then up within the time a hand is taken to be on the scroll, on a short page
 * whose top edge stays near the whole time: the observer reports an edge only when it enters or leaves the margin, so the
 * report that the gate threw away has to be made again when the hand reverses.
 */

const TURNS = 300;
const NEEDLE = "heading-needle";
const NEEDLE_TURN = 150;
const MIDDLE = "01a00000-0000-7000-8000-00000000fe81";
const SHORT = "01a00000-0000-7000-8000-00000000fe82";

let middle: LongConversation;
let short: LongConversation;

test.beforeAll(() => {
	const dir = process.env.OMPW_E2E_AGENT_DIR as string;
	middle = writeLongConversation(dir, {
		id: MIDDLE,
		turns: TURNS,
		title: "Heading middle",
		prompt: (t) => (t === NEEDLE_TURN ? `Where is the ${NEEDLE} in turn ${t}?` : promptText(t)),
	});
	// Turns of hundreds of steps: the window the conversation opens on is a few blocks, a short page with more above it.
	short = writeLongTurns(dir, { id: SHORT, steps: Array.from({ length: 8 }, () => 350), title: "Heading short" });
});
test.afterAll(() => {
	rmSync(middle.file, { force: true });
	rmSync(short.file, { force: true });
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

/** The names of the segments that are drawn, top to bottom. */
const drawn = (page: Page) =>
	page
		.getByTestId("transcript")
		.locator("[data-segment], [data-entry-id]")
		.evaluateAll((els) =>
			els.map((el) => (el as HTMLElement).dataset.segment ?? (el as HTMLElement).dataset.entryId ?? ""),
		);

/** A tall view with the window around a hit in it: everything that is drawn is near the view, both ends. */
async function openMiddle(page: Page) {
	await page.setViewportSize({ width: 1400, height: 6000 });
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill(NEEDLE);
	const hit = page.getByTestId("search-hit").filter({ hasText: "Heading middle" }).first();
	// The palette truncates the text.
	await expect(hit).toContainText("heading-ne");
	await hit.click();
	await expect(page.locator(`[data-entry-id="u${NEEDLE_TURN}"]`)).toHaveAttribute("data-focused", "true");
	await expect(page.getByTestId("show-earlier")).toBeVisible();
	await expect(page.getByTestId("show-later")).toBeVisible();
	// Both ends are near the view: nothing is brought in until a hand scrolls.
	await page.waitForTimeout(800);
	expect(await drawn(page)).not.toHaveLength(0);
}

/** A key with the focus on the page, as after a search: not a pointer press, which is "the scrollbar" and has no way. */
async function key(page: Page, name: string) {
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await page.keyboard.press(name);
}

/** One touch on the transcript that moves from `from` to `to` (client y) and lifts. */
async function finger(page: Page, from: number, to: number) {
	await page.getByTestId("transcript").evaluate(
		(el, [a, b]) => {
			const touch = (y: number) => new Touch({ identifier: 1, target: el, clientX: 400, clientY: y });
			const send = (type: string, y: number | null) =>
				el.dispatchEvent(
					new TouchEvent(type, {
						bubbles: true,
						cancelable: true,
						touches: y === null ? [] : [touch(y)],
						changedTouches: [touch(y ?? 0)],
					}),
				);
			send("touchstart", a as number);
			send("touchmove", ((a as number) + (b as number)) / 2);
			send("touchmove", b as number);
			send("touchend", null);
		},
		[from, to] as [number, number],
	);
}

const ways: { name: string; up: (page: Page) => Promise<void>; down: (page: Page) => Promise<void> }[] = [
	{
		name: "wheel",
		up: async (page) => {
			await page.getByTestId("transcript").hover();
			await page.mouse.wheel(0, -40);
		},
		down: async (page) => {
			await page.getByTestId("transcript").hover();
			await page.mouse.wheel(0, 40);
		},
	},
	{ name: "key", up: (page) => key(page, "PageUp"), down: (page) => key(page, "PageDown") },
	{
		name: "finger",
		// A finger that goes down the screen drags the content down: the reader goes toward the first messages.
		up: (page) => finger(page, 300, 420),
		down: (page) => finger(page, 420, 300),
	},
];

for (const way of ways) {
	test(`a ${way.name} going up brings in what is above and not what is below`, async ({ page }) => {
		const family = watchFamily(page);
		await openMiddle(page);
		const before = await drawn(page);
		await way.up(page);
		await expect
			.poll(async () => (await drawn(page))[0] !== before[0] || family.count("before") > 0, { timeout: 10_000 })
			.toBe(true);
		await page.waitForTimeout(1500);
		const after = await drawn(page);
		expect(after.at(-1), `${way.name}: what is below was brought in by a hand that goes up`).toBe(before.at(-1));
		expect(family.count("after")).toBe(0);
	});

	test(`a ${way.name} going down brings in what is below and not what is above`, async ({ page }) => {
		const family = watchFamily(page);
		await openMiddle(page);
		const before = await drawn(page);
		await way.down(page);
		await expect
			.poll(async () => (await drawn(page)).at(-1) !== before.at(-1) || family.count("after") > 0, { timeout: 10_000 })
			.toBe(true);
		await page.waitForTimeout(1500);
		const after = await drawn(page);
		expect(after[0], `${way.name}: what is above was brought in by a hand that goes down`).toBe(before[0]);
		expect(family.count("before")).toBe(0);
	});
}

test("control: a wheel going up on the short page asks for the page above", async ({ page }) => {
	const family = watchFamily(page);
	await page.goto(urlOf(short));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.locator("[data-segment]").first()).toBeVisible();
	await expect(page.getByTestId("show-earlier")).toBeVisible();
	await transcript.hover();
	await page.mouse.wheel(0, -120);
	await expect.poll(() => family.count("before"), { timeout: 2000 }).toBeGreaterThan(0);
});

test("a reader who flicks down on a short page and then goes up still gets what is above", async ({ page }) => {
	const family = watchFamily(page);
	await page.goto(urlOf(short));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.locator("[data-segment]").first()).toBeVisible();
	await expect(page.getByTestId("show-earlier")).toBeVisible();
	await transcript.hover();
	// Down first (nothing to scroll to: the end is shown), then up, within the time a hand is taken to be on the scroll.
	await page.mouse.wheel(0, 120);
	await page.waitForTimeout(300);
	await page.mouse.wheel(0, -120);
	await expect
		.poll(() => family.count("before"), {
			message: "the hand went up on a page whose top is near: the page above is asked for",
			timeout: 2000,
		})
		.toBeGreaterThan(0);
});
