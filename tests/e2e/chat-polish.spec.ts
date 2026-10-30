import { openFeedback } from "../support/feedback.ts";
import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Small things of the chat page that did not do what their words said: Esc (twice) stops a reply from anywhere on the
 * page, and the narrow screen's sidebar drawer is a dialog. No model is called: the reply is a pushed frame.
 */

test("Esc, Esc stops a running reply after clicking in the transcript, but not while a field, dialog or the selection has it", async ({
	page,
}) => {
	const title = "Esc stops from anywhere";
	ownSession(0x30, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	tap.answer("abort_and_restore_queue", () => ({ ok: true, data: {} }));
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "esc-anywhere-up");
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	await expect(page.getByTestId("stop")).toBeVisible();

	// A click on the conversation takes focus off the composer: Esc asks, and a second Esc stops, as the Stop button's
	// tip says.
	await page.getByTestId("msg-user").first().click();
	await expect(page.getByTestId("composer")).not.toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("stop-confirm")).toBeVisible();
	expect(tap.commands("abort_and_restore_queue")).toHaveLength(0);
	await page.keyboard.press("Escape");
	await expect.poll(() => tap.commands("abort_and_restore_queue").length).toBe(1);
	await expect(page.getByTestId("stop-confirm")).toHaveCount(0);

	// A dialog has the key first: it closes, nothing is stopped and nothing is asked.
	await openFeedback(page);
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);

	// So does a text field other than the composer.
	await page.getByTestId("session-filter").click();
	await page.keyboard.press("Escape");

	// And the sidebar's selection mode, which Esc leaves.
	await page.getByTestId("select-sessions").click();
	await expect(page.getByTestId("selection-bar")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("selection-bar")).toHaveCount(0);

	await page.waitForTimeout(300);
	await expect(page.getByTestId("stop-confirm")).toHaveCount(0);
	expect(tap.commands("abort_and_restore_queue")).toHaveLength(1);

	// With none of those in the way, the next two Esc stop again.
	await page.getByTestId("msg-user").first().click();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("stop-confirm")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect.poll(() => tap.commands("abort_and_restore_queue").length).toBe(2);

	// Nothing running: Esc is not Stop.
	tap.push({ t: "frame", liveId, frame: { type: "agent_end", messages: [] } });
	await expect(page.getByTestId("stop")).toHaveCount(0);
	await page.getByTestId("msg-user").first().click();
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
	await expect(page.getByTestId("stop-confirm")).toHaveCount(0);
	expect(tap.commands("abort_and_restore_queue")).toHaveLength(2);
});

test("on a narrow screen the sidebar is a modal dialog: Esc closes it, focus comes back to its button", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	const show = page.getByRole("button", { name: "Show sidebar" });
	await expect(show).toBeVisible();
	await show.click();

	// Not just any dialog: the click that closes it lands on the page behind, which can open a popover of its own.
	const drawer = page.getByTestId("sidebar-drawer");
	await expect(drawer).toBeVisible();
	await expect(drawer).toHaveAttribute("role", "dialog");
	await expect(drawer).toHaveAttribute("aria-modal", "true");
	await expect(drawer.getByRole("complementary")).toBeVisible();
	// Focus is inside it, and what is behind it is out of reach of Tab.
	await expect(drawer.locator(":focus")).toHaveCount(1);

	await page.keyboard.press("Escape");
	await expect(drawer).toHaveCount(0);
	await expect(show).toBeFocused();

	// Clicking what is behind it closes it too.
	await show.click();
	await expect(drawer).toBeVisible();
	// Radix takes pointer events off everything behind the drawer when it mounts, and listens for a press outside it a
	// tick later: a click this soon would go through to the page.
	await expect(page.locator("body")).toHaveCSS("pointer-events", "none");
	await page.waitForTimeout(150);
	await page.mouse.click(385, 400);
	await expect(drawer).toHaveCount(0);
});

test("on a wide screen the sidebar is a column of the page, not a dialog", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("complementary")).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);
});
