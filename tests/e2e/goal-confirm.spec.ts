import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Dropping a goal asks first, and a goal that fails to start keeps what was typed (in the form that skips the
 * interview; the guided goal has its own spec). The goal arrives as
 * a pushed frame and the RPCs are answered locally, so no model call is made.
 */

test("Drop asks for confirmation before anything is sent", async ({ page }) => {
	ownSession(0x51, "Goal drop probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	tap.answer("goal", (c) => (c.op === "drop" ? { ok: true } : undefined));
	await page.goto("/");
	const liveId = await startLive(page, tap, "Goal drop probe", "goal-drop-probe");
	tap.push({
		t: "frame",
		liveId,
		frame: {
			type: "goal_updated",
			goal: { id: "g1", objective: "Ship the release notes", status: "active", tokenBudget: 50_000, tokensUsed: 1200 },
		},
	});
	const bar = page.getByTestId("goal-bar");
	await expect(bar).toBeVisible();
	const drops = () => tap.commands("goal").filter((c) => c.op === "drop");

	await bar.getByRole("button", { name: "Drop goal" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toContainText("Drop this goal?");
	await expect(dialog).toContainText("Ship the release notes");
	// A confirmation opens on its safe action.
	await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
	expect(drops()).toHaveLength(0);

	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	expect(drops()).toHaveLength(0);
	await expect(bar).toBeVisible();

	await bar.getByRole("button", { name: "Drop goal" }).click();
	await dialog.getByRole("button", { name: "Drop goal" }).click();
	await expect.poll(() => drops().length).toBe(1);
});

test("a goal that fails to start keeps the objective and the budget", async ({ page }) => {
	ownSession(0x52, "Goal create probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	tap.answer("goal", (c) => (c.op === "create" ? { ok: false, error: "forced goal failure" } : undefined));
	await page.goto("/");
	await startLive(page, tap, "Goal create probe", "goal-create-probe");

	await page.getByTestId("open-goal").click();
	// The dialog opens on the interview; this test types the objective itself.
	await page.getByTestId("goal-direct-toggle").click();
	const objective = page.getByTestId("goal-objective");
	const budget = page.getByTestId("goal-budget");
	await objective.fill("Make the build green");
	await budget.fill("12345");
	await page.getByTestId("goal-create").click();
	await expect(page.getByTestId("toast").filter({ hasText: "forced goal failure" })).toBeVisible();
	expect(tap.commands("goal").filter((c) => c.op === "create")).toHaveLength(1);

	// Whether the dialog stayed open or not, nothing typed is lost.
	if (!(await objective.isVisible())) await page.getByTestId("open-goal").click();
	await expect(objective).toHaveValue("Make the build green");
	await expect(budget).toHaveValue("12345");
});
