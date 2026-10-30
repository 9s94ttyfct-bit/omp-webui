import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { Chain, writeRenderSession } from "../support/render-fixtures.ts";
import { rpcState } from "../support/rpc-state.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * What the goal bar and the status line say for each state omp's goal can be in. The goal arrives as pushed frames and
 * the RPCs are answered locally, so no model call is made; the frames are the ones omp 18.12.3 sends (see
 * tests/contract/goal-sync.test.ts, which pins them against the real omp).
 */

const goal = (status: string, extra: Record<string, unknown> = {}) => ({
	id: "g-states",
	objective: "Ship the release notes",
	status,
	tokenBudget: 100,
	tokensUsed: 1640,
	...extra,
});

test("a goal whose budget is spent stays on screen as such: its figures and Drop, no Pause, and no new goal is offered", async ({
	page,
}) => {
	ownSession(0x91, "Goal spent probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	tap.answer("goal", (c) => (c.op === "drop" ? { ok: true, data: { goal: null, state: null } } : undefined));
	await page.goto("/");
	const liveId = await startLive(page, tap, "Goal spent probe", "goal-spent-probe");
	const frame = (g: unknown) => tap.push({ t: "frame", liveId, frame: { type: "goal_updated", goal: g } });

	frame(goal("active"));
	const bar = page.getByTestId("goal-bar");
	await expect(bar).toHaveAttribute("data-status", "active");

	// omp: `goal_updated` with `budget-limited`, goal mode still on. The bar stays, saying why nothing goes on.
	frame(goal("budget-limited"));
	await expect(bar).toHaveAttribute("data-status", "budget-limited");
	await expect(bar.getByTestId("goal-state")).toHaveText("Budget reached");
	await expect(bar.getByTestId("goal-tokens")).toHaveText("1.6k / 100 tokens");
	await expect(bar.getByTestId("goal-hint")).toBeVisible();
	// omp ignores `resume` on it and a Pause would only bring another wrap-up turn over the budget: Drop is the way on.
	await expect(bar.getByRole("button", { name: "Resume goal" })).toHaveCount(0);
	await expect(bar.getByRole("button", { name: "Pause goal" })).toHaveCount(0);
	const status = page.getByTestId("status-goal");
	await expect(status).toContainText("Goal 1.6k / 100");
	await expect(status).toContainText("budget reached");
	await expect(status).toHaveAttribute("data-status", "budget-limited");

	// The Goal control shows the goal instead of offering another: omp refuses a second one (`A goal is already
	// active`), and a form for it would only lead to that refusal. Nothing is sent.
	const sentBefore = tap.sent.length;
	await page.getByTestId("open-goal").click();
	await expect(page.getByTestId("goal-details")).toBeVisible();
	await expect(page.getByTestId("goal-detail-status")).toHaveText("Budget reached");
	await expect(page.getByTestId("goal-detail-budget")).toHaveText("1,640 / 100 (100%) tokens");
	await expect(page.getByTestId("goal-rough")).toHaveCount(0);
	await expect(page.getByTestId("goal-objective")).toHaveCount(0);
	await page.waitForTimeout(300);
	expect(tap.sent.slice(sentBefore).filter((m) => m.t === "rpc" && m.command?.type === "prompt")).toEqual([]);
	expect(tap.commands("goal").filter((c) => c.op === "create")).toEqual([]);

	// Drop asks, and ends it: omp reports the goal dropped.
	await bar.getByRole("button", { name: "Drop goal" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Drop goal" }).click();
	await expect.poll(() => tap.commands("goal").filter((c) => c.op === "drop").length).toBe(1);
	frame(goal("dropped"));
	await expect(bar).toHaveCount(0);
	await expect(page.getByTestId("status-goal")).toHaveCount(0);
});

test("a goal whose budget was spent in the terminal shows as spent when the conversation is opened", async ({
	page,
}) => {
	const c = new Chain("gl");
	c.user("Spent goal probe");
	c.assistant([{ type: "text", text: "Wrapping up." }]);
	c.modeChange("goal", { ...goal("budget-limited"), tokensUsed: 80_000, tokenBudget: 80_000 });
	writeRenderSession(process.env.OMPW_E2E_AGENT_DIR as string, "01a00000-0000-7000-8000-0000000060b1", c.entries);
	const tap = await tapSocket(page);
	await page.goto("/");
	await sessionRow(page, "Spent goal probe").click();

	const bar = page.getByTestId("goal-bar");
	await expect(bar).toBeVisible({ timeout: 15_000 });
	await expect(bar).toHaveAttribute("data-status", "budget-limited");
	await expect(bar.getByTestId("goal-state")).toHaveText("Budget reached");
	await expect(bar.getByTestId("goal-tokens")).toContainText("80k / 80k");
	// Nothing runs for it yet.
	expect(tap.sent.filter((m) => m.t === "open" && m.target?.kind === "resume")).toEqual([]);
});

test("an active goal omp has stopped continuing says it waits for the user; between two turns it still works", async ({
	page,
}) => {
	ownSession(0x92, "Goal waiting probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Goal waiting probe", "goal-waiting-probe");
	// The pushed frames play a run the real (idle) omp is not in: its own answers would say it is settled.
	tap.answer("get_state", () => ({ ok: true, data: rpcState() }));
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const state = page.getByTestId("goal-bar").getByTestId("goal-state");
	const end = { type: "agent_end", isTerminal: true, yielded: true };

	frame({ type: "goal_updated", goal: goal("active", { tokenBudget: 50_000, tokensUsed: 12 }) });
	frame({ type: "agent_start" });
	await expect(state).toHaveText("Working on goal");

	// omp ends a turn and starts the next one a millisecond later: the goal run is not over.
	frame(end);
	await expect(state).toHaveText("Working on goal");
	frame({ type: "agent_start" });
	frame(end);
	await expect(state).toHaveText("Working on goal");

	// omp says it is settled with the goal still active (a turn with nothing new done): nothing runs, it waits.
	frame({ type: "session_settled" });
	await expect(state).toHaveText("Waiting for you");
	await expect(page.getByTestId("goal-bar").getByTestId("goal-hint")).toContainText("Send a message to go on");
	await expect(page.getByTestId("goal-bar")).toHaveAttribute("data-status", "active");

	// The user's message re-arms it.
	frame({ type: "agent_start" });
	await expect(state).toHaveText("Working on goal");
	frame(end);
	frame({ type: "session_settled" });
	await expect(state).toHaveText("Waiting for you");

	// omp does not continue a goal while every open todo is blocked, and the bar says why.
	tap.answer("get_state", () => ({
		ok: true,
		data: rpcState({
			isSettled: true,
			todoPhases: [{ name: "Build", tasks: [{ content: "Deploy", status: "blocked", blocker: "no credentials" }] }],
		}),
	}));
	frame({ type: "tool_execution_end", toolCallId: "todo-1", toolName: "todo", result: {} });
	await expect(state).toHaveText("Waiting for you · every open todo is blocked");
	await expect(page.getByTestId("goal-bar").getByTestId("goal-hint")).toContainText("Unblock a todo");

	// A paused goal is not waiting for anything: the bar says Paused, as it always did.
	frame({ type: "goal_updated", goal: goal("paused") });
	await expect(state).toHaveText("Paused");
	await expect(page.getByTestId("goal-bar").getByTestId("goal-hint")).toHaveCount(0);
});

test("Settings lists a process between two goal turns as working, as the sidebar does, and not once omp says it is settled", async ({
	page,
}) => {
	ownSession(0x93, "Goal running list probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Goal running list probe", "goal-running-list-probe");
	tap.answer("get_state", () => ({ ok: true, data: rpcState() }));
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	frame({ type: "goal_updated", goal: goal("active", { tokenBudget: 50_000, tokensUsed: 12 }) });
	frame({ type: "agent_start" });
	// The turn ended and the goal's next one has not started: nothing streams, the run goes on.
	frame({ type: "agent_end", isTerminal: true, yielded: true });
	await expect(page.getByTestId("goal-bar").getByTestId("goal-state")).toHaveText("Working on goal");

	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(page.getByTestId("settings-page")).toBeVisible();
	await page.locator('[data-testid="settings-page-tab"][data-page="app"]').click();
	const row = page.getByTestId("running-session").filter({ hasText: "Goal running list probe" });
	await expect(row.getByTestId("running-status")).toHaveText("working");

	frame({ type: "session_settled" });
	await expect(row.getByTestId("running-status")).not.toHaveText("working");
});
