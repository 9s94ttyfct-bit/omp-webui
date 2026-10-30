import { expect, type Page, test } from "./fixtures.ts";

/** omp goal mode from the web UI (real omp + Claude Haiku 5.5). Each test uses its own new session. */

test.describe.configure({ mode: "serial" });
test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");

async function newChatPage(page: Page) {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText(/haiku/i, { timeout: 60_000 });
}

test("a goal started from the new-chat page, with the interview skipped, runs to completion", async ({ page }) => {
	await newChatPage(page);
	await page.getByTestId("goal-mode").click();
	await expect(page.getByTestId("goal-mode")).toHaveAttribute("aria-pressed", "true");
	await page.getByTestId("goal-direct").click();
	await page.getByTestId("composer").fill("Reply with the single word GOALDONE, then mark the goal complete.");
	await page.getByTestId("send").click();
	await expect(page.getByTestId("goal-bar")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("msg-assistant").last()).toContainText("GOALDONE", { timeout: 90_000 });
	await expect(page.getByTestId("goal-bar")).toHaveCount(0, { timeout: 90_000 });
});

test("a goal can be set, paused, resumed and dropped in a conversation", async ({ page }) => {
	await newChatPage(page);
	await page.getByTestId("composer").fill("Reply with the single word READY and nothing else.");
	await page.getByTestId("send").click();
	await expect(page.getByTestId("msg-assistant").last()).toContainText("READY", { timeout: 90_000 });
	await page.getByTestId("open-goal").click();
	await page.getByTestId("goal-direct-toggle").click();
	await page
		.getByTestId("goal-objective")
		.fill("Wait for the user. Do not take any action and do not complete this goal.");
	await page.getByTestId("goal-budget").fill("50000");
	await page.getByTestId("goal-create").click();
	const bar = page.getByTestId("goal-bar");
	await expect(bar).toBeVisible({ timeout: 60_000 });
	await expect(bar.getByTestId("goal-tokens")).toContainText("50k");
	await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 90_000 });
	await bar.getByRole("button", { name: "Pause goal" }).click();
	await expect(bar).toHaveAttribute("data-status", "paused");
	await bar.getByRole("button", { name: "Resume goal" }).click();
	await expect(bar).toHaveAttribute("data-status", "active");
	await bar.getByRole("button", { name: "Drop goal" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Drop goal" }).click();
	await expect(bar).toHaveCount(0);
});

test("Pause goal lets the agent finish its current step, then no more turns; Resume starts working again", async ({
	page,
}) => {
	await newChatPage(page);
	await page.getByTestId("goal-mode").click();
	await page.getByTestId("goal-direct").click();
	await page
		.getByTestId("composer")
		.fill(
			"Run the bash command `sleep 5 && echo tick` exactly once, then reply with one short sentence. Do not mark the goal complete; more work follows later.",
		);
	await page.getByTestId("send").click();
	const bar = page.getByTestId("goal-bar");
	await expect(bar).toHaveAttribute("data-status", "active", { timeout: 60_000 });
	// Pause while the command runs: only the goal pauses, the command and the turn carry on to their end.
	const tick = page.getByRole("button", { name: /echo tick/ }).first();
	await expect(tick).toBeVisible({ timeout: 60_000 });
	await bar.getByRole("button", { name: "Pause goal" }).click();
	await expect(bar).toHaveAttribute("data-status", "paused");
	await expect(bar.getByTestId("goal-state")).toHaveText("Pausing · finishing the current step");
	await expect(page.getByTestId("stop")).toBeVisible();
	// Done: the row says so, after when the command started (#691) and how long it ran (the tool timer, #657).
	await expect(page.getByRole("button", { name: /echo tick( [\d:hms. ]+)? Done$/ })).toHaveCount(1, {
		timeout: 30_000,
	});
	// The turn ends, and no new one starts for the goal: it stays paused.
	await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 60_000 });
	await expect(bar.getByTestId("goal-state")).toHaveText("Paused");
	const replies = await page.getByTestId("msg-assistant").count();
	await page.waitForTimeout(8000);
	await expect(page.getByTestId("stop")).toHaveCount(0);
	expect(await page.getByTestId("msg-assistant").count()).toBe(replies);
	await expect(bar).toHaveAttribute("data-status", "paused");

	// Resume: goal mode is on again and omp starts working on its own.
	await bar.getByRole("button", { name: "Resume goal" }).click();
	await expect(bar).toHaveAttribute("data-status", "active");
	await expect(page.getByTestId("stop")).toBeVisible({ timeout: 30_000 });
	await bar.getByRole("button", { name: "Drop goal" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Drop goal" }).click();
	await expect(bar).toHaveCount(0);
});

