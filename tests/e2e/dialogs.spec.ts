import { newChatIn } from "../support/new-chat.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** omp's interactive dialogs rendered inline: tool approvals and the ask tool (real omp + Claude Haiku 5.5). */

test.describe.configure({ mode: "serial" });
test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");

async function newChat(page: Page, mode?: "always-ask" | "write" | "yolo") {
	await page.goto(newChatIn(process.env.OMPW_E2E_WORK as string));
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
	// omp 18.19 and later ask an `ask` form one field at a time: a `select` for a choice (with "Other (type your own)", which
	// asks an `input`), the same `select` again after each pick of a checkbox until "Done selecting".
	await expect(dialog).toHaveAttribute("data-method", "select", { timeout: 90_000 });
	// Reloading while omp waits must bring the dialog back: the server replays pending dialogs.
	await page.reload();
	await expect(dialog).toHaveAttribute("data-method", "select", { timeout: 30_000 });
	await expect(dialog).toHaveCount(1);
	const option = (name: string | RegExp) => dialog.getByRole("button", { name });
	const picked = new Set<string>();
	/** What the open request is, to tell when the next one (or none) took its place. */
	const now = async () =>
		(await dialog.count()) ? `${await dialog.getAttribute("data-method")} ${await dialog.innerText()}` : "";
	const reply = page.getByTestId("msg-assistant").last();
	const answered = async () => /COLOR=/i.test(await reply.innerText().catch(() => ""));
	// The model chooses the order of the two fields; each step answers whichever is asked. Between two fields no request
	// is open for a moment, so the next one (or the reply) is waited for, not taken for the end.
	for (let step = 0; step < 10; step++) {
		await expect.poll(async () => (await dialog.count()) > 0 || (await answered()), { timeout: 60_000 }).toBe(true);
		if ((await dialog.count()) === 0) break;
		const before = await now();
		if ((await dialog.getAttribute("data-method")) === "input") {
			await dialog.getByLabel("Response").fill("Green");
			await dialog.getByRole("button", { name: "Submit" }).click();
		} else if ((await option("Cat").count()) > 0) {
			const next = ["Cat", "Fish"].find((p) => !picked.has(p));
			if (next) picked.add(next);
			await option(next ?? /Done selecting/).click();
		} else await option(/Other \(type your own\)/).click();
		await expect.poll(now, { timeout: 30_000 }).not.toBe(before);
	}
	await expect(reply).toContainText(/COLOR=Green/i, { timeout: 90_000 });
	await expect(reply).toContainText(/Cat/);
	await expect(reply).toContainText(/Fish/);
});
