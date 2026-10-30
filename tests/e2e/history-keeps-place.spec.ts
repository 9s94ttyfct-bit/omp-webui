import { realpathSync, rmSync } from "node:fs";
import { type LongTurns, longAnswer, writeLongTurns } from "../support/long-history.ts";
import { expect, type Locator, test } from "./fixtures.ts";

/**
 * Going up through earlier pages of a long conversation, by the wheel and by the keyboard, leaves the message the reader is
 * looking at where it is (#590): what is brought in above it, a page of history at a time, and whatever changes height above
 * it afterwards, does not move it. The message is the first one with any of it in the view; its place is taken when the
 * reader's scroll lands (before anything is brought in: the page's own `scroll` listener, ahead of the commit that shows the
 * messages above) and measured again once everything has settled, with a box put above the page meanwhile to stand for what
 * settles there (a block that is highlighted, a picture that came): the height that was added is not what is kept, the message is.
 */

// A key's scroll glides to its end over a few frames, and the first page that comes ends the glide where it is: the place the
// reader lands at is only there to be taken when the browser jumps (the wheel as the test sends it does).
test.use({ launchOptions: { args: ["--disable-smooth-scrolling"] } });

const SHORT_TURNS = 120;
let conversation: LongTurns;

test.beforeAll(() => {
	conversation = writeLongTurns(process.env.OMPW_E2E_AGENT_DIR as string, {
		id: "01a00000-0000-7000-8000-00000000fe50",
		// Short turns, and a long one in the middle that a window cuts.
		steps: [...Array.from({ length: 30 }, () => 1), 260, ...Array.from({ length: SHORT_TURNS }, () => 1)],
		title: "History keeps place",
	});
});
test.afterAll(() => {
	rmSync(conversation.file, { force: true });
});

const address = () => `/#/s/${encodeURIComponent(realpathSync(conversation.file))}`;
const LAST = 30 + SHORT_TURNS;

/** The first message with any of it in the view, and where its top is from the view's top. */
const firstInView = (transcript: Locator) =>
	transcript.evaluate((el) => {
		const top = el.getBoundingClientRect().top;
		for (const m of el.querySelectorAll<HTMLElement>("[data-entry-id]")) {
			const b = m.getBoundingClientRect();
			if (b.height > 0 && b.bottom > top + 1) return { id: m.dataset.entryId ?? "", at: b.top - top };
		}
		return null;
	});
/**
 * Takes the place of the first message in view when the reader lands at the top of what is held (the scroll lands before
 * the page shows what it brings; a key's scroll glides there over a few frames, and is not the place till it has arrived).
 */
