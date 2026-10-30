import { ownSession, startLive } from "../support/live.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * What omp waits on (a tool approval, a question, a goal proposal) is a card above the message box. A person who does
 * not look at the screen must be told, and one who types must not be interrupted. The requests arrive as pushed
 * frames, so no model is called.
 */

async function chat(page: Page, title: string, n: number): Promise<{ tap: SocketTap; liveId: string }> {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `requests-${n}`);
	return { tap, liveId };
}

/** omp asks before running a tool: a select titled `Allow tool: …`, the details on the lines after. */
const approval = (tap: SocketTap, liveId: string, id: string, tool: string) =>
	tap.push({
		t: "frame",
		liveId,
		frame: {
			type: "extension_ui_request",
			id,
			method: "select",
			title: `Allow tool: ${tool}\necho hi`,
			options: ["Allow once", "Deny"],
		},
	});

const card = (page: Page) => page.getByTestId("ui-request");
const announcement = (page: Page) => page.getByTestId("ui-request-announcement");

test("a request is announced assertively with its title, labels its dialog, and takes the keyboard from an empty message box", async ({
	page,
}) => {
	const { tap, liveId } = await chat(page, "Request focus probe", 0xc8);
	// Nothing to announce while nothing is asked, but the region is there already: that is what makes it speak later.
	await expect(announcement(page)).toHaveAttribute("aria-live", "assertive");
	await expect(announcement(page)).toBeEmpty();
	await expect(page.getByTestId("composer")).toBeFocused();

	approval(tap, liveId, "ui-1", "bash");
	await expect(card(page)).toBeVisible();
	await expect(announcement(page)).toHaveText("omp is waiting for you: Allow tool: bash");
	// The dialog is named by its own heading, not by a copy of the text.
	const labelledBy = await card(page).getAttribute("aria-labelledby");
	expect(labelledBy).toBeTruthy();
	expect(await page.evaluate((id) => document.getElementById(id as string)?.textContent, labelledBy)).toBe(
		"Allow tool: bash",
	);
	await expect(page.getByRole("dialog", { name: "Allow tool: bash" })).toBeVisible();
	// The keyboard is on the card, and the first Tab reaches its first choice.
	await expect(card(page)).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(page.getByRole("button", { name: /Allow once/ })).toBeFocused();

	// Answered from the keyboard: the card goes, and the keyboard goes back to the message box.
	await page.keyboard.press("Enter");
	await expect(card(page)).toHaveCount(0);
	await expect(announcement(page)).toBeEmpty();
	await expect(page.getByTestId("composer")).toBeFocused();
	expect(tap.sent.filter((m) => m.t === "ui_response")).toHaveLength(1);
});

test("typed text is never interrupted: the request is announced but the cursor stays in the message box", async ({
	page,
}) => {
	const { tap, liveId } = await chat(page, "Request typing probe", 0xc9);
	const composer = page.getByTestId("composer");
	await composer.click();
	await composer.fill("half a sentence");
	approval(tap, liveId, "ui-1", "write");
	await expect(card(page)).toBeVisible();
	await expect(announcement(page)).toHaveText("omp is waiting for you: Allow tool: write");
	await expect(composer).toBeFocused();
	await page.keyboard.type(" and the rest");
	await expect(composer).toHaveValue("half a sentence and the rest");
	await expect(card(page)).not.toBeFocused();

	// A request that is answered with the mouse leaves the draft alone.
	await page.getByRole("button", { name: /Allow once/ }).click();
	await expect(card(page)).toHaveCount(0);
	await expect(composer).toHaveValue("half a sentence and the rest");
});

test("focus is taken from something that is not text being typed, and a following request takes it again", async ({
	page,
}) => {
	const { tap, liveId } = await chat(page, "Request queue probe", 0xca);
	// Focus rests on a button, not on text.
	await page.getByTestId("new-chat").focus();
	await expect(page.getByTestId("new-chat")).toBeFocused();
	approval(tap, liveId, "ui-1", "bash");
	await expect(card(page)).toBeFocused();

	// A second request waits behind the first; answering the first brings it forward and announces it.
	approval(tap, liveId, "ui-2", "edit");
	await expect(card(page)).toContainText("+1 more");
	await page.keyboard.press("Tab");
	await page.keyboard.press("Enter");
	await expect(announcement(page)).toHaveText("omp is waiting for you: Allow tool: edit");
	await expect(page.getByRole("dialog", { name: "Allow tool: edit" })).toBeFocused();

	// Settled: the keyboard goes back to where it was before the requests came.
	await page.keyboard.press("Tab");
	await page.keyboard.press("Enter");
	await expect(card(page)).toHaveCount(0);
	await expect(page.getByTestId("new-chat")).toBeFocused();
});

test("a dialog the user is in keeps the keyboard when a request arrives behind it", async ({ page }) => {
	const { tap, liveId } = await chat(page, "Request dialog probe", 0xcb);
	await page.getByTestId("open-goal").click();
	const rough = page.getByTestId("goal-rough");
	await expect(rough).toBeFocused();
	approval(tap, liveId, "ui-1", "bash");
	await expect(announcement(page)).toHaveText("omp is waiting for you: Allow tool: bash");
	await expect(rough).toBeFocused();
});
