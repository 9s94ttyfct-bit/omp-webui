import { FIXTURE } from "../support/fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** Dialogs open on their first field (never on Close) and give focus back to what opened them (no model call). */

const menuButton = (page: Page, title: string) => page.getByRole("button", { name: `Actions for ${title}` });

async function openRowMenu(page: Page, title: string) {
	await page.locator('[data-testid="session-item"]', { hasText: title }).hover();
	await menuButton(page, title).click();
}

test("Rename opens on its field; Esc returns focus to the row's menu button", async ({ page }) => {
	await page.goto("/");
	await openRowMenu(page, FIXTURE.alphaTitle);
	await page.getByRole("menuitem", { name: "Rename" }).click();
	await expect(page.getByTestId("rename-input")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(menuButton(page, FIXTURE.alphaTitle)).toBeFocused();
});

test("a confirmation opens on Cancel, not Close, and Esc returns focus to the row's menu button", async ({ page }) => {
	await page.goto("/");
	await openRowMenu(page, FIXTURE.alphaTitle);
	await page.getByRole("menuitem", { name: "Delete…" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toContainText("cannot be undone");
	await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(menuButton(page, FIXTURE.alphaTitle)).toBeFocused();
});

test("Cancel returns focus too, and Tab stays inside the dialog (Close is reachable last)", async ({ page }) => {
	await page.goto("/");
	await openRowMenu(page, FIXTURE.alphaTitle);
	await page.getByRole("menuitem", { name: "Rename" }).click();
	const dialog = page.getByRole("dialog");
	await expect(page.getByTestId("rename-input")).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(dialog.getByRole("button", { name: "Save" })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(page.getByTestId("rename-input")).toBeFocused();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(menuButton(page, FIXTURE.alphaTitle)).toBeFocused();
});

test("search returns focus to the control that opened it", async ({ page }) => {
	await page.goto("/");

	// The shortcut in the button's name is ⌘K on Apple platforms and Ctrl+K elsewhere.
	const search = page.getByRole("button", { name: /^Search \((⌘|Ctrl\+)K\)$/ });
	await search.click();
	await expect(page.getByTestId("palette-input")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("palette-input")).toHaveCount(0);
	await expect(search).toBeFocused();

	// Opened from the keyboard while typing: back to the composer.
	await page.getByTestId("composer").focus();
	await page.keyboard.press("ControlOrMeta+k");
	await expect(page.getByTestId("palette-input")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("composer")).toBeFocused();
});

test("the header's Rename gives focus back to its pencil button on Esc, Cancel and Save (#296)", async ({ page }) => {
	await page.goto("/");
	await page.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
	const pencil = page.getByRole("button", { name: "Rename", exact: true });
	const dialog = page.getByRole("dialog", { name: "Rename conversation" });
	const open = async () => {
		await pencil.focus();
		await page.keyboard.press("Enter");
		await expect(dialog).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Conversation name" })).toBeFocused();
	};
	await open();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(pencil).toBeFocused();
	await open();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(pencil).toBeFocused();
	// Saving the same name keeps the fixture as it was.
	await open();
	await page.keyboard.press("Enter");
	await expect(dialog).toHaveCount(0);
	await expect(pencil).toBeFocused();
});
