import type { Page } from "@playwright/test";
import { openSidebar, ownSession, startLive } from "../support/live.ts";
import { rpcState } from "../support/rpc-state.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The Goal control of a conversation that holds a goal: it shows the goal (objective, status, budget, time used) and the
 * adjustments omp's `goal` rpc has (pause, resume, drop) instead of offering to create another. The goal arrives as
 * pushed frames and the rpcs are answered locally, so no model call is made; tests/contract/goal-sync.test.ts pins
 * the same adjustments against the real omp.
 */

const OBJECTIVE = "Ship the release notes\n- every section proofread\n- all links checked";

const goal = (status: string, extra: Record<string, unknown> = {}) => ({
	id: "g-control",
	objective: OBJECTIVE,
	status,
	tokenBudget: 50_000,
	tokensUsed: 12_400,
	timeUsedSeconds: 754,
	...extra,
});

async function openWithGoal(page: Page, n: number, title: string): Promise<{ tap: SocketTap; liveId: string }> {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	// What the page sends for pause, resume and drop is answered; the state follows in omp's own `goal_updated` frame.
	tap.answer("goal", (c) => (c.op === "get" ? undefined : { ok: true, data: { goal: null, state: null } }));
	// The pushed frames play a run the real (idle) omp is not in: its own answers would say it is settled.
	tap.answer("get_state", () => ({ ok: true, data: rpcState() }));
	await page.goto("/");
	// A phone shows the sidebar behind a button.
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, `goal-control-${n}`);
	return { tap, liveId };
}

const ops = (tap: SocketTap) => tap.commands("goal").flatMap((c) => (c.op === "get" ? [] : [c.op]));

test("with a goal running, the Goal control shows it in place and offers its adjustments, not a new goal", async ({
	page,
}) => {
	const { tap, liveId } = await openWithGoal(page, 0x8a, "Goal control probe");
	const frame = (g: unknown) => tap.push({ t: "frame", liveId, frame: { type: "goal_updated", goal: g } });
	const control = page.getByTestId("open-goal");

	// Without a goal the control offers one.
	await expect(control).toHaveAccessibleName("Set a goal");
	await expect(page.getByTestId("goal-bar")).toHaveCount(0);

	frame(goal("active"));
	const bar = page.getByTestId("goal-bar");
	await expect(bar).toHaveAttribute("data-status", "active");
	await expect(control).toHaveAccessibleName("Current goal");
	await expect(control).toHaveAttribute("aria-expanded", "false");
	await expect(page.getByTestId("goal-details")).toHaveCount(0);

	// Opening it shows the goal where it is: the objective in full, status, budget and time used. No form for another.
	await control.click();
	await expect(control).toHaveAttribute("aria-expanded", "true");
	const details = page.getByTestId("goal-details");
	await expect(details).toBeVisible();
	await expect(page.getByTestId("goal-objective-full")).toHaveText(OBJECTIVE);
	// The status is the bar's own: a turn is running, and then omp has settled with the goal still active.
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	await expect(page.getByTestId("goal-detail-status")).toHaveText("Working on goal");
	tap.push({ t: "frame", liveId, frame: { type: "agent_end", isTerminal: true, yielded: true } });
	tap.push({ t: "frame", liveId, frame: { type: "session_settled" } });
	await expect(page.getByTestId("goal-detail-status")).toHaveText("Waiting for you");
	await expect(page.getByTestId("goal-detail-budget")).toHaveText("12,400 / 50,000 (25%) tokens");
	await expect(page.getByTestId("goal-detail-time")).toHaveText("12m 34s");
	await expect(page.getByTestId("goal-detail-fixed")).toContainText("cannot change the objective or the budget");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByTestId("goal-rough")).toHaveCount(0);

	// The bar's own toggle closes and opens it too.
	await bar.getByTestId("goal-toggle").click();
	await expect(details).toHaveCount(0);
	await expect(control).toHaveAttribute("aria-expanded", "false");
	await bar.getByTestId("goal-toggle").click();
	await expect(details).toBeVisible();

	// Pause reaches omp; the panel follows what omp reports.
	await bar.getByRole("button", { name: "Pause goal" }).click();
	await expect.poll(() => ops(tap)).toEqual(["pause"]);
	frame(goal("paused", { tokensUsed: 13_000 }));
	await expect(page.getByTestId("goal-detail-status")).toHaveText("Paused");
	await expect(page.getByTestId("goal-detail-budget")).toHaveText("13,000 / 50,000 (26%) tokens");
	await bar.getByRole("button", { name: "Resume goal" }).click();
	await expect.poll(() => ops(tap)).toEqual(["pause", "resume"]);
	frame(goal("active"));
	await expect(bar).toHaveAttribute("data-status", "active");

	// Drop asks first, and ends the goal: the control then offers a new one again.
	await bar.getByRole("button", { name: "Drop goal" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Drop goal" }).click();
	await expect.poll(() => ops(tap)).toEqual(["pause", "resume", "drop"]);
	frame(goal("dropped"));
	await expect(bar).toHaveCount(0);
	await expect(control).toHaveAccessibleName("Set a goal");
	await control.click();
	await expect(page.getByTestId("goal-rough")).toBeVisible();
	expect(ops(tap)).not.toContain("create");
});

test("a goal without a budget says so, and a new goal starts collapsed", async ({ page }) => {
	const { tap, liveId } = await openWithGoal(page, 0x8b, "Goal control unbudgeted probe");
	const frame = (g: unknown) => tap.push({ t: "frame", liveId, frame: { type: "goal_updated", goal: g } });

	frame(goal("active", { tokenBudget: undefined, tokensUsed: 900, timeUsedSeconds: undefined }));
	await page.getByTestId("open-goal").click();
	await expect(page.getByTestId("goal-detail-budget")).toHaveText("900 tokens used · no budget");
	await expect(page.getByTestId("goal-detail-time")).toHaveText("—");

	// Another goal replaces it: the page does not keep the old one's panel open for it.
	frame(goal("complete"));
	await expect(page.getByTestId("goal-bar")).toHaveCount(0);
	frame(goal("active", { id: "g-next", objective: "Second goal" }));
	await expect(page.getByTestId("goal-bar")).toContainText("Second goal");
	await expect(page.getByTestId("goal-details")).toHaveCount(0);
});

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the header menu's Goal row shows the goal that is running instead of offering a new one", async ({ page }) => {
		const { tap, liveId } = await openWithGoal(page, 0x8c, "Goal control phone probe");
		const menuGoal = async () => {
			await page.getByTestId("chat-more").click();
			return page.getByTestId("chat-more-panel").getByTestId("open-goal");
		};
		await expect(await menuGoal()).toHaveText("Set a goal");
		await page.keyboard.press("Escape");

		tap.push({ t: "frame", liveId, frame: { type: "goal_updated", goal: goal("active") } });
		await expect(page.getByTestId("goal-bar")).toBeVisible();
		const row = await menuGoal();
		await expect(row).toHaveText("Current goal");
		await row.click();
		await expect(page.getByTestId("goal-details")).toBeVisible();
		await expect(page.getByTestId("goal-objective-full")).toHaveText(OBJECTIVE);
		await expect(page.getByTestId("goal-rough")).toHaveCount(0);
	});
});
