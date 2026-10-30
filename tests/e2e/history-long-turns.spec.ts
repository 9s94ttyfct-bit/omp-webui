import { realpathSync, rmSync } from "node:fs";
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
const PAGE_DELAY_MS = 1500;
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
	page.on("request", (r) => {
		const u = new URL(r.url());
		if (u.pathname === "/api/family") asked.push(u.searchParams.get("view") ?? "whole");
	});
	// The pages above come after a little while (a link that is not this machine's): the reader is at the top of what is held
	// when one arrives, which is when it matters where it goes.
	await page.route(/\/api\/family\?.*view=before/, async (route) => {
		await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
		await route.continue();
	});
	await page.goto(address());
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(longAnswer(SHORT_TURNS))).toBeVisible();
	await transcript.hover();
	await page.mouse.wheel(0, -40);
	const order = new Map(conversation.path.map((id, i) => [id, i]));
	/**
	 * The first segment on screen, where it is, and how many there are. `begin` takes the reader to the top and tags the
	 * first segment with `mark` first (what is measured is before anything the move brings in is drawn); `mark` alone finds that
	 * element again, wherever it is now.
	 */
	const look = (mark: string | null, begin = false) =>
		transcript.evaluate(
			(el, [tag, start]) => {
				if (start) {
					el.scrollTop = 0;
					// The reader's hand is on the scroll (the page holds that for a couple of seconds after the last wheel).
					el.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
				}
				const segments = [...el.querySelectorAll<HTMLElement>("[data-segment]")];
				const first = segments[0];
				if (first && tag && start) first.dataset.mark = tag;
				const found = tag ? el.querySelector<HTMLElement>(`[data-mark="${tag}"]`) : first;
				const offset = found ? Math.round(found.getBoundingClientRect().top - el.getBoundingClientRect().top) : null;
				return {
					name: first?.dataset.segment ?? "",
					segments: segments.length,
					top: offset,
					markedIsFirst: found === first,
				};
			},
			[mark, begin] as const,
		);
	let previous = Number.POSITIVE_INFINITY;
	let inTurn = false;
	/** Rounds in which the long turn was at the top and a page joined it there: the block is the same, longer. */
	let joined = 0;
	const log: { round: number; first: string; segments: number; moved: number }[] = [];
	for (let round = 0; round < 80; round++) {
		const before = await look(`r${round}`, true);
		const pages = asked.filter((v) => v === "before").length;
		// Something is brought in: more segments above, or a page (which may join the turn at the top).
		await expect
			.poll(
				async () =>
					(await look(null)).segments !== before.segments || asked.filter((v) => v === "before").length !== pages,
				{ timeout: 4000 },
			)
			.toBe(true)
			.catch(() => {});
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
		if (/^[sr]0_/.test(now.name)) inTurn = true;
		if (inTurn && after.markedIsFirst && asked.filter((v) => v === "before").length !== pages) joined++;
		const ended =
			at === previous && now.segments === before.segments && asked.filter((v) => v === "before").length === pages;
		previous = at as number;
		if (previous === 0 || ended) break;
	}
	expect(inTurn, `the long turn was reached: ${JSON.stringify(log)}`).toBe(true);
	// Pages were asked for while the reader was inside the long turn (700 entries: more than three windows).
	expect(asked.filter((v) => v === "before").length).toBeGreaterThan(3);
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
