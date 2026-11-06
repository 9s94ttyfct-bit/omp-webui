import { realpathSync, rmSync } from "node:fs";
import type { Route } from "@playwright/test";
import { type LongTurns, longAnswer, longPrompt, writeLongTurns } from "../support/long-history.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A turn that runs long (a goal run, an autonomous task: hundreds of steps after one prompt) is longer than the window the
 * server answers, so a window cuts it, and the page above it joins the turn at its head: the turn the page held from its
 * middle is the same turn, longer. The page must not take that for a conversation that changed under it — it was once put
 * back on its latest messages, far from the reader — and the reader keeps their place through every page.
 */

const LONG_STEPS = 350;
const SHORT_TURNS = 80;
let conversation: LongTurns;

test.beforeAll(() => {
	conversation = writeLongTurns(process.env.OMPW_E2E_AGENT_DIR as string, {
		id: "01a00000-0000-7000-8000-00000000fe30",
		// The long turn first, then short ones: opening shows short turns, and going up arrives at the long one.
		steps: [LONG_STEPS, ...Array.from({ length: SHORT_TURNS }, () => 1)],
		title: "History long turns",
	});
});
test.afterAll(() => {
	rmSync(conversation.file, { force: true });
});

const address = () => `/#/s/${encodeURIComponent(realpathSync(conversation.file))}`;

