import { FIXTURE_FILES } from "../support/fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A copy button says "copied" only when the clipboard took the text. A write the browser refuses (no focus, permission
 * refused) or a page with no clipboard at all (an `http:` address other than localhost) is said in a toast, and the
 * button keeps its copy icon (no model call).
 */

const gammaRow = (page: Page) => page.locator(`[data-testid="session-item"][data-file$="${FIXTURE_FILES.gamma}"]`);
const prompt = (page: Page) => page.locator('[data-testid="msg-user"]', { hasText: "config files" }).first();

async function copyPrompt(page: Page) {
	await page.goto("/");
	await gammaRow(page).click();
	await prompt(page).hover();
	const button = prompt(page).getByRole("button", { name: "Copy message" });
	await button.click();
	return button;
}

test("a copy the browser refuses is said, and the button does not claim it was copied", async ({ page }) => {
	await page.addInitScript(() => {
		navigator.clipboard.writeText = () =>
			Promise.reject(new DOMException("Document is not focused", "NotAllowedError"));
	});
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	const button = await copyPrompt(page);
	await expect(page.getByTestId("toast-text")).toContainText("Could not copy");
	await expect(button.locator("svg.lucide-check")).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("a page with no clipboard says it could not copy instead of throwing", async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined });
	});
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	const button = await copyPrompt(page);
	await expect(page.getByTestId("toast-text")).toContainText("Could not copy");
	await expect(button.locator("svg.lucide-check")).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("a copy the clipboard takes shows the check", async ({ page, context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const button = await copyPrompt(page);
	await expect(button.locator("svg.lucide-check")).toHaveCount(1);
	expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("config files");
	await expect(page.getByTestId("toast-text")).toHaveCount(0);
});

test("the terminal's Copy output says it could not copy, instead of failing unseen", async ({ page }) => {
	await page.addInitScript(() => {
		navigator.clipboard.writeText = () =>
			Promise.reject(new DOMException("Document is not focused", "NotAllowedError"));
	});
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/#/cli");
	await page.getByTestId("cli-line").fill("--version");
	await page.getByTestId("cli-run").click();
	await expect(page.getByTestId("terminal-status")).toHaveText(/exited 0/, { timeout: 30_000 });
	await page.getByTestId("terminal-copy").click();
	await expect(page.getByTestId("toast-text")).toContainText("Could not copy");
	await expect(page.getByTestId("terminal-copy").locator("svg.lucide-check")).toHaveCount(0);
	expect(errors).toEqual([]);
});
