import { rmSync } from "node:fs";
import { writeSimpleSession } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/** The composer stays editable and focused while a send is in flight, and the finished send leaves new input alone (no model call). */

test("typing right after Enter lands in the composer while the conversation resumes", async ({ page }) => {
	const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0x60, "Focus source");
	try {
		await page.goto("/");
		await page.locator('[data-testid="session-item"]', { hasText: "Focus source" }).click();
		const composer = page.getByTestId("composer");
		// A `!command` resumes the conversation's omp process (the send is in flight meanwhile), then runs without the model.
		await composer.fill("!echo focus-$((6*7))");
		await composer.press("Enter");
		// No click in between: the next message is typed while the first one is still being sent.
		await page.keyboard.type("typed straight away");
		await expect(composer).toHaveValue("typed straight away");
		await expect(composer).toBeFocused();

		await expect(page.getByText("focus-42")).toBeVisible({ timeout: 30_000 });
		// The send has finished; it must not wipe what was typed meanwhile.
		await expect(composer).toHaveValue("typed straight away");
		await expect(composer).toBeFocused();
	} finally {
		rmSync(file, { force: true });
	}
});
