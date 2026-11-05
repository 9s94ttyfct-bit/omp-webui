import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";

/**
 * The Plugins page and the move of Commands & terminal into Settings, against the real server and omp in the worker's own
 * HOME (no network): a local plugin folder is installed from the page, switched off and on, and uninstalled; Commands &
 * terminal opens from Settings, from its old `#/cli` address and from the palette, and the sidebar lists Plugins instead.
 */

test("a local plugin is installed, switched and uninstalled from the Plugins page", async ({ page, e2eServer }) => {
	const folder = join(e2eServer.root, "e2e-local-plugin");
	mkdirSync(folder, { recursive: true });
	writeFileSync(
		join(folder, "package.json"),
		JSON.stringify({ name: "e2e-local-plugin", version: "0.3.0", description: "From the e2e spec", omp: {} }),
	);
	await page.goto("/#/");
	await page.getByTestId("nav-plugins").click();
	await expect(page).toHaveURL(/#\/plugins$/);
	// The Overview opens first: the updates and omp's health check.
	await expect(page.getByTestId("plugins-updates")).toBeVisible();
	await expect(page.getByTestId("plugins-doctor")).toBeVisible();

	// Installing by package, URL or folder is in the Discover tab; the card is in Installed.
	await page.getByTestId("plugins-tab-discover").click();
	await page.getByTestId("manual-spec").fill(folder);
	await page.getByTestId("manual-install").click();
	await expect(page.getByTestId("plugins-outcome")).toHaveAttribute("data-state", "done", { timeout: 60_000 });
	await page.getByTestId("plugins-tab-installed").click();
	const card = page.locator('[data-testid="plugin-card"][data-plugin="e2e-local-plugin"]');
	await expect(card).toHaveAttribute("data-enabled", "true");
	await expect(card).toContainText("0.3.0");
	await expect(card).toContainText("From the e2e spec");

	await card.getByTestId("plugin-switch").click();
	await expect(card).toHaveAttribute("data-enabled", "false");
	await card.getByTestId("plugin-switch").click();
	await expect(card).toHaveAttribute("data-enabled", "true");

	await card.getByTestId("plugin-uninstall").click();
	await page.getByTestId("plugin-uninstall-confirm").click();
	await expect(page.getByTestId("plugins-outcome")).toHaveAttribute("data-state", "done", { timeout: 60_000 });
	await expect(card).toHaveCount(0);
});

test("the Overview says the plugin list could not be read, and Retry reads it again", async ({ page }) => {
	let fail = true;
	await page.route(/\/api\/plugins(\?|$)/, async (route) => {
		if (!fail) return route.continue();
		return route.fulfill({ status: 500, json: { error: "omp could not be started" } });
	});
	await page.goto("/#/plugins");
	const panel = page.getByTestId("plugins-panel-overview");
	const error = panel.getByTestId("load-error");
	await expect(error).toContainText("Couldn't list the plugins");
	await expect(error).toContainText("omp could not be started");
	fail = false;
	await error.getByTestId("load-retry").click();
	await expect(error).toHaveCount(0);
	await expect(panel.getByTestId("plugins-stat-installed")).not.toContainText("–");
});

test("Commands & terminal is a page of Settings: opened from Settings, from #/cli and from Settings' search; the sidebar has Plugins", async ({
	page,
}) => {
	await page.goto("/#/settings/app");
	await expect(page.getByTestId("nav-cli")).toHaveCount(0);
	await expect(page.getByTestId("nav-plugins")).toBeVisible();
	await page.getByTestId("settings-open-cli").click();
	await expect(page.getByTestId("cli-page")).toBeVisible();
	await expect(page).toHaveURL(/#\/settings\/cli$/);
	await expect(page.getByTestId("nav-settings")).toHaveAttribute("aria-current", "page");
	await page.getByTestId("cli-back-settings").click();
	await expect(page.getByTestId("settings-page")).toBeVisible();

	// The `omp plugin` button of omp configuration opens the Plugins page now.
	await page.getByTestId("settings-open-plugins").click();
	await expect(page.getByTestId("plugins-page")).toBeVisible();

	// An old address still opens it, on the command it named, and is shown as the new one.
	await page.goto("/#/cli/config");
	await expect(page.getByTestId("cli-page")).toBeVisible();
	await expect(page.locator("h1")).toContainText("omp config");
	await expect(page).toHaveURL(/#\/settings\/cli\/config$/);

	// Settings' search finds it.
	await page.goto("/#/settings/look");
	await page.getByTestId("settings-search-input").fill("Commands & terminal");
	await page.getByTestId("settings-search-result").filter({ hasText: "Commands & terminal" }).first().click();
	await expect(page.getByTestId("settings-open-cli")).toBeInViewport();
});

test("a sidebar layout saved with Commands & terminal shows Plugins in its place", async ({ page }) => {
	await page.goto("/#/");
	await page.evaluate(() =>
		localStorage.setItem(
			"ompw.navLayout",
			JSON.stringify({
				v: 1,
				sidebar: { top: ["cli"], bottom: ["agents", "usage", "memory", "settings", "guard"], hidden: [] },
				rail: { top: [], bottom: ["agents", "usage", "memory", "cli", "settings", "guard"], hidden: [] },
			}),
		),
	);
	await page.reload();
	const top = page.getByTestId("nav-group-sidebar-top");
	await expect(top.getByTestId("nav-plugins")).toBeVisible();
	await expect(page.getByTestId("nav-plugins")).toHaveCount(1);
	await expect(page.getByTestId("nav-cli")).toHaveCount(0);
});
