import { en as guidance } from "../../web/src/i18n/guidance.ts";
import { openSidebar, ownSession, startLive } from "../support/live.ts";
import { topTab } from "../support/panel.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A card whose first read fails says what could not be read, why, and offers Try again: it neither turns its spinner for good
 * (#270: Full / Light, Semantic search, Browser) nor words the failed read as a write (#271: the quota floor's "Could not
 * change the floor", Model guidance's "Saving…"; #267: the Guidance tab's "Could not save"). The server is made to fail for
 * the one route of the card, and answers again after the first Try again.
 */

/** Answer `pattern` with a 500 while `failing.on` is true, and as the server does otherwise. */
async function failUntilRetried(page: Page, pattern: RegExp) {
	const failing = { on: true };
	await page.route(pattern, (route) =>
		failing.on ? route.fulfill({ status: 500, json: { error: "boom" } }) : route.continue(),
	);
	return failing;
}

test("Full / Light, the quota floor and Model guidance say they could not be read, and read again on Try again", async ({
	page,
}) => {
	const mode = await failUntilRetried(page, /\/api\/mode(\?|$)/);
	const floor = await failUntilRetried(page, /\/api\/quota-floor(\?|$)/);
	const templates = await failUntilRetried(page, /\/api\/model-guidance(\?|$)/);
	await page.goto("/#/settings/models");

	const modeCard = page.getByTestId("mode-settings");
	await expect(modeCard.getByTestId("load-error")).toContainText("Could not read Full / Light");
	await expect(modeCard.getByTestId("load-error")).toContainText("boom");
	const floorCard = page.getByTestId("quota-floor-settings");
	// A read, not a write: nothing here is "Could not change the floor".
	await expect(floorCard.getByTestId("load-error")).toContainText("Could not read the floors");
	await expect(floorCard).not.toContainText("Could not change the floor");
	const guidanceCard = page.getByTestId("guidance-settings");
	await expect(guidanceCard.getByTestId("load-error")).toContainText(guidance.loadFailedTitle);
	await expect(guidanceCard).not.toContainText(guidance.saving);

	mode.on = false;
	floor.on = false;
	templates.on = false;
	await modeCard.getByTestId("load-retry").click();
	await floorCard.getByTestId("load-retry").click();
	await guidanceCard.getByTestId("load-retry").click();
	await expect(modeCard.getByTestId("load-error")).toHaveCount(0);
	await expect(modeCard.getByRole("group", { name: "Mode of new conversations" })).toBeVisible();
	await expect(floorCard.getByTestId("load-error")).toHaveCount(0);
	await expect(guidanceCard.getByTestId("load-error")).toHaveCount(0);
	await expect(guidanceCard.getByTestId("guidance-templates")).toBeVisible();
});

test("Semantic search says its state could not be read, and reads it again on Try again", async ({ page }) => {
	const semantic = await failUntilRetried(page, /\/api\/semantic(\?|$)/);
	await page.goto("/#/settings/chats");
	const card = page.getByTestId("semantic-settings");
	await expect(card.getByTestId("load-error")).toContainText("Could not read the state of semantic search");
	await expect(card.getByTestId("load-error")).toContainText("boom");
	semantic.on = false;
	await card.getByTestId("load-retry").click();
	await expect(card.getByTestId("load-error")).toHaveCount(0);
	await expect(card.getByTestId("semantic-on").or(card.getByTestId("semantic-unsupported"))).toBeVisible();
});

test("the Browser card says its state could not be read, and reads it again on Try again", async ({ page }) => {
	// The socket would also tell the page the state (`browser_state`) as soon as it connects: only the read is under test.
	const tap = await tapSocket(page);
	tap.rewrite((msg) => (msg.t === "browser_state" ? { ...msg, t: "browser_state_unheard" } : msg));
	const browser = await failUntilRetried(page, /\/api\/browser(\?|$)/);
	await page.goto("/#/settings/app");
	const card = page.getByTestId("browser-settings");
	await expect(card.getByTestId("load-error")).toContainText("Could not read the browser's state");
	await expect(card.getByTestId("load-error")).toContainText("boom");
	browser.on = false;
	await card.getByTestId("load-retry").click();
	await expect(card.getByTestId("load-error")).toHaveCount(0);
});

test("the Guidance tab says it could not read the conversation's guidance, not that a save failed, and has Try again", async ({
	page,
}) => {
	ownSession(0x2670, "Guidance load failure 267");
	const tap = await tapSocket(page);
	const sessionRead = await failUntilRetried(page, /\/api\/model-guidance\/session\?/);
	await page.goto("/");
	await openSidebar(page);
	await startLive(page, tap, "Guidance load failure 267", "guidance-load-failure");
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Guidance/).click();
	const editor = page.getByTestId("guidance-editor");
	await expect(editor.getByTestId("load-error")).toContainText(guidance.loadFailedTitle);
	await expect(editor.getByTestId("load-error")).toContainText("boom");
	await expect(editor).not.toContainText("Could not save");
	sessionRead.on = false;
	await editor.getByTestId("load-retry").click();
	await expect(editor.getByTestId("guidance-template")).toBeVisible();
	await expect(editor.getByTestId("load-error")).toHaveCount(0);
});
