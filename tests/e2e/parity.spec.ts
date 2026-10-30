import { fullInventory } from "../parity/inventory.ts";
import { type InventoryItem, surfaceFor } from "../parity/mapping.ts";
import { FIXTURE } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Every omp CLI capability (subcommands, flags, slash commands — read from
 * the installed omp, independently of the UI) is reachable in the web UI.
 */

let inventory: InventoryItem[] = [];
test.beforeAll(async () => {
	inventory = await fullInventory();
	expect(inventory.filter((i) => i.kind === "command").length).toBeGreaterThan(10);
	expect(inventory.filter((i) => i.kind === "slash").length).toBeGreaterThan(10);
});

test("every omp subcommand has an entry on the Commands page", async ({ page }) => {
	await page.goto("/#/cli");
	await expect(page.getByTestId("cli-command").first()).toBeVisible();
	for (const item of inventory.filter((i) => i.kind === "command")) {
		await expect(page.locator(`[data-testid="cli-command"][data-command="${item.name}"]`), item.name).toHaveCount(1);
	}
});

test("every session flag is an option on the new-chat page", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: /Options/ }).click();
	const form = page.getByTestId("flag-form");
	await expect(form).toBeVisible();
	for (const item of inventory.filter((i) => i.kind === "flag")) {
		const s = surfaceFor(item);
		if (s.kind !== "session-option") continue;
		await expect(form.locator(`[data-flag="${s.flag}"]`), s.flag).toHaveCount(1);
	}
});

test("flags with dedicated controls are present", async ({ page }) => {
	const controls = inventory.map(surfaceFor).filter((s) => s.kind === "control");
	await page.goto("/");
	for (const s of controls.filter((c) => c.route === "/"))
		await expect(page.getByTestId(s.testid).first(), s.testid).toBeVisible();
	await page.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
	for (const s of controls.filter((c) => c.route === "fixture-chat"))
		await expect(page.getByTestId(s.testid), s.testid).toBeVisible();
	// --export: the button downloads omp's own HTML export.
	const download = page.waitForEvent("download");
	await page.getByTestId("export-html").click();
	expect((await download).suggestedFilename()).toMatch(/\.html$/);
});

test("command-line-only flags run in the terminal", async ({ page, context }) => {
	const flags = inventory.filter((i) => i.kind === "flag" && surfaceFor(i).kind === "command-line").map((i) => i.name);
	expect(flags.length).toBeGreaterThan(0);
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto("/#/cli");
	await page.getByTestId("cli-line").fill("--help");
	await page.getByTestId("cli-run").click();
	await expect(page.getByTestId("terminal-status")).toHaveText(/exited 0/, { timeout: 30_000 });
	await page.getByTestId("terminal-copy").click();
	const output = await page.evaluate(() => navigator.clipboard.readText());
	for (const f of flags) expect(output, f).toContain(f);
});

test("every slash command is offered by the composer", async ({ page }) => {
	await page.goto("/");
	const composer = page.getByTestId("composer");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	for (const item of inventory.filter((i) => i.kind === "slash")) {
		await composer.fill(`/${item.name}`);
		await expect(
			page
				.getByTestId("slash-menu")
				.getByRole("option", { name: new RegExp(`^/${item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) })
				.first(),
			item.name,
		).toBeVisible();
	}
});
