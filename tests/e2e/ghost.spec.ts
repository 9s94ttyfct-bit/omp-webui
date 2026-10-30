import { expect, test } from "./fixtures.ts";

/** Word-prediction ghost text from omp's `predict_word` (real omp; session model Claude Haiku 5.5). */

test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");

test("ghost text from predict_word: Tab accepts, typing elsewhere rejects, feedback both ways", async ({ page }) => {
	const feedback: { suggestion: string; accepted: boolean }[] = [];
	page.on("websocket", (ws) =>
		ws.on("framesent", (f) => {
			const text = typeof f.payload === "string" ? f.payload : f.payload.toString();
			if (!text.includes("predict_word_feedback")) return;
			const cmd = JSON.parse(text).command;
			feedback.push({ suggestion: cmd.suggestion, accepted: cmd.accepted });
		}),
	);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText(/haiku/i, { timeout: 60_000 });

	const composer = page.getByTestId("composer");
	const ghost = page.getByTestId("ghost");
	await composer.pressSequentially("Please refa");
	await expect(ghost).toHaveText("ctoring");
	await composer.pressSequentially("ct");
	await expect(ghost).toHaveText("oring");
	await composer.press("Tab");
	await expect(composer).toHaveValue("Please refactoring ");
	await expect(ghost).toHaveCount(0);
	await expect.poll(() => feedback).toContainEqual({ suggestion: "ctoring", accepted: true });

	await composer.pressSequentially("the impl");
	await expect(ghost).toHaveText("ementation");
	await composer.pressSequentially("q");
	await expect(ghost).toHaveCount(0);
	await expect.poll(() => feedback).toContainEqual({ suggestion: "ementation", accepted: false });
	await expect(composer).toHaveValue("Please refactoring the implq");
});