test("going up through a turn longer than a window brings its steps in and never puts the reader back on the latest messages", async ({
	page,
}) => {
	const asked: string[] = [];
	const askedBefore = () => asked.filter((v) => v === "before").length;
	/** The pages above asked for and not answered yet. */
	let inFlight = 0;
	page.on("request", (r) => {
		const u = new URL(r.url());
		if (u.pathname !== "/api/family") return;
		const view = u.searchParams.get("view") ?? "whole";
		asked.push(view);
		if (view === "before") inFlight++;
	});
	const settled = (r: { url(): string }) => {
		const u = new URL(r.url());
		if (u.pathname === "/api/family" && u.searchParams.get("view") === "before") inFlight--;
	};
	page.on("requestfinished", settled);
	page.on("requestfailed", settled);
	// The pages above come after a little while (a link that is not this machine's), which here is when the round lets them
	// go: once it has looked at what is at the top while they are on their way, which is the block one that joins a turn at
	// its head joins, and where the reader is when it arrives.
	const held: Route[] = [];
	await page.route(/\/api\/family\?.*view=before/, (route) => {
		held.push(route);
	});
	await page.goto(address());
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(longAnswer(SHORT_TURNS))).toBeVisible();
	await transcript.hover();
	await page.mouse.wheel(0, -40);
	const order = new Map(conversation.path.map((id, i) => [id, i]));
	/** Whether an entry (or the segment it names) is of the long turn, `s0_<k>` or `r0_<k>`: a page that ends before one joins that turn. */
	const ofLongTurn = (id: string | null) => id !== null && /^[sr]0_/.test(id);
	/**
	 * The first segment on screen, where it is, and how many there are. `top` takes the reader to the top and tags the first
	 * segment with `mark` (what is measured is before anything the move brings in is drawn), `mark` tags it where it is (a
	 * segment can carry several tags); `mark` alone finds that element again, wherever it is now.
	 */
	const look = (mark: string | null, how: "top" | "mark" | "find" = "find") =>
		transcript.evaluate(
			(el, [tag, mode]) => {
				if (mode === "top") {
					el.scrollTop = 0;
					// The reader's hand is on the scroll (the page holds that for a couple of seconds after the last wheel).
					el.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
				}
				const segments = [...el.querySelectorAll<HTMLElement>("[data-segment]")];
				const first = segments[0];
				if (first && tag && mode !== "find") first.setAttribute(`data-at-${tag}`, "");
				const found = tag ? el.querySelector<HTMLElement>(`[data-at-${tag}]`) : first;
				const offset = found ? Math.round(found.getBoundingClientRect().top - el.getBoundingClientRect().top) : null;
				return {
					name: first?.dataset.segment ?? "",
					segments: segments.length,
					top: offset,
					markedIsFirst: found === first,
				};
			},
			[mark, how] as const,
		);
	let previous = Number.POSITIVE_INFINITY;
	let inTurn = false;
	/** Rounds in which the long turn was at the top and a page joined it there: the block is the same, longer. */
	let joined = 0;
	const log: { round: number; first: string; segments: number; moved: number }[] = [];
	for (let round = 0; round < 80; round++) {
		const before = await look(`r${round}`, "top");
		const pages = askedBefore();
		// Something is brought in: more segments above, or a page asked for (which may join the turn at the top).
		await expect
			.poll(async () => (await look(null)).segments !== before.segments || askedBefore() !== pages || held.length > 0, {
				timeout: 4000,
			})
			.toBe(true)
			.catch(() => {});
		// The layout settles: the scroll that keeps the reader in place is made with what was shown.
		await page.waitForTimeout(300);
		// What is at the top while the pages are on their way, and whether one of them joins the long turn at its head.
		const coming = held.splice(0);
		const waiting = coming.length > 0 ? await look(`m${round}`, "mark") : null;
		const joining = coming.some((r) => ofLongTurn(new URL(r.request().url()).searchParams.get("at")));
		for (const r of coming) await r.continue();
		// They have arrived: none is on its way but one their arrival asked for, which the next round lets go.
		await expect.poll(() => inFlight === held.length, { timeout: 15_000 }).toBe(true);
		// The layout settles: the scroll that keeps the reader in place is made with the new messages.
		await page.waitForTimeout(300);
		const after = await look(`r${round}`);
		const now = await look(null);
		const at = order.get(now.name);
		expect(at, `round ${round}: ${now.name} is an entry of the path`).toBeDefined();
		const moved = after.top === null ? 0 : Math.abs(after.top - (before.top ?? 0));
		log.push({ round, first: now.name, segments: now.segments, moved });
		// The first message shown is never later in the conversation than the one before: nothing put the page back on the end.
		expect(at as number, JSON.stringify(log)).toBeLessThanOrEqual(previous);
		// What the reader was looking at is where it was, whether the page brought in new messages or joined the turn at the top.
		expect(moved, `round ${round}: ${JSON.stringify(log)}`).toBeLessThanOrEqual(4);
		if (ofLongTurn(now.name)) inTurn = true;
		if (waiting && joining && ofLongTurn(waiting.name)) {
			// The long turn was the block at the top when a page that joins it arrived: it is that block still, under its
			// name, where it was.
			const kept = await look(`m${round}`);
			const shift = kept.top === null ? 0 : Math.abs(kept.top - (waiting.top ?? 0));
			expect(shift, `round ${round}: the block the page joined moved: ${JSON.stringify(log)}`).toBeLessThanOrEqual(4);
			if (kept.markedIsFirst && kept.name === waiting.name) joined++;
		}
		// The top is reached when a round brought nothing: no segment, and no page asked for or let go.
		const ended = at === previous && now.segments === before.segments && askedBefore() === pages && coming.length === 0;
		previous = at as number;
		if (previous === 0 || ended) break;
	}
	expect(inTurn, `the long turn was reached: ${JSON.stringify(log)}`).toBe(true);
	// Pages were asked for while the reader was inside the long turn (700 entries: more than three windows).
	expect(askedBefore()).toBeGreaterThan(3);
	// A reader who only goes up is not brought the messages below them (the far end is let go of, and is not asked for again).
	expect(asked.filter((v) => v === "after").length, "pages below were asked for by a reader going up").toBe(0);
	expect(joined, "pages joined the long turn at its head, and it stayed the block the reader was at").toBeGreaterThan(
		0,
	);
	expect(asked).not.toContain("whole");
});

test("Go to the first message walks the whole way through a long turn to the conversation's first prompt", async ({
	page,
}) => {
	await page.goto(address());
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(longAnswer(SHORT_TURNS))).toBeVisible();
	await page.getByTestId("show-first").click();
	await expect(transcript.getByText(longPrompt(0))).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("show-earlier")).toHaveCount(0);
});
