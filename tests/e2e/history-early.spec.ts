import { realpathSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { answerText, type LongConversation, writeLongConversation } from "../support/long-history.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A conversation's end is asked for as early as the page knows which one it is (#590): by the document for a page opened on a
 * conversation's address, and by the click on a conversation in the list, before the code that shows it is loaded; and it is
 * asked for once, not again when the session list arrives while the answer is on its way. The code that is holding things
 * up is held back by the test (a route that answers late), so what the page asks for while it waits is what is measured.
 */

const SOURCE = "01a00000-0000-7000-8000-00000000fe20";
const TITLE = "History early conversation";
const TURNS = 80;
/** How long the code of the page, or the answer, is held back. */
const HOLD_MS = 1500;

let conversation: LongConversation;

test.beforeAll(() => {
	conversation = writeLongConversation(process.env.OMPW_E2E_AGENT_DIR as string, {
		id: SOURCE,
		turns: TURNS,
		title: TITLE,
	});
});
test.afterAll(() => {
	rmSync(conversation.file, { force: true });
});

const address = () => `/#/s/${encodeURIComponent(realpathSync(conversation.file))}`;

/** When each request for the conversation's end was made, in milliseconds on one clock. */
function tailRequests(page: Page): number[] {
	const times: number[] = [];
	page.on("request", (r) => {
		const u = new URL(r.url());
		if (u.pathname === "/api/family" && u.searchParams.get("view") === "tail") times.push(Date.now());
	});
	return times;
}

/** Answer the requests that match after `HOLD_MS`; the times each was let through at are returned. */
async function holdBack(page: Page, match: string | RegExp, ms = HOLD_MS): Promise<number[]> {
	const served: number[] = [];
	await page.route(match, async (route) => {
		await sleep(ms);
		served.push(Date.now());
		await route.continue();
	});
	return served;
}

test("a page opened on a conversation's address asks for its end before the application's code has arrived", async ({
	page,
}) => {
	const asked = tailRequests(page);
	const scripts = await holdBack(page, "**/assets/*.js");
	await page.goto(address(), { waitUntil: "commit" });
	await expect(page.getByTestId("transcript").getByText(answerText(TURNS - 1))).toBeVisible({ timeout: 30_000 });
	expect(asked.length, "the end is asked for once: the page takes what the document asked for").toBe(1);
	expect(scripts.length).toBeGreaterThan(0);
	// The application's own code was held for a second and a half; the end was on its way long before it was served.
	expect(asked[0] as number).toBeLessThan(Math.min(...scripts));
});

test("a page opened on a conversation's address fetches the code that shows it while the app finds out what to show", async ({
	page,
}) => {
	const chunks: number[] = [];
	page.on("request", (r) => {
		if (/\/assets\/ChatView-[^/]*\.js$/.test(new URL(r.url()).pathname)) chunks.push(Date.now());
	});
	// What the app asks first (is this the first run?) is answered late: the code of the conversation need not wait for it.
	const first = await holdBack(page, /\/api\/omp$/);
	await page.goto(address());
	await expect(page.getByTestId("transcript").getByText(answerText(TURNS - 1))).toBeVisible({ timeout: 30_000 });
	expect(first.length).toBeGreaterThan(0);
	expect(chunks.length).toBeGreaterThan(0);
	expect(chunks[0] as number).toBeLessThan(Math.min(...first));
});

test("a click on a conversation in the list asks for its end before the code that shows it is loaded", async ({
	page,
}) => {
	await page.goto("/");
	const row = page.locator('[data-testid="session-item"]', { hasText: TITLE }).first();
	await expect(row).toBeVisible();
	const asked = tailRequests(page);
	const chunks = await holdBack(page, "**/assets/ChatView-*.js");
	await row.click();
	await expect(page.getByTestId("transcript").getByText(answerText(TURNS - 1))).toBeVisible({ timeout: 30_000 });
	expect(asked.length, "the end is asked for once: the page takes what the click asked for").toBe(1);
	expect(chunks.length).toBeGreaterThan(0);
	expect(asked[0] as number).toBeLessThan(Math.min(...chunks));
});

test("the session list arriving while the end is on its way does not ask for the end again", async ({ page }) => {
	const asked = tailRequests(page);
	// The list comes after the page has asked for the end and before the end has come: what the page asks for is the same end.
	await holdBack(page, /\/api\/sessions/, HOLD_MS / 3);
	await holdBack(page, /\/api\/family\?.*view=tail/, HOLD_MS);
	await page.goto(address());
	await expect(page.getByTestId("transcript").getByText(answerText(TURNS - 1))).toBeVisible({ timeout: 30_000 });
	await sleep(500);
	expect(asked.length).toBe(1);
});
