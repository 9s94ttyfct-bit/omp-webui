import { realpathSync, rmSync } from "node:fs";
import { appReady } from "../support/live.ts";
import { answerText, type LongConversation, writeLongConversation } from "../support/long-history.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The header's cost of a long conversation says "≥" while it holds only a part of the file and has not the figures of the
 * whole one (#711). The figures are asked for once for the stretch the page holds; when the request fails, or the answer
 * ends at an entry the page does not hold (the file grew between its window and its figures), the chip used to stay at
 * "≥" until the stretch's last entry or size changed, which a running conversation's does not. It asks again now, after a
 * wait that grows. No model call: the conversations are files.
 */

const TURNS = 300;
const FAILED = "01a00000-0000-7000-8000-00000000fe7a";
const BEHIND = "01a00000-0000-7000-8000-00000000fe7b";

const made: LongConversation[] = [];
let failed: LongConversation;
let behind: LongConversation;

test.beforeAll(() => {
	const dir = process.env.OMPW_E2E_AGENT_DIR as string;
	const write = (id: string, title: string) => {
		const c = writeLongConversation(dir, { id, turns: TURNS, title });
		made.push(c);
		return c;
	};
	failed = write(FAILED, "Figures fail once");
	behind = write(BEHIND, "Figures ahead of the page");
});
test.afterAll(() => {
	for (const c of made) rmSync(c.file, { force: true });
});

const urlOf = (c: LongConversation) => `/#/s/${encodeURIComponent(realpathSync(c.file))}`;

/** The requests for the figures of the whole file (`view=stats`), counted. */
function countStats(page: Page) {
	const seen = { n: 0 };
	page.on("request", (r) => {
		const u = new URL(r.url());
		if (u.pathname === "/api/family" && u.searchParams.get("view") === "stats") seen.n++;
	});
	return seen;
}

test("the figures of the whole file that failed once are asked for again, and the header's cost becomes the file's", async ({
	page,
}) => {
	const stats = countStats(page);
	let answered = 0;
	await page.route(/\/api\/family\?.*view=stats/, async (route) => {
		if (answered++ === 0)
			return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
		return route.continue();
	});
	await page.goto(urlOf(failed));
	await appReady(page);
	await expect(page.getByTestId("transcript").getByText(answerText(TURNS - 1))).toBeVisible();
	const cost = page.getByTestId("session-cost");
	// The first answer was a failure: what is shown is the part held, and says so.
	await expect(cost).toHaveAttribute("data-partial", "");
	await expect(cost).toContainText("≥");
	// Nothing changed in the file and nothing in the page: it asks by itself, and the chip is the file's.
	await expect(cost).not.toHaveAttribute("data-partial", "", { timeout: 20_000 });
	await expect.poll(async () => Number(await cost.getAttribute("data-cost")), { timeout: 15_000 }).toBeCloseTo(0.06, 3);
	await expect(cost).not.toContainText("≥");
	expect(stats.n).toBeGreaterThanOrEqual(2);
});

test("figures that end at an entry the page does not hold are asked for again, and the header's cost becomes the file's", async ({
	page,
}) => {
	const stats = countStats(page);
	let answered = 0;
	await page.route(/\/api\/family\?.*view=stats/, async (route) => {
		if (answered++ > 0) return route.continue();
		// The file went on between the page's window and the server's figures: they end at an entry after the window's last.
		const real = await route.fetch();
		const doc = (await real.json()) as { stats: { through: string | null } };
		doc.stats.through = "an-entry-written-after-the-window";
		return route.fulfill({ response: real, json: doc });
	});
	await page.goto(urlOf(behind));
	await appReady(page);
	await expect(page.getByTestId("transcript").getByText(answerText(TURNS - 1))).toBeVisible();
	const cost = page.getByTestId("session-cost");
	await expect(cost).toHaveAttribute("data-partial", "");
	await expect(cost).not.toHaveAttribute("data-partial", "", { timeout: 20_000 });
	await expect.poll(async () => Number(await cost.getAttribute("data-cost")), { timeout: 15_000 }).toBeCloseTo(0.06, 3);
	expect(stats.n).toBeGreaterThanOrEqual(2);
});