const armPlace = (transcript: Locator) =>
	transcript.evaluate((el) => {
		const w = window as unknown as { __place?: { id: string; at: number } | null; __placeOff?: () => void };
		w.__placeOff?.();
		w.__place = null;
		const onScroll = () => {
			if (w.__place || el.scrollTop > 1) return;
			const top = el.getBoundingClientRect().top;
			for (const m of el.querySelectorAll<HTMLElement>("[data-entry-id]")) {
				const b = m.getBoundingClientRect();
				if (b.height > 0 && b.bottom > top + 1) {
					w.__place = { id: m.dataset.entryId ?? "", at: b.top - top };
					return;
				}
			}
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		w.__placeOff = () => el.removeEventListener("scroll", onScroll);
	});
const takePlace = (transcript: Locator) =>
	transcript.evaluate(() => (window as unknown as { __place?: { id: string; at: number } | null }).__place ?? null);
/** A box above the first page, as high as what settles there can be: a block highlighted, a picture that came. */
const settleAbove = (transcript: Locator, height: number) =>
	transcript.evaluate((el, h) => {
		const first = el.querySelector("[data-page]");
		const box = document.createElement("div");
		box.dataset.settle = "";
		box.style.height = `${h}px`;
		first?.parentElement?.insertBefore(box, first);
	}, height);
const settled = (transcript: Locator) =>
	transcript.evaluate((el) => {
		for (const box of el.querySelectorAll("[data-settle]")) box.remove();
	});
/** Where a message's top is from the view's top, or null when it is not drawn. */
const positionOf = (transcript: Locator, id: string) =>
	transcript.evaluate((el, wanted) => {
		const m = [...el.querySelectorAll<HTMLElement>("[data-entry-id]")].find((x) => x.dataset.entryId === wanted);
		return m ? m.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
	}, id);

for (const how of ["wheel", "keyboard"] as const) {
	test(`going up by the ${how} through several earlier pages keeps the message in view where it is`, async ({
		page,
	}) => {
		const asked: string[] = [];
		page.on("request", (r) => {
			const u = new URL(r.url());
			if (u.pathname === "/api/family") asked.push(u.searchParams.get("view") ?? "whole");
		});
		await page.goto(address());
		const transcript = page.getByTestId("transcript");
		await expect(transcript.getByText(longAnswer(LAST))).toBeVisible();
		await transcript.hover();
		if (how === "keyboard") await transcript.getByTestId("msg-user").last().click();
		const up = () => (how === "wheel" ? page.mouse.wheel(0, -100_000) : page.keyboard.press("Home"));
		const look = () => firstInView(transcript);
		const where = (id: string) => positionOf(transcript, id);
		let reached = 0;
		const moves: { id: string; moved: number | null; landed: boolean }[] = [];
		for (let round = 0; round < 40 && reached < 4; round++) {
			const before = asked.filter((v) => v === "before").length;
			await armPlace(transcript);
			await up();
			// The reader is at the top of what is held; a page above comes (or what is held is revealed): wait for it, then for what settles.
			await expect
				.poll(
					async () =>
						(await transcript.evaluate((el) => el.scrollTop)) > 0 ||
						asked.filter((v) => v === "before").length > before,
					{
						timeout: 5000,
					},
				)
				.toBe(true)
				.catch(() => {});
			await page.waitForTimeout(150);
			// Where the reader was when the scroll landed, before anything came above it (the scroll may not have happened at all).
			const landed = await takePlace(transcript);
			const start = landed ?? (await look());
			if (!start) continue;
			// What is above settles while the page may still be bringing in more above it.
			await settleAbove(transcript, 25 + round);
			await page.waitForTimeout(900);
			const now = await where(start.id);
			moves.push({ id: start.id, moved: now === null ? null : Math.round(now - start.at), landed: landed !== null });
			await settled(transcript);
			// (The page puts the place back for that too, and a scroll event follows: it is not the next round's.)
			await page.waitForTimeout(250);
			if (asked.filter((v) => v === "before").length > before) reached++;
		}
		expect(reached, JSON.stringify(moves)).toBeGreaterThanOrEqual(3);
		// The place was taken at the landing (before the history came) in rounds of its own, not only after it.
		expect(moves.filter((m) => m.landed).length, JSON.stringify(moves)).toBeGreaterThanOrEqual(2);
		// The message that was in view is where it was, to a few pixels, after every round.
		for (const m of moves)
			expect(m.moved === null ? 0 : Math.abs(m.moved), JSON.stringify(moves)).toBeLessThanOrEqual(4);
	});
}

test("what changes height above the reader after earlier history was put there does not move what they are reading", async ({
	page,
}) => {
	await page.goto(address());
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(longAnswer(LAST))).toBeVisible();
	await transcript.hover();
	const segments = transcript.locator("[data-segment]");
	const shown = await segments.count();
	await page.mouse.wheel(0, -100_000);
	// What is held above is revealed, and the message the reader was on is put back where it was.
	await expect.poll(() => segments.count()).toBeGreaterThan(shown);
	await page.waitForTimeout(100);
	const start = await firstInView(transcript);
	expect(start).not.toBeNull();
	// Then something above it settles: a block that is highlighted, a picture that came, a card that opened. (Here a box, put
	// above the first message: what the page does with the change is the same.)
	await transcript.evaluate((el) => {
		const first = el.querySelector("[data-page]");
		const spacer = document.createElement("div");
		spacer.style.height = "90px";
		first?.parentElement?.insertBefore(spacer, first);
	});
	await page.waitForTimeout(400);
	const moved = Math.round(((await positionOf(transcript, start?.id ?? "")) ?? Number.NaN) - (start?.at ?? 0));
	expect(Math.abs(moved), `moved ${moved}px`).toBeLessThanOrEqual(4);
});