/**
 * Answer omp's questions the way a user would, until it proposes the goal: a question form is submitted with its
 * recommended answers, and a question asked in plain text gets a short reply.
 */
async function answerUntilProposal(page: Page): Promise<void> {
	const dialog = page.getByTestId("ui-request");
	const state = async () => {
		const method = await dialog
			.first()
			.getAttribute("data-method", { timeout: 1 })
			.catch(() => null);
		if (method === "propose_goal" || method === "ask") return method;
		if (method) return "other";
		// Between turns: omp is waiting for the user's words.
		const idle =
			(await page.getByTestId("stop").count()) === 0 && (await page.getByTestId("msg-assistant").count()) > 0;
		return idle ? "idle" : "working";
	};
	for (let round = 0; round < 8; round++) {
		await expect.poll(state, { timeout: 120_000 }).not.toBe("working");
		const now = await state();
		if (now === "propose_goal") return;
		if (now === "ask") await dialog.getByRole("button", { name: "Submit answers" }).click();
		else if (now === "idle") {
			await page.getByTestId("composer").fill("That is everything. Please propose the goal now.");
			await page.getByTestId("send").click();
		}
	}
	throw new Error("omp never proposed a goal");
}

test("a guided goal from the new-chat page: omp interviews, the proposal is confirmed and goal mode starts", async ({
	page,
}) => {
	await newChatPage(page);
	await page.getByTestId("goal-mode").click();
	await page
		.getByTestId("composer")
		.fill("Reply with the single word GUIDED and nothing else, then mark the goal complete. Nothing more to it.");
	await page.getByTestId("send").click();
	// The conversation opens on the interview, and omp's questions arrive in the chat.
	await expect(page.getByTestId("guided-bar").or(page.getByTestId("ui-request"))).toBeVisible({ timeout: 60_000 });
	await answerUntilProposal(page);

	// Nothing has started: the proposal is for the user to confirm, with an objective and its criteria filled in.
	await expect(page.getByTestId("goal-bar")).toHaveCount(0);
	await expect(page.getByTestId("proposal-objective")).not.toHaveValue("");
	await expect(page.getByTestId("proposal-criteria")).not.toHaveValue("");
	await page.getByTestId("proposal-start").click();
	await expect(page.getByTestId("goal-bar")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("ui-request")).toHaveCount(0);
	await expect(page.getByTestId("guided-bar")).toHaveCount(0);

	// omp works toward the goal on its own, and the goal ends when it is done.
	await expect(page.getByTestId("msg-assistant").last()).toContainText("GUIDED", { timeout: 120_000 });
	await expect(page.getByTestId("goal-bar")).toHaveCount(0, { timeout: 120_000 });
});

test("cancelling a guided goal after the first question leaves no goal and the conversation goes on", async ({
	page,
}) => {
	await newChatPage(page);
	await page.getByTestId("goal-mode").click();
	await page.getByTestId("composer").fill("make the project better");
	await page.getByTestId("send").click();
	await expect(page.getByTestId("guided-bar").or(page.getByTestId("ui-request"))).toBeVisible({ timeout: 60_000 });
	// Whatever omp is doing, the bar's Cancel ends the interview (it stops a turn under way).
	await expect(page.getByTestId("guided-bar")).toBeVisible();
	await page.getByTestId("guided-cancel").click();
	await expect(page.getByTestId("guided-bar")).toHaveCount(0);
	await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 60_000 });
	await expect(page.getByTestId("goal-bar")).toHaveCount(0);

	// The conversation is ordinary again.
	await page.getByTestId("composer").fill("Reply with the single word FREE and nothing else.");
	await page.getByTestId("send").click();
	await expect(page.getByTestId("msg-assistant").last()).toContainText("FREE", { timeout: 90_000 });
});
