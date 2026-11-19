import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Close in Settings › Running sessions asks before it closes a conversation that works (#388): omp aborts its turn when
 * its stdin is closed (the reply and a running tool are cut), so a Close that only closed it lost the turn without a word.
 * An idle conversation closes at once (`idle.spec.ts`). No model is called: the turn is a pushed frame, and what the page
 * asked of the server is read off the socket.
 */

const TITLE = "Close working probe";

test("Close on a working conversation asks first: Cancel keeps it, the dialog's Close closes it", async ({ page }) => {
	ownSession(0x3880, TITLE);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, TITLE, "close-working-up");
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	await expect(page.getByTestId("stop")).toBeVisible();

	await page
		.getByRole("complementary")
		.getByRole("button", { name: /^Settings$/ })
		.click();
	await page.locator('[data-testid="settings-page-tab"][data-page="app"]').click();
	const row = page.locator('[data-testid="running-session"]', { hasText: TITLE });
	await expect(row.getByTestId("running-status")).toHaveText("working");
	const closes = () => tap.sent.filter((m) => m.t === "close" && m.liveId === liveId);

	const question = page.getByRole("dialog");
	await row.getByRole("button", { name: `Close ${TITLE}` }).click();
	await expect(question).toBeVisible();
	await expect(question).toContainText("stops its turn");
	expect(closes()).toEqual([]);
	await question.getByRole("button", { name: "Cancel" }).click();
	await expect(question).toBeHidden();
	expect(closes()).toEqual([]);
	await expect(row).toHaveCount(1);

	await row.getByRole("button", { name: `Close ${TITLE}` }).click();
	await question.getByTestId("confirm-close-working").click();
	await expect.poll(() => closes().length).toBe(1);
	await expect(row).toHaveCount(0, { timeout: 15_000 });
});
