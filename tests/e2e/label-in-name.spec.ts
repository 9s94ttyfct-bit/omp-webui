import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { openSidebar, startLive } from "../support/live.ts";
import { rpcState } from "../support/rpc-state.ts";
import { type Msg, tapSocket } from "../support/socket-tap.ts";
import { sessionWithSubagents } from "../support/subagent-fixtures.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A control is named by what it shows (WCAG 2.5.3 Label in Name): someone who drives the page by voice says the words
 * on the button. These controls used to carry a name of their own that did not contain their visible text: the goal
 * bar's toggle ("Show goal details" over the objective), a job row ("Open Job1" over "task Job1 …"), the guard picker
 * of New chat ("Guard dangerous commands, for this conversation: Off" over "Guard: Off") and a guidance template of
 * Settings ("Open the template …" over its name and summary). axe's rule decides; no model call is made.
 */

/** What axe's label-in-name rule finds under `selector`, as `target: summary` lines (none is the pass). */
async function mismatches(page: Page, selector: string): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page })
		.include(selector)
		.withRules(["label-content-name-mismatch"])
		.analyze();
	return violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")}: ${n.failureSummary ?? ""}`));
}

test("the goal bar's toggle and a job's row are named by what they show", async ({ page }) => {
	const title = "Label in name probe";
	sessionWithSubagents(0x31, title, {});
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, "label-in-name-1");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f } as Msg);
	tap.answer("get_state", () => ({ ok: true, data: rpcState() }));

	frame({
		type: "goal_updated",
		goal: { id: "g", objective: "Ship the release notes", status: "active", tokenBudget: 50_000, tokensUsed: 900 },
	});
	const toggle = page.getByTestId("goal-toggle");
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAccessibleName("Ship the release notes");
	expect(await mismatches(page, '[data-testid="goal-bar"]')).toEqual([]);

	const job = { index: 1, parentToolCallId: "call_label" };
	frame({
		type: "subagent_lifecycle",
		payload: {
			id: "Job1",
			agent: "explore",
			agentSource: "bundled",
			status: "started",
			description: "Read the docs",
			...job,
		},
	});
	frame({
		type: "subagent_progress",
		payload: {
			agent: "explore",
			agentSource: "bundled",
			task: "Job1",
			progress: { id: "Job1", status: "running", durationMs: 10_000, completionPercent: 10 },
			...job,
		},
	});
	const row = page.getByTestId("job-row");
	await expect(row).toContainText("Job1");
	expect(await mismatches(page, '[data-testid="jobs-block"]')).toEqual([]);
});

test("New chat's guard picker is named by what it shows", async ({ page }) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	const picker = page.getByTestId("guard-picker");
	await expect(picker).toBeVisible({ timeout: 60_000 });
	expect(await mismatches(page, '[data-testid="guard-picker"]')).toEqual([]);
	// What the picker is for is still said: its tooltip describes it.
	await expect(picker).toHaveAccessibleDescription("Guard dangerous commands, for this conversation");
});

test("New chat's Mode chip in the phone's ⋯ panel is named by what it shows (#788)", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await page.getByTestId("composer-more").click({ timeout: 60_000 });
	const panel = page.getByTestId("composer-more-panel");
	const chip = panel.getByTestId("mode-picker");
	await expect(chip).toBeVisible();
	expect(await mismatches(page, '[data-testid="composer-more-panel"]')).toEqual([]);
	// It shows "Mode: Full"; its name starts with that, and what it is for stays its description.
	await expect(chip).toHaveAccessibleName(/^Mode: (Full|Light)$/);
	await expect(chip).toHaveAccessibleDescription("Full or Light for new conversations");
});

test("a guidance template in Settings is named by what it shows", async ({ page }) => {
	await page.goto("/#/settings/models");
	const row = page.getByTestId("guidance-template-row").filter({ hasText: "One of each kind at a time" });
	await expect(row).toBeVisible({ timeout: 60_000 });
	// Its name starts with the template's name, as shown, followed by the badge and summary under it.
	await expect(row.getByRole("button")).toHaveAccessibleName(/^One of each kind at a time Shipped /);
	expect(await mismatches(page, '[data-testid="guidance-settings"]')).toEqual([]);
});
