import type { Locator, Page } from "@playwright/test";

/**
 * The side panel is two panes, and a tab is listed in the row of one of them (by default Agents, Todos, Jobs, Branches and Info
 * in the top pane's, Files, Issues, Ask and Host in the bottom pane's). `scope` is the page or the panel.
 */

/** A tab of the top pane's row (the pane the panel's Close button is in). */
export const topTab = (scope: Page | Locator, name: string | RegExp): Locator =>
	scope.getByTestId("panel-pane-top").getByRole("tab", { name });

/** A tab of the panel wherever the layout lists it: a tab is in one row only, so this is one tab. */
export const panelTab = (scope: Page | Locator, name: string | RegExp): Locator =>
	scope.locator('[data-testid^="panel-pane-"]').getByRole("tab", { name });

/** The top pane's row of tabs. */
export const topTabs = (scope: Page | Locator): Locator => scope.getByTestId("panel-pane-top").getByRole("tablist");
