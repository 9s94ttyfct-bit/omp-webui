import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";

/** `@file` mention completion in the composer, expanded by omp (real omp + Claude Haiku 5.5). */

test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");

test("@ completes paths in the working directory and omp reads the mentioned file", async ({ page }) => {
	const work = process.env.OMPW_E2E_WORK as string;
	mkdirSync(join(work, "docs"), { recursive: true });
	writeFileSync(join(work, "docs", "mention-notes.txt"), "The secret word is MARMALADE.\n");
	mkdirSync(join(work, "node_modules", "pkg"), { recursive: true });
	writeFileSync(join(work, "node_modules", "pkg", "mention-notes.txt"), "ignored\n");

	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), work);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText(/haiku/i, { timeout: 60_000 });

	const composer = page.getByTestId("composer");
	await composer.fill("What is the secret word in @mention-no");
	const menu = page.getByRole("listbox", { name: "Files" });
	await expect(menu.getByRole("option", { name: "@docs/mention-notes.txt" })).toBeVisible();
	await expect(menu.getByRole("option", { name: /node_modules/ })).toHaveCount(0);
	await composer.press("Enter");
	await expect(composer).toHaveValue("What is the secret word in @docs/mention-notes.txt ");

	await composer.pressSequentially("? Reply with just the word.");
	await composer.press("Enter");
	await expect(page.getByTestId("msg-assistant").last()).toContainText("MARMALADE", { timeout: 90_000 });
	await expect(page.getByRole("button", { name: "Read @docs/mention-notes.txt" })).toBeVisible();
});
