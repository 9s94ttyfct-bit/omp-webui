import { expect, test } from "./fixtures.ts";

/**
 * One real run (omp + Claude Haiku 5.5, in the isolated agent dir): the chat lists a subagent as a job while it
 * works, its live view shows what it does, and the conversation's total counts what it cost.
 */

test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");

test("a real subagent is listed while it runs, can be watched, and is counted in the total once done", async ({
	page,
}) => {
	test.setTimeout(300_000);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText(/haiku/i, { timeout: 60_000 });
	await page
		.getByTestId("composer")
		.fill(
			"Use the task tool to spawn exactly one subagent whose assignment is: run `sleep 20; echo subagent-live-ok` with bash and report the output. After it finishes, reply with DONE.",
		);
	await page.getByTestId("send").click();

	// While it works the chat lists it as a job, running, with a clock.
	const block = page.getByTestId("jobs-block");
	await expect(block).toBeVisible({ timeout: 120_000 });
	const job = block.getByTestId("job-row").first();
	await expect(job).toHaveAttribute("data-running", "true");
	await expect(job.getByTestId("job-elapsed")).toHaveText(/^\d+s$/);

	// The row opens its live view: the assignment, then the command it runs, while it runs.
	await job.click();
	const detail = page.getByTestId("subagent-detail");
	await expect(detail).toBeVisible();
	await expect(detail).toContainText("subagent-live-ok", { timeout: 90_000 });

	// Once the parent is done there is nothing left to wait for, and the total counts the subagent. The parent's reply is
	// the main transcript's last: the subagent's live view, open in the panel, has replies of its own, later on the page.
	await expect(page.getByTestId("transcript").getByTestId("msg-assistant").last()).toContainText("DONE", {
		timeout: 180_000,
	});
	await expect(block).toHaveCount(0, { timeout: 30_000 });
	await expect(page.getByTestId("subagent-item").first()).toHaveAttribute("data-running", "false");
	await page.getByTestId("session-cost").hover();
	const split = page.getByTestId("usage-split");
	await expect(split).toBeVisible();
	await expect
		.poll(async () => Number(await split.getAttribute("data-subagent-cost")), { timeout: 30_000 })
		.toBeGreaterThan(0);
	expect(Number(await split.getAttribute("data-main-cost"))).toBeGreaterThan(0);
});
