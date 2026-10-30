import { unfoldAdvanced } from "../support/controls.ts";
import { appReady } from "../support/live.ts";
import { panelTab } from "../support/panel.ts";
import { expect, test } from "./fixtures.ts";

/** Per-session runtime controls and /btw side questions (real omp + Claude Haiku 5.5). */

test.describe.configure({ mode: "serial" });
test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");

test("session settings apply to omp and compaction reports omp's outcome", async ({ page }) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText(/haiku/i, { timeout: 60_000 });
	await page.getByTestId("composer").fill("Name three primary colors, comma separated.");
	await page.getByTestId("send").click();
	await expect(page.getByTestId("msg-assistant").last()).toContainText(/red/i, { timeout: 90_000 });
	await expect(page.getByTestId("stop")).toHaveCount(0);

	await page.getByTestId("session-controls").click();
	const panel = page.getByTestId("session-controls-panel");
	await unfoldAdvanced(page);
	// Values shown are read back from omp's get_state after each change.
	await panel.getByTestId("auto-compaction").getByText("Off").click();
	await expect(panel.getByTestId("auto-compaction").getByRole("radio", { name: "Off" })).toBeChecked();
	await panel.getByTestId("steering-mode").getByText("All").click();
	await expect(panel.getByTestId("steering-mode").getByRole("radio", { name: "All" })).toBeChecked();
	await panel.getByTestId("interrupt-mode").getByText("Wait").click();
	await expect(panel.getByTestId("interrupt-mode").getByRole("radio", { name: "Wait" })).toBeChecked();
	// omp decides whether there is anything to compact; either outcome must reach the user.
	await panel.getByTestId("compact-now").click();
	await expect(
		page
			.getByTestId("toast")
			.filter({ hasText: /Nothing to compact/ })
			.or(page.getByText(/Context compacted/)),
	).toBeVisible({
		timeout: 90_000,
	});
});

test("side questions answer without entering the transcript", async ({ page }) => {
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill("primary colors");
	await page.getByTestId("search-hit").first().click();
	// The conversation's transcript is there before it is counted: a count taken while it loads is 0 (#663).
	await expect(page.getByTestId("msg-assistant").first()).toBeVisible({ timeout: 30_000 });
	const before = await page.getByTestId("msg-assistant").count();
	await page.getByTestId("toggle-panel").click();
	await panelTab(page, /Ask/).click();
	await page.getByTestId("btw-input").fill("How many colors did you list? Answer with just the digit.");
	await page.getByTestId("btw-send").click();
	await expect(page.getByTestId("btw-record").first()).toContainText("3", { timeout: 90_000 });
	await expect(page.getByTestId("msg-assistant")).toHaveCount(before);
});
