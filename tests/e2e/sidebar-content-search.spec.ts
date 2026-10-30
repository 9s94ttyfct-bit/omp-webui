import { rmSync } from "node:fs";
import { writeChatSession } from "../support/chat-session.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The sidebar's search finds conversations by what was said in them (#717): name matches first, then the conversations
 * whose messages match, each with the line that matched, in a group of their own. A conversation matched both ways is
 * listed once, by its name; the archive view's search does not list what is outside it; a click opens the conversation at
 * the message. No model is called.
 */

const WORD = "zanzibarquill";
const mutating = { "x-omp-webui": "1" };

const sidebar = (page: Page) => page.getByRole("complementary");
const row = (page: Page, title: string) => sidebar(page).locator('[data-testid="session-item"]', { hasText: title });

function writeAll(agentDir: string): string[] {
	return [
		writeChatSession(agentDir, {
			n: 0xb1,
			title: "Pelican notes",
			turns: [{ prompt: "When does the ferry leave?", reply: `The ${WORD} departs at noon from the pier.` }],
		}),
		writeChatSession(agentDir, {
			n: 0xb2,
			title: `${WORD} planning`,
			turns: [{ prompt: "Plan it", reply: `Plan for ${WORD}: start early.` }],
		}),
		writeChatSession(agentDir, {
			n: 0xb3,
			title: "Archived gull log",
			turns: [{ prompt: "Log it", reply: `Logged the ${WORD} sighting.` }],
		}),
	];
}

test("content matches follow the name matches, once each, and open at the message", async ({ page }) => {
	const files = writeAll(process.env.OMPW_E2E_AGENT_DIR as string);
	try {
		await page.goto("/");
		await expect(row(page, "Pelican notes")).toHaveCount(1, { timeout: 15_000 });
		await page.getByTestId("session-filter").fill(WORD);

		const items = sidebar(page).locator('[data-testid="session-item"]');
		await expect(row(page, "Pelican notes")).toHaveCount(1);
		await expect(row(page, "Pelican notes").getByTestId("session-item-snippet")).toContainText(WORD);
		// Matched by its name and by what was said: listed once, as a name match (no line of a message under it).
		await expect(row(page, `${WORD} planning`)).toHaveCount(1);
		await expect(row(page, `${WORD} planning`).getByTestId("session-item-snippet")).toHaveCount(0);
		// Name matches come first, then the "In messages" group.
		const titles = await items.allTextContents();
		const named = titles.findIndex((t) => t.includes(`${WORD} planning`));
		const said = titles.findIndex((t) => t.includes("Pelican notes"));
		expect(named).toBeGreaterThanOrEqual(0);
		expect(said).toBeGreaterThan(named);
		await expect(sidebar(page).getByText("In messages", { exact: true })).toBeVisible();
		await expect(page.getByTestId("session-search-status")).toContainText("3 matches");

		await row(page, "Pelican notes").click();
		await expect(page.locator('[data-entry-id="t0r"]')).toHaveAttribute("data-focused", "true", { timeout: 15_000 });
	} finally {
		for (const f of files) rmSync(f, { force: true });
	}
});

test("the words of a query match in any order", async ({ page }) => {
	const files = writeAll(process.env.OMPW_E2E_AGENT_DIR as string);
	try {
		await page.goto("/");
		await expect(row(page, "Pelican notes")).toHaveCount(1, { timeout: 15_000 });
		await page.getByTestId("session-filter").fill(`noon ${WORD}`);
		// The message says the word before "noon": the query has them the other way round.
		await expect(row(page, "Pelican notes").getByTestId("session-item-snippet")).toContainText(WORD);
		// The other two say the word but not "noon".
		await expect(row(page, `${WORD} planning`)).toHaveCount(0);
		await expect(row(page, "Archived gull log")).toHaveCount(0);
	} finally {
		for (const f of files) rmSync(f, { force: true });
	}
});

test("a message search that fails says so, keeps the name matches, and Retry asks again", async ({ page }) => {
	const files = writeAll(process.env.OMPW_E2E_AGENT_DIR as string);
	try {
		let failing = true;
		await page.route("**/api/search?*", (route) =>
			failing ? route.fulfill({ status: 500, json: { error: "boom" } }) : route.continue(),
		);
		await page.goto("/");
		await expect(row(page, "Pelican notes")).toHaveCount(1, { timeout: 15_000 });
		await page.getByTestId("session-filter").fill(WORD);
		// Not "Searching messages…" for ever: the failure is said, and the name match is still listed.
		await expect(page.getByTestId("session-search-retry")).toBeVisible();
		await expect(page.getByTestId("session-search-pending")).toHaveCount(0);
		await expect(row(page, `${WORD} planning`)).toHaveCount(1);
		await expect(row(page, "Pelican notes")).toHaveCount(0);

		failing = false;
		await page.getByTestId("session-search-retry").click();
		await expect(row(page, "Pelican notes").getByTestId("session-item-snippet")).toContainText(WORD);
		await expect(page.getByTestId("session-search-retry")).toHaveCount(0);
	} finally {
		for (const f of files) rmSync(f, { force: true });
	}
});

test("the archive view's search lists no content match outside the archive", async ({ page }) => {
	const files = writeAll(process.env.OMPW_E2E_AGENT_DIR as string);
	const archived = files[2] as string;
	try {
		await page.goto("/");
		await expect(row(page, "Archived gull log")).toHaveCount(1, { timeout: 15_000 });
		await page.request.post("/api/archive", { data: { files: [archived], archived: true }, headers: mutating });
		await expect(row(page, "Archived gull log")).toHaveCount(0);

		await page.getByTestId("show-archived").click();
		await expect(row(page, "Archived gull log")).toHaveCount(1);
		await page.getByTestId("session-filter").fill(WORD);
		await expect(row(page, "Archived gull log").getByTestId("session-item-snippet")).toContainText(WORD);
		await expect(row(page, "Pelican notes")).toHaveCount(0);
		await expect(row(page, `${WORD} planning`)).toHaveCount(0);
	} finally {
		await page.request.post("/api/archive", { data: { files: [archived], archived: false }, headers: mutating });
		for (const f of files) rmSync(f, { force: true });
	}
});
