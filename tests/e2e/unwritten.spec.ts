import { expect, test } from "./fixtures.ts";

/** omp writes a session file only with the first assistant message; until then the chat shows the live transcript. */

test("a new chat's first command shows without an error before omp writes the session file (no model call)", async ({
	page,
}) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await page.getByTestId("composer").fill("!echo unwritten-$((6*7))");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByText("unwritten-42")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText("Unknown session file")).toHaveCount(0);
	await expect(page.getByRole("status").filter({ hasText: /loading/i })).toHaveCount(0);
});
