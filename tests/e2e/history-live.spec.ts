import { realpathSync, rmSync } from "node:fs";
import { answerText, type LongConversation, promptText, writeLongConversation } from "../support/long-history.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A page that holds a window of a long conversation (#590) while a process runs on it: the process sends the end of the
 * file, which a window far from the end (a search hit, a reader who went up) does not contain. The window stays as the reader
 * has it, with what the process sends added to it: a transcript that blanks, or a hit asked for again without end, is the
 * page losing it. A command (`!echo`) starts the process; no model is called.
 */

const NEEDLE = "zephyr-needle";
const NEEDLE_TURN = 3;
const HIT = "01a00000-0000-7000-8000-00000000fe90";
const BACK = "01a00000-0000-7000-8000-00000000fe91";

const made: LongConversation[] = [];
let hit: LongConversation;
let back: LongConversation;

test.beforeAll(() => {
	const dir = process.env.OMPW_E2E_AGENT_DIR as string;
	const write = (id: string, title: string, turns: number, prompt?: (t: number) => string) => {
		const c = writeLongConversation(dir, { id, turns, title, prompt });
		made.push(c);
		return c;
	};
	hit = write(HIT, "Live hit", 300, (t) =>
		t === NEEDLE_TURN ? `Where is the ${NEEDLE} in turn ${t}?` : promptText(t),
	);
	back = write(BACK, "Live back", 700);
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
	return { count: (view: string) => views.filter((v) => v === view).length };
}

/** A process on the conversation: a command typed in it starts one; its output (the sum, not the command's own text) is on the page when it is up. */
async function startProcess(page: Page, said: string) {
	await page.getByTestId("composer").fill(`!echo ${said}-$((6*7))`);
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByTestId("transcript").getByText(`${said}-42`)).toBeVisible({ timeout: 30_000 });
}

test("a search hit far back is shown while a process runs on the conversation, and asked for once", async ({
	page,
}) => {
	const family = watchFamily(page);
	await page.goto(urlOf(hit));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(299))).toBeVisible();
	await startProcess(page, "live-hit-seen");
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill(NEEDLE);
	const row = page.getByTestId("search-hit").filter({ hasText: "Live hit" }).first();
	await expect(row).toContainText(NEEDLE);
	await row.click();
	const target = page.locator(`[data-entry-id="u${NEEDLE_TURN}"]`);
	await expect(target).toHaveAttribute("data-focused", "true");
	await expect(target).toBeInViewport();
	// Not a loop: the window around the hit was asked for once, and the page did not blank.
	await page.waitForTimeout(2500);
	expect(family.count("around")).toBeLessThan(3);
	expect(await transcript.locator("[data-segment]").count()).toBeGreaterThan(0);
});

test("a reader going up through more than the page keeps, with a process on the conversation, never loses the transcript", async ({
	page,
}) => {
	test.setTimeout(300_000);
	const family = watchFamily(page);
	await page.goto(urlOf(back));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answerText(699))).toBeVisible();
	await startProcess(page, "live-back-seen");
	await transcript.hover();
	await page.mouse.wheel(0, -40);
	const blank: number[] = [];
	// Up to the first message, through more pages than the page keeps (a page holds at most 1,200 entries, a page is about 200).
	for (let rounds = 0; rounds < 400 && (await page.getByTestId("show-earlier").count()) > 0; rounds++) {
		await page.mouse.wheel(0, -6000);
		await page.waitForTimeout(150);
		if ((await transcript.locator("[data-segment]").count()) === 0) blank.push(family.count("before"));
	}
	expect(family.count("before"), "the reader went up through more than the page keeps").toBeGreaterThanOrEqual(8);
	expect(blank, "the page was blank after these pages").toEqual([]);
	await expect(transcript.getByText(promptText(0))).toBeVisible();
	expect(await transcript.locator("[data-segment]").count()).toBeGreaterThan(0);
});
