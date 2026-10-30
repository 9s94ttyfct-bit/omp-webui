import AxeBuilder from "@axe-core/playwright";
import { PALETTES } from "../../web/src/lib/theme.ts";
import { openFeedback } from "../support/feedback.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Toasts render outside every Radix dialog, which used to make a press on one count as an outside click and
 * close the dialog under it (no model call).
 */

const row = (page: Page, title: string) =>
	page.getByRole("complementary").locator('[data-testid="session-item"]', { hasText: title });

/** Radix watches for presses outside a dialog from the next task after it opens: let that task run. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>((done) => setTimeout(done, 50)));

/** Archive a conversation from its menu: a toast with an Undo button comes up. */
async function archive(page: Page, title: string) {
	await row(page, title).hover();
	await page.getByRole("button", { name: `Actions for ${title}` }).click();
	await page.getByRole("menuitem", { name: "Archive" }).click();
	await expect(row(page, title)).toHaveCount(0);
}

test("dismissing a toast, or using its action, leaves an open dialog open", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	writeSimpleSession(agentDir, 0xa1, "Toast dialog one");
	writeSimpleSession(agentDir, 0xa2, "Toast dialog two");
	await page.goto("/");
	for (const title of ["Toast dialog one", "Toast dialog two"])
		await expect(row(page, title)).toHaveCount(1, { timeout: 15_000 });
	await archive(page, "Toast dialog one");
	await archive(page, "Toast dialog two");
	const toasts = page.getByTestId("toast");
	await expect(toasts).toHaveCount(2);

	// A dialog over the toasts (Feedback, from the command palette): the toast region is not hidden from assistive tech, and stays
	// clickable.
	await openFeedback(page);
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await expect(page.locator("[data-toast-region]")).not.toHaveAttribute("aria-hidden", "true");
	await settle(page);

	// Dismiss: the toast goes, the dialog stays and keeps focus.
	await toasts.first().getByTestId("toast-dismiss").click();
	await expect(toasts).toHaveCount(1);
	await expect(dialog).toBeVisible();
	await expect(dialog.locator(":focus")).toHaveCount(1);

	// Action (Undo): the conversation returns to the list, the dialog stays, focus is still inside it.
	await toasts.getByTestId("toast-action").click();
	await expect(toasts).toHaveCount(0);
	await expect(dialog).toBeVisible();
	await expect(dialog.locator(":focus")).toHaveCount(1);

	// Esc still closes the dialog, and the Undo did run (the sidebar is hidden from role queries while it was open).
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(row(page, "Toast dialog two")).toHaveCount(1);
});

test("a press outside a dialog and its toasts still closes it", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	writeSimpleSession(agentDir, 0xa3, "Toast dialog three");
	await page.goto("/");
	await expect(row(page, "Toast dialog three")).toHaveCount(1, { timeout: 15_000 });
	await archive(page, "Toast dialog three");
	await expect(page.getByTestId("toast")).toHaveCount(1);
	await openFeedback(page);
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await settle(page);
	await page.mouse.click(5, 450);
	await expect(dialog).toHaveCount(0);
});

/** Where the toast stack has focus: on a button of a toast. */
const inToasts = (page: Page) => page.locator("[data-toast-region] :focus");

