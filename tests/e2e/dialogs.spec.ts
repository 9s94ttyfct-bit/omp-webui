import { expect, type Page, test } from "./fixtures.ts";

/** omp's interactive dialogs rendered inline: tool approvals and the ask tool (real omp + Claude Haiku 5.5). */

test.describe.configure({ mode: "serial" });
test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");

async function newChat(page: Page, mode?: "always-ask" | "write" | "yolo") {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText(/haiku/i, { timeout: 60_000 });
	if (mode) {
		await page.getByTestId("approval-picker").click();
		await page.getByTestId(`approval-${mode}`).click();
		await expect(page.getByTestId("approval-picker")).toHaveAttribute("data-mode", mode);
	}
}

test("tool approvals: allow runs the tool, deny refuses it", async ({ page }) => {
	await newChat(page, "always-ask");
	await page.getByTestId("composer").fill("Run `echo approved-run` with bash. If it is refused, reply REFUSED.");
	await page.getByTestId("send").click();
	const dialog = page.getByTestId("ui-request");
	await expect(dialog).toBeVisible({ timeout: 90_000 });
	await expect(dialog).toContainText(/bash|echo/i);
	await dialog
		.getByRole("button", { name: /^(Allow|Approve|Yes)/ })
		.first()
		.click();
	await expect(page.locator('[data-testid="tool-card"][data-tool="bash"]')).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 90_000 });

	await page
		.getByTestId("composer")
		.fill("Now run `echo second-run` with bash. If it is refused, reply with the single word REFUSED.");
	await page.getByTestId("send").click();
	await expect(dialog).toBeVisible({ timeout: 90_000 });
	await dialog
		.getByRole("button", { name: /^(Deny|Reject|No|Cancel)/ })
		.first()
		.click();
	await expect(page.getByTestId("msg-assistant").last()).toContainText("REFUSED", { timeout: 90_000 });
});

test("the ask tool shows a question form and the model receives the answers", async ({ page }) => {
	await newChat(page);
	await page
		.getByTestId("composer")
		.fill(
			"Use the ask tool exactly once with two questions: (1) id 'color', single choice between 'Red' and 'Blue'; (2) id 'pets', multiple choice among 'Cat', 'Dog', 'Fish'. After I answer, reply with my answers in the form COLOR=<choice>; PETS=<comma-separated choices>.",
		);
	await page.getByTestId("send").click();
	const dialog = page.getByTestId("ui-request");
	await expect(dialog).toHaveAttribute("data-method", "ask", { timeout: 90_000 });
	// Reloading while omp waits must bring the dialog back: the server replays pending dialogs.
	await page.reload();
	await expect(dialog).toHaveAttribute("data-method", "ask", { timeout: 30_000 });
	await expect(dialog).toHaveCount(1);
	// One question per step (#588): the colour answered with free text ("Other…"), the pets with two options.
	for (const step of [0, 1]) {
		if (await dialog.getByLabel("Cat").count()) {
			await dialog.getByLabel("Cat").check();
			await dialog.getByLabel("Fish").check();
		} else await dialog.getByPlaceholder("Other…").first().fill("Green");
		if (step === 0) await dialog.getByRole("button", { name: "Next" }).click();
	}
	await dialog.getByRole("button", { name: "Submit answers" }).click();
	const reply = page.getByTestId("msg-assistant").last();
	await expect(reply).toContainText(/COLOR=Green/i, { timeout: 90_000 });
	await expect(reply).toContainText(/Cat/);
	await expect(reply).toContainText(/Fish/);
});
