import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ISOLATED_DIR } from "@shared/isolated-env.ts";
import type { LiveInfo } from "@shared/protocol.ts";
import { newChatIn } from "../support/new-chat.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A project folder's isolated environment (docs/superpowers/specs/2026-11-14-isolated-project-env-design.md) as the page
 * shows it: New chat's switch is the folder's (a flip acts on the warm-up process at once), the conversation's header says
 * what its process has, and a process started before the folder was switched says a restart applies it. That the variables
 * reach omp, the spare and the Terminal tab is `tests/contract/isolated-env.test.ts`'s.
 */

test.describe.configure({ mode: "serial" });

const lives = async (page: Page) => (await (await page.request.get("/api/lives")).json()) as LiveInfo[];

/** A fresh folder of the test's own in the worker's work folder (not the projects folder, not home: those are refused). */
function freshFolder(name: string): { folder: string; real: string } {
	const folder = join(process.env.OMPW_E2E_WORK as string, `${name}-${Date.now().toString(36)}`);
	mkdirSync(folder, { recursive: true });
	return { folder, real: realpathSync(folder) };
}

test("New chat's switch makes the folder isolated, its conversation is marked, and switched off again the running one asks for a restart", async ({
	page,
}) => {
	const { folder, real } = freshFolder("iso-on");
	await page.goto(newChatIn(folder));
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	const toggle = page.getByTestId("isolation-toggle");
	// A folder nothing has switched on is not isolated.
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(toggle).not.toHaveAttribute("aria-disabled", "true");

	// A flip switches the folder on and starts the warm-up process again in it.
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await expect
		.poll(async () => (await lives(page)).some((l) => !l.exited && l.isolated === real), { timeout: 30_000 })
		.toBe(true);
	expect(existsSync(join(folder, ISOLATED_DIR))).toBe(true);

	// The first message is run by that process: its commands see the variables, and its header says it is isolated.
	const composer = page.getByTestId("composer");
	await composer.fill('!echo "iso:$OMPW_ISOLATED_ENV"');
	// The flip started the warm-up process again: until it runs, New chat keeps the draft and says it is starting.
	await expect(async () => {
		if ((await composer.inputValue()) !== "") await composer.press("Enter");
		await expect(composer).toHaveValue("", { timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
	await expect(page.getByText(`iso:${join(real, ISOLATED_DIR)}`, { exact: true })).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("isolated-badge")).toBeVisible();
	const conversation = page.url();

	// New chat in the same folder shows what the folder is now: on.
	await page.goto(newChatIn(folder));
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
	// Switched off: the folder is, and the conversation started before says a restart applies it.
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect
		.poll(async () => (await lives(page)).some((l) => !l.exited && l.isolationStale === true), { timeout: 30_000 })
		.toBe(true);
	await page.goto(conversation);
	await expect(page.getByTestId("isolated-stale")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("isolated-badge")).toHaveCount(0);
});

test("a running conversation switches its folder from the header, restarts when the person says, and is isolated then; switched back the same way", async ({
	page,
}) => {
	const { folder, real } = freshFolder("iso-later");
	await page.goto(newChatIn(folder));
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	const composer = page.getByTestId("composer");
	const echo = async (tag: string) => {
		await composer.fill(`!echo "${tag}:$OMPW_ISOLATED_ENV."`);
		await composer.press("Enter");
	};
	await echo("before");
	await expect(page.getByText("before:.", { exact: true })).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("isolated-badge")).toHaveCount(0);

	// The header's switch, beside the guard's: the folder is switched at once, and the title says a restart applies it.
	const toggle = page.getByTestId("header-isolation").getByTestId("isolation-toggle");
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	expect(existsSync(join(real, ISOLATED_DIR, "ompw-env.json"))).toBe(true);
	await page.getByTestId("isolated-stale").click();
	await page.getByTestId("isolated-stale-restart").click();
	await expect(page.getByTestId("isolated-badge")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("isolated-stale")).toHaveCount(0);
	await echo("after");
	await expect(page.getByText(`after:${join(real, ISOLATED_DIR)}.`, { exact: true })).toBeVisible({ timeout: 30_000 });

	// Switched off again, the same way.
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await page.getByTestId("isolated-stale").click();
	await page.getByTestId("isolated-stale-restart").click();
	await expect(page.getByTestId("isolated-stale")).toHaveCount(0, { timeout: 30_000 });
	await expect(page.getByTestId("isolated-badge")).toHaveCount(0);
	await echo("off");
	await expect(page.getByText("off:.", { exact: true })).toBeVisible({ timeout: 30_000 });
});

test("a narrow header puts the isolation switch in its menu, where it switches the folder too", async ({ page }) => {
	const { folder, real } = freshFolder("iso-narrow");
	await page.goto(newChatIn(folder));
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	const composer = page.getByTestId("composer");
	await composer.fill('!echo "started"');
	await composer.press("Enter");
	await expect(page.getByText("started", { exact: true })).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("header-isolation")).toBeVisible();
	// The narrowest phone's header: the switch gives way to the menu (before This session does).
	await page.setViewportSize({ width: 320, height: 800 });
	await expect(page.getByTestId("header-isolation")).toHaveCount(0);
	// The sidebar comes over the conversation on a phone: it is put away first.
	await page.keyboard.press("Escape");
	await page.getByTestId("chat-more").click();
	const row = page.getByTestId("header-isolation-row");
	await expect(row).toContainText("Off");
	await row.getByTestId("isolation-toggle").click();
	await expect(row.getByTestId("isolation-toggle")).toHaveAttribute("aria-checked", "true");
	await expect(row).toContainText("On");
	expect(existsSync(join(real, ISOLATED_DIR, "ompw-env.json"))).toBe(true);
});

test("New chat's switch cannot turn the home folder isolated, and says why", async ({ page }) => {
	await page.goto(newChatIn(process.env.OMPW_E2E_HOME as string));
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	const toggle = page.getByTestId("isolation-toggle");
	await expect(toggle).toHaveAttribute("aria-disabled", "true", { timeout: 15_000 });
	await expect(toggle).toHaveAttribute("title", /Not available here/);
	// aria-disabled: Playwright waits for an enabled element, and the click is what is checked to do nothing.
	await toggle.click({ force: true });
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	expect(existsSync(join(process.env.OMPW_E2E_HOME as string, ISOLATED_DIR))).toBe(false);
});
