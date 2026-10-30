import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The sidebar's list of projects (#636) in an end-to-end test: open it with the funnel, choose a project, make a group, put a
 * project in it, fold it, rename it, delete it. The funnel keeps the accessible name `Project` and the `project-filter` test
 * id the native `<select>` had (#415); what it opens is the popup the list is in.
 */

/** The funnel beside the filter field. */
export const projectTrigger = (page: Page) => page.getByTestId("project-filter");

/** The popup while it is open (a locator that is empty when it is not). */
export const projectPopover = (page: Page) => page.getByTestId("project-popover");

/** Open the project list (the funnel is a popover trigger: a click opens it, another closes it). */
export async function openProjects(page: Page): Promise<void> {
	const open = await projectTrigger(page).getAttribute("aria-expanded");
	if (open === "true") return;
	await projectTrigger(page).click();
	await expect(projectPopover(page)).toBeVisible();
}

export async function closeProjects(page: Page): Promise<void> {
	if ((await projectTrigger(page).getAttribute("aria-expanded")) !== "true") return;
	await projectPopover(page)
		.getByRole("button", { name: /^(Close|关闭)$/ })
		.click();
	await expect(projectPopover(page)).toHaveCount(0);
}

/** Choose a project by its folder (the row's `data-cwd`), or `null` for all projects. */
export async function chooseProject(page: Page, cwd: string | null): Promise<void> {
	await openProjects(page);
	if (cwd === null) await projectPopover(page).getByTestId("project-all").click();
	else await projectPopover(page).locator(`[data-testid="project-row"][data-cwd="${cwd}"]`).click();
	await expect(projectPopover(page)).toHaveCount(0);
}

/** The group's disclosure button, by the group's name. */
export function groupButton(page: Page, name: string): Locator {
	return projectPopover(page).getByTestId("project-group").filter({ hasText: name });
}

/** A project's row in the list, by its folder. */
export function projectRow(page: Page, cwd: string): Locator {
	return projectPopover(page).locator(`[data-testid="project-row"][data-cwd="${cwd}"]`);
}
