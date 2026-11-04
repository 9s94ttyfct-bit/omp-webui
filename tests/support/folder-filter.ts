import { expect, type Page } from "@playwright/test";

/**
 * The search bar's folder filter in an end-to-end test: the funnel beside the filter field opens a flat list of folders
 * (a conversation's working folder) with their counts; choosing one keeps that folder's conversations.
 */

/** The funnel beside the filter field. */
export const folderTrigger = (page: Page) => page.getByTestId("folder-filter");

/** The popup while it is open (a locator that is empty when it is not). */
export const folderPopover = (page: Page) => page.getByTestId("folder-popover");

/** Open the list of folders (the funnel is a popover trigger: a click opens it, another closes it). */
export async function openFolders(page: Page): Promise<void> {
	if ((await folderTrigger(page).getAttribute("aria-expanded")) === "true") return;
	await folderTrigger(page).click();
	await expect(folderPopover(page)).toBeVisible();
}

/** Choose a folder by its path (the row's `data-cwd`), or `null` for all folders. */
export async function chooseFolder(page: Page, cwd: string | null): Promise<void> {
	await openFolders(page);
	if (cwd === null) await folderPopover(page).getByTestId("folder-all").click();
	else await folderPopover(page).locator(`[data-testid="folder-row"][data-cwd="${cwd}"]`).click();
	await expect(folderPopover(page)).toHaveCount(0);
}
