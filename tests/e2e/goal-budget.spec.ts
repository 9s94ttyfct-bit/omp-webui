import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The goal's token budget is typed the way the page prints amounts (`200k`, `1.5M`). The direct form and the interview's
 * proposal both send omp that amount, or refuse text they cannot read; no model call is made (the goal rpc is answered
 * locally).
 */

test("the budget field reads 200k and 1.5M as the amounts they stand for, and refuses text it cannot read", async ({
	page,
}) => {
	ownSession(0x90, "Goal budget probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	tap.answer("goal", (c) => (c.op === "create" ? { ok: false, error: "forced goal failure" } : undefined));
	await page.goto("/");
	await startLive(page, tap, "Goal budget probe", "goal-budget-probe");

	await page.getByTestId("open-goal").click();
	await page.getByTestId("goal-direct-toggle").click();
	await page.getByTestId("goal-objective").fill("Make the build green");
	const budget = page.getByTestId("goal-budget");
	const hint = page.getByTestId("goal-budget-hint");
	const create = page.getByTestId("goal-create");
	const created = () => tap.commands("goal").filter((c) => c.op === "create");

	// The field keeps what was typed and says what it makes of it.
	await budget.fill("200k");
	await expect(budget).toHaveValue("200k");
	await expect(hint).toHaveText("= 200,000 tokens");
	await create.click();
	await expect.poll(() => created().length).toBe(1);
	expect(created()[0]).toMatchObject({ objective: "Make the build green", token_budget: 200_000 });

	await budget.fill("1.5M");
	await expect(hint).toHaveText("= 1,500,000 tokens");
	await create.click();
	await expect.poll(() => created().length).toBe(2);
	expect(created()[1].token_budget).toBe(1_500_000);

	// Text that is no amount is said so and nothing is sent: it would otherwise start a goal with a budget nobody typed.
	for (const bad of ["1e6", "2,5M", "lots"]) {
		await budget.fill(bad);
		await expect(hint).toContainText("Not a token amount");
		await expect(budget).toHaveAttribute("aria-invalid", "true");
		await expect(create).toBeDisabled();
	}
	await page.waitForTimeout(300);
	expect(created()).toHaveLength(2);

	// No budget at all is no limit.
	await budget.fill("");
	await expect(hint).toHaveCount(0);
	await create.click();
	await expect.poll(() => created().length).toBe(3);
	expect("token_budget" in created()[2]).toBe(false);
});
