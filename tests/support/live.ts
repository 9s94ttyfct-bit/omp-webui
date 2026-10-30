import { expect, type Page } from "@playwright/test";
import { writeSimpleSession } from "./fixtures.ts";
import type { SocketTap } from "./socket-tap.ts";

/**
 * The sidebar row of a conversation, by its whole title. Not by a part of it: a worker's server keeps the conversations of
 * every spec that ran before, and `hasText` is a case-insensitive substring, so "Stop probe" also found "Paused stop probe".
 */
export const sessionRow = (page: Page, title: string) =>
	page.locator('[data-testid="session-item"]').filter({ has: page.getByText(title, { exact: true }) });

/**
 * Wait until the app is on screen and listening. `goto` returns at the load event, but the app mounts after its
 * language file has loaded, and shows only a spinner until the server has answered its first question
 * (`GET /api/omp`): a key pressed before that is lost, and `isVisible()` finds nothing yet. On a phone the sidebar
 * is behind a button, so that is what shows.
 */
export async function appReady(page: Page): Promise<void> {
	const reveal = page.getByRole("button", { name: /Show sidebar|显示侧边栏/ });
	await expect(reveal.or(page.getByTestId("session-list")).first()).toBeVisible();
}

/** Show the sidebar where it is behind a button (a phone), once the app is on screen. */
export async function openSidebar(page: Page): Promise<void> {
	await appReady(page);
	const reveal = page.getByRole("button", { name: /Show sidebar|显示侧边栏/ });
	if (await reveal.isVisible()) await reveal.click();
}

/**
 * Write a conversation of the spec's own, so specs that start omp on it never add entries to the shared
 * fixtures other specs read. `n` makes it unique (see `writeSimpleSession`); call before `page.goto`.
 */
export function ownSession(n: number, title: string): void {
	writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, n, title);
}

/**
 * Open a conversation and start its omp process without a model call (a `!command` only needs the
 * process), then return the id of the process the page itself started. `probe` is echoed, so the spec
 * can tell its own output apart; the id comes from the page's own command, not from `/api/lives`.
 */
export async function startLive(page: Page, tap: SocketTap, title: string, probe: string): Promise<string> {
	const row = sessionRow(page, title);
	await expect(row).toHaveCount(1, { timeout: 15_000 });
	await row.click();
	// The conversation is on screen before anything is typed. A click on its row changes the view at once, but the
	// conversation's code may still be on its way (the first one a page opens): until it is drawn, the message box on
	// screen is New chat's, which takes the command and keeps it as its draft (it has no omp of its own yet). Its header is
	// what shows it is drawn (New chat has none). Not its text: a spec that writes its file again under another title
	// (one per language) finds the title the conversation's omp still has. A tap on a phone can be lost (the drawer still
	// settling, the list sorted again under it): the drawer is then still open, and the row is tapped again.
	const header = page.getByTestId("chat-title");
	await expect(async () => {
		if (!(await header.isVisible())) await row.click({ timeout: 5_000 });
		await expect(header).toBeVisible({ timeout: 5_000 });
	}).toPass({ timeout: 30_000 });
	const composer = page.getByTestId("composer");
	await composer.fill(`!echo ${probe}`);
	await composer.press("Enter");
	await expect(page.getByText(probe, { exact: true })).toBeVisible({ timeout: 30_000 });
	const bash = tap.sent.findLast((m) => m.t === "rpc" && m.command?.type === "bash");
	if (typeof bash?.liveId !== "string") throw new Error("the page did not run the command");
	return bash.liveId;
}
