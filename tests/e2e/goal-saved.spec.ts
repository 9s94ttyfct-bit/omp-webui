import { sessionRow } from "../support/live.ts";
import { Chain, writeRenderSession } from "../support/render-fixtures.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A goal set and paused in the terminal: opening the conversation in the web UI shows it before any omp runs
 * here, and Resume starts omp for the conversation and resumes the goal (no model call is awaited).
 */

const goal = (status: string) => ({
	id: "g-terminal",
	objective: "Terminal goal: tidy the release notes",
	status,
	tokenBudget: 80_000,
	tokensUsed: 12_345,
	timeUsedSeconds: 90,
	createdAt: 1_790_000_000_000,
	updatedAt: 1_790_000_060_000,
});

test("a goal paused in the terminal shows when the conversation is opened, and Resume resumes it", async ({ page }) => {
	const c = new Chain("gs");
	c.user("Saved goal probe");
	c.assistant([{ type: "text", text: "Working on it." }]);
	c.modeChange("goal", goal("active"));
	c.modeChange("goal_paused", goal("paused"));
	writeRenderSession(process.env.OMPW_E2E_AGENT_DIR as string, "01a00000-0000-7000-8000-0000000060a1", c.entries);
	const tap = await tapSocket(page);
	await page.goto("/");
	await sessionRow(page, "Saved goal probe").click();

	const bar = page.getByTestId("goal-bar");
	await expect(bar).toBeVisible({ timeout: 15_000 });
	await expect(bar).toContainText("Terminal goal: tidy the release notes");
	await expect(bar).toHaveAttribute("data-status", "paused");
	await expect(bar.getByTestId("goal-state")).toHaveText("Paused");
	await expect(bar.getByTestId("goal-tokens")).toContainText("80k");
	// No omp runs for this conversation yet (the New chat page may keep a spare process of its own).
	const resumes = () => tap.sent.filter((m) => m.t === "open" && m.target?.kind === "resume");
	expect(resumes()).toEqual([]);

	await bar.getByRole("button", { name: "Resume goal" }).click();
	await expect.poll(() => tap.commands("goal").map((g) => g.op)).toContain("resume");
	expect(resumes()).toHaveLength(1);
	await expect(bar).toHaveAttribute("data-status", "active", { timeout: 30_000 });
});

test("a goal the transcript ended (dropped or completed) shows no goal bar", async ({ page }) => {
	const c = new Chain("gd");
	c.user("Ended goal probe");
	c.assistant([{ type: "text", text: "Done." }]);
	c.modeChange("goal", goal("active"));
	c.modeChange("none");
	writeRenderSession(process.env.OMPW_E2E_AGENT_DIR as string, "01a00000-0000-7000-8000-0000000060a2", c.entries);
	await page.goto("/");
	await sessionRow(page, "Ended goal probe").click();
	await expect(page.getByText("Done.")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("goal-bar")).toHaveCount(0);
});
