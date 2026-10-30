import type { SessionEntry } from "../../shared/protocol.ts";
import { ownSession, startLive } from "../support/live.ts";
import { assistant, result, user } from "../support/session-entries.ts";
import { type Command, type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * A finished turn folds its steps behind "Worked for … · N tool calls". A reader who scrolled up into the steps while the
 * turn ran must not lose the card they were on at the moment it ends: the turn stays open for them until they reach the
 * end, ask for the latest messages, or fold it. A reader who follows the end sees it fold, as before. Frames are
 * injected and the entries answered by the spec: no model runs.
 */

const STEPS = 5;
const BASE = "base";

/** The conversation omp saves while the turn runs: a prompt, `STEPS` tall steps that each call a tool, and the answer. */
function conversation(): SessionEntry[] {
	const entries: SessionEntry[] = [user("fold-u", BASE, 1, "Do the long job")];
	for (let i = 1; i <= STEPS; i++) {
		const parent = entries.at(-1)?.id ?? BASE;
		const lines = Array.from({ length: 14 }, (_, k) => `Step ${i} note ${k + 1}: what this part of the job found.`);
		entries.push(
			assistant(`fold-a${i}`, parent, 2 * i, { text: lines.join("\n\n"), calls: { [`fold-t${i}`]: "bash" } }),
			result(`fold-r${i}`, `fold-a${i}`, 2 * i + 1, `fold-t${i}`, `done ${i}`),
		);
	}
	entries.push(assistant("fold-final", `fold-r${STEPS}`, 2 * STEPS + 2, { text: "Everything is done." }));
	return entries;
}

/** Open a conversation, then let omp save the turn's entries one step at a time. */
async function runTurn(page: Page, tap: SocketTap, liveId: string) {
	const all = conversation();
	let released = 0;
	let base: string | null = null;
	tap.answer("get_entries", (command: Command) => {
		if (!released) return undefined;
		const since = typeof command.since === "string" ? command.since : null;
		base ??= since;
		const saved = all.slice(0, released).map((e) => (e.parentId === BASE ? { ...e, parentId: base } : e));
		const from = saved.findIndex((e) => e.id === since) + 1;
		return { ok: true, data: { entries: saved.slice(from), leafId: saved.at(-1)?.id } };
	});
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const save = (count: number) => {
		released = count;
		frame({ type: "message_end", messageId: `m-${count}`, message: { role: "assistant", content: [] } });
	};
	frame({ type: "agent_start" });
	save(1);
	await expect(page.getByText("Do the long job")).toBeVisible();
	for (let i = 1; i <= STEPS; i++) {
		save(1 + 2 * i);
		await expect(page.locator('[data-testid="tool-card"]', { hasText: `run fold-t${i}` })).toHaveCount(1);
	}
	save(all.length);
	await expect(page.getByText("Everything is done.")).toBeVisible();
	return { frame, card: (i: number) => page.locator('[data-testid="tool-card"]', { hasText: `run fold-t${i}` }) };
}

async function open(page: Page, n: number, title: string) {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	tap.answer("prompt", () => ({ ok: true, data: { agentInvoked: true } }));
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `fold-probe-${n}`);
	return { tap, liveId };
}

const summary = (page: Page) => page.getByTestId("work-summary");
const scroller = (page: Page) => page.getByTestId("transcript");

/** The reader turns the wheel until the card is about 40 px below the top of the view. */
async function readTo(page: Page, card: Locator): Promise<void> {
	const offset = () =>
		card.evaluate((el) => {
			const view = el.closest('[data-testid="transcript"]');
			return el.getBoundingClientRect().top - (view?.getBoundingClientRect().top ?? 0);
		});
	await scroller(page).hover();
	await page.mouse.wheel(0, (await offset()) - 40);
	await expect.poll(offset).toBeLessThan(60);
}

test("a turn that ends under a reader who scrolled up into it stays open: the card they read does not move", async ({
	page,
}) => {
	const { tap, liveId } = await open(page, 0x92, "Fold reader probe");
	const { frame, card } = await runTurn(page, tap, liveId);

	// The reader scrolls up until the second step's card is near the top of the view; the arrow says they left the end.
	const second = card(2);
	await readTo(page, second);
	await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();
	const handle = await second.elementHandle();
	if (!handle) throw new Error("no card");
	const place = () =>
		handle.evaluate((el) => {
			const view = el.closest('[data-testid="transcript"]');
			return {
				attached: el.isConnected,
				top: Math.round(el.getBoundingClientRect().top - (view?.getBoundingClientRect().top ?? 0)),
				scrollTop: Math.round(view?.scrollTop ?? -1),
			};
		});
	const before = await place();
	expect(before.attached).toBe(true);
	expect(before.top).toBeGreaterThan(30);
	expect(before.top).toBeLessThan(50);

	frame({ type: "agent_end" });
	await expect(summary(page)).toHaveAttribute("aria-expanded", "true");
	await page.waitForTimeout(500);
	// The steps are still there and the card is where it was in the view: the summary row that appears above the steps moves
	// the page (the scroll position follows it), not the reader's place.
	const after = await place();
	expect(after.attached).toBe(true);
	expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(4);
	await expect(card(2)).toBeVisible();

	// Reaching the end folds it, as it does for a reader who was there all along.
	await scroller(page).evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await expect(summary(page)).toHaveAttribute("aria-expanded", "false");
	await expect(card(2)).toHaveCount(0);
	await expect(page.getByText("Everything is done.")).toBeVisible();
});

test("a reader a little short of the end when the turn ends is not at it: the turn stays open for them too", async ({
	page,
}) => {
	const { tap, liveId } = await open(page, 0x95, "Fold near probe");
	const { frame, card } = await runTurn(page, tap, liveId);
	// Up by 40 px with the wheel: well within 80 px of the end, and the reader has left it (the arrow says so).
	await scroller(page).hover();
	await page.mouse.wheel(0, -40);
	await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();
	const gap = () => scroller(page).evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
	expect(await gap()).toBeGreaterThan(20);
	expect(await gap()).toBeLessThan(80);

	frame({ type: "agent_end" });
	await expect(summary(page)).toHaveAttribute("aria-expanded", "true");
	await page.waitForTimeout(500);
	// Still open, and not thrown to the end of the folded turn.
	await expect(summary(page)).toHaveAttribute("aria-expanded", "true");
	await expect(card(5)).toBeAttached();

	// Reaching the end folds it.
	await scroller(page).evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await expect(summary(page)).toHaveAttribute("aria-expanded", "false");
});

test("a reader who follows the end sees the turn fold when it ends", async ({ page }) => {
	const { tap, liveId } = await open(page, 0x93, "Fold follower probe");
	const { frame, card } = await runTurn(page, tap, liveId);
	await expect(page.getByRole("button", { name: "Scroll to bottom" })).toHaveCount(0);
	frame({ type: "agent_end" });
	await expect(summary(page)).toHaveAttribute("aria-expanded", "false");
	await expect(card(2)).toHaveCount(0);
});

test("sending a message folds the turn that was held open", async ({ page }) => {
	const { tap, liveId } = await open(page, 0x94, "Fold send probe");
	const { frame, card } = await runTurn(page, tap, liveId);
	await readTo(page, card(2));
	await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();
	frame({ type: "agent_end" });
	await expect(summary(page)).toHaveAttribute("aria-expanded", "true");

	const composer = page.getByTestId("composer");
	await composer.fill("and now the next thing");
	await composer.press("Enter");
	await expect(summary(page)).toHaveAttribute("aria-expanded", "false");
	await expect(card(2)).toHaveCount(0);
});