test("keyboard only: a shortcut reaches the toasts while a dialog is open, Enter uses one, Esc goes back to the dialog", async ({
	page,
}) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	writeSimpleSession(agentDir, 0xa4, "Toast keys one");
	writeSimpleSession(agentDir, 0xa5, "Toast keys two");
	await page.goto("/");
	for (const title of ["Toast keys one", "Toast keys two"])
		await expect(row(page, title)).toHaveCount(1, { timeout: 15_000 });
	await archive(page, "Toast keys one");
	await archive(page, "Toast keys two");
	const toasts = page.getByTestId("toast");
	await expect(toasts).toHaveCount(2);

	await openFeedback(page);
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await settle(page);

	// Tab stays in the dialog: the toasts are out of its reach.
	for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
	await expect(inToasts(page)).toHaveCount(0);
	await expect(dialog.locator(":focus")).toHaveCount(1);

	// The shortcut puts focus on the newest toast's action, whatever has it now, and says how to go back.
	await page.keyboard.press("ControlOrMeta+Shift+Y");
	await expect(toasts.last().getByTestId("toast-action")).toBeFocused();
	await expect(page.getByTestId("toasts-hint")).toBeVisible();
	await expect(dialog).toBeVisible();
	// Tab goes through the buttons of the stack and wraps round, in both directions, and never back into the dialog.
	await page.keyboard.press("Tab");
	await expect(toasts.last().getByTestId("toast-dismiss")).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(toasts.first().getByTestId("toast-action")).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(toasts.last().getByTestId("toast-dismiss")).toBeFocused();
	for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
	await expect(inToasts(page)).toHaveCount(1);

	// Esc is back in the dialog, which stays open and has focus; a second one closes it as before.
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("toasts-hint")).toHaveCount(0);
	await expect(dialog).toBeVisible();
	await expect(inToasts(page)).toHaveCount(0);
	await expect(dialog.locator(":focus")).toHaveCount(1);

	// Enter on the newest toast's action does what a click does: that conversation comes back, the dialog stays.
	await page.keyboard.press("ControlOrMeta+Shift+Y");
	await expect(toasts.last().getByTestId("toast-action")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(toasts).toHaveCount(1);
	await expect(dialog).toBeVisible();
	// Focus stays with the stack, on the toast that is left (not lost to the page behind the dialog).
	await expect(toasts.getByTestId("toast-action")).toBeFocused();

	// Dismiss the last one from the keyboard: the stack is empty and focus is in the dialog again.
	await page.keyboard.press("Tab");
	await expect(toasts.getByTestId("toast-dismiss")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(toasts).toHaveCount(0);
	await expect(dialog).toBeVisible();
	await expect(dialog.locator(":focus")).toHaveCount(1);

	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(row(page, "Toast keys two")).toHaveCount(1);
});

test("the shortcut without a dialog: focus goes to the toast and Esc gives it back; a press elsewhere lets go of the stack", async ({
	page,
}) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	writeSimpleSession(agentDir, 0xa6, "Toast keys three");
	await page.goto("/");
	await expect(row(page, "Toast keys three")).toHaveCount(1, { timeout: 15_000 });
	const composer = page.getByTestId("composer");
	await composer.click();

	// No toast: nothing to reach, and focus stays put.
	await page.keyboard.press("ControlOrMeta+Shift+Y");
	await expect(composer).toBeFocused();

	await archive(page, "Toast keys three");
	await composer.click();
	await page.keyboard.press("ControlOrMeta+Shift+Y");
	await expect(page.getByTestId("toast-action")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(composer).toBeFocused();

	// A press on the page ends it: focus is where the press put it, not pulled back to the toast.
	await page.keyboard.press("ControlOrMeta+Shift+Y");
	await expect(page.getByTestId("toast-action")).toBeFocused();
	await composer.click();
	await expect(composer).toBeFocused();
	await page.keyboard.type("x");
	await expect(composer).toHaveValue("x");
	await composer.fill("");

	// Used from the keyboard with nothing else open: Undo brings the conversation back.
	await page.keyboard.press("ControlOrMeta+Shift+Y");
	await expect(page.getByTestId("toast-action")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("toast")).toHaveCount(0);
	await expect(row(page, "Toast keys three")).toHaveCount(1);
});

test("the toasts and the hint of the shortcut are readable in every palette, light and dark", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	writeSimpleSession(agentDir, 0xa7, "Toast keys four");
	// axe measures colours as they are on screen at that moment, and a toast still fading in is not final.
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/");
	await expect(row(page, "Toast keys four")).toHaveCount(1, { timeout: 15_000 });
	await archive(page, "Toast keys four");
	await page.keyboard.press("ControlOrMeta+Shift+Y");
	await expect(page.getByTestId("toasts-hint")).toBeVisible();
	for (const id of PALETTES)
		for (const dark of [false, true]) {
			await page.evaluate(
				([palette, mode]) => {
					document.documentElement.dataset.palette = palette as string;
					document.documentElement.classList.toggle("dark", mode === "dark");
				},
				[id, dark ? "dark" : "light"],
			);
			const { violations } = await new AxeBuilder({ page })
				.include("[data-toast-region]")
				.withRules(["color-contrast"])
				.analyze();
			expect(
				violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")}: ${n.any[0]?.message ?? v.help}`)),
				`${id} ${dark ? "dark" : "light"}`,
			).toEqual([]);
		}
});
