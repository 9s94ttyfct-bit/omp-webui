import type { Page } from "@playwright/test";

/**
 * The address of New chat in `cwd` (`#/new?cwd=`): an existing folder, not a new project. `base` is the page before the
 * hash: another server's (`${s.url}/?token=…`), or the worker's own (`/`).
 */
export function newChatIn(cwd: string, base = "/"): string {
	return `${base}#/new?cwd=${encodeURIComponent(cwd)}`;
}

/** Opens New chat's folder browser: its folder button's menu, then "Choose an existing folder…". */
export async function openFolderBrowser(page: Page): Promise<void> {
	await page.getByTestId("folder-menu").click();
	await page.getByTestId("folder-menu-existing").click();
}
