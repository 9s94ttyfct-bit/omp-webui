import { expect, test } from "./fixtures.ts";

/**
 * The command line of Commands & terminal (#404): a quote opened and never closed is said and not run, as if it had closed
 * at the end of the line; closed, the same line runs. `omp --version` is the harmless command run. No model call.
 */

test("a line with an unclosed quote is not run, says so, and runs once the quote is closed", async ({ page }) => {
	await page.goto("/#/cli");
	const line = page.getByTestId("cli-line");
	await line.fill('"--version');
	await page.getByTestId("cli-run").click();
	await expect(page.getByTestId("cli-line-error")).toContainText("never closed");
	await expect(page.getByTestId("terminal-status")).toHaveCount(0);

	// Typing again takes the message away; the closed quote runs the command.
	await line.fill('"--version"');
	await expect(page.getByTestId("cli-line-error")).toHaveCount(0);
	await page.getByTestId("cli-run").click();
	await expect(page.getByTestId("terminal-status")).toContainText("exited");
	await expect(page.getByTestId("cli-line-error")).toHaveCount(0);
});
