import { Chain, writeRenderSession } from "../support/render-fixtures.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The command palette's Goal entry says the same thing as the Goal control of the conversation on screen: where a goal
 * is held, both read "Current goal" and open the goal instead of offering a new one. The goal of a transcript-only
 * conversation (a goal set and paused in the terminal, no omp running here) counts as held: the header says so, and the
 * palette must not offer to set a goal beside it.
 */

const goal = (status: string) => ({
	id: "g-palette",
	objective: "Terminal goal: tidy the release notes",
	status,
	tokenBudget: 80_000,
	tokensUsed: 12_345,
	timeUsedSeconds: 90,
	createdAt: 1_790_000_000_000,
	updatedAt: 1_790_000_060_000,
});

/** A conversation whose transcript ends in a paused goal, and the file it is in. */
function pausedGoalSession(id: string, title: string): string {
	const c = new Chain("gp");
	c.user(title);
	c.assistant([{ type: "text", text: "Working on it." }]);
	c.modeChange("goal", goal("active"));
	c.modeChange("goal_paused", goal("paused"));
	return writeRenderSession(process.env.OMPW_E2E_AGENT_DIR as string, id, c.entries);
}

test("the palette's Goal entry reads as the Goal control does: a transcript's paused goal is a goal held here", async ({
	page,
}) => {
	const file = pausedGoalSession("01a00000-0000-7000-8000-0000000060c1", "Palette goal probe");
	await page.goto(`/#/s/${encodeURIComponent(file)}`);

	// The header's control: the conversation holds a goal, so it reads "Current goal".
	const control = page.getByTestId("open-goal");
	await expect(control).toHaveAccessibleName("Current goal", { timeout: 15_000 });
	await expect(page.getByTestId("goal-bar")).toBeVisible();

	// The palette: the same answer, and the same action.
	await page.keyboard.press("ControlOrMeta+K");
	await page.getByTestId("palette-input").fill("goal");
	await expect(page.getByTestId("palette-goal")).toContainText("Current goal");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("goal-details")).toBeVisible();
	await expect(page.getByTestId("goal-rough")).toHaveCount(0);
});

test("the palette's Goal entry offers a new goal where none is held", async ({ page }) => {
	const c = new Chain("gn");
	c.user("Palette plain probe");
	c.assistant([{ type: "text", text: "Done." }]);
	const file = writeRenderSession(
		process.env.OMPW_E2E_AGENT_DIR as string,
		"01a00000-0000-7000-8000-0000000060c2",
		c.entries,
	);
	await page.goto(`/#/s/${encodeURIComponent(file)}`);

	await expect(page.getByTestId("open-goal")).toHaveAccessibleName("Set a goal", { timeout: 15_000 });
	await page.keyboard.press("ControlOrMeta+K");
	await page.getByTestId("palette-input").fill("goal");
	await expect(page.getByTestId("palette-goal")).toContainText("Set a goal");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("goal-rough")).toBeVisible();
});
