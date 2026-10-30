import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * *This session* › *Mode*: a conversation switched to Light (or back to Full) has its omp ended and the same session
 * resumed in the other mode, at once when it is idle, after the turn when it works (a `!command` that has not exited
 * counts as work, and needs no model call); the badge in the header follows the process that runs it.
 */

const api = (body: unknown) =>
	fetch(`${process.env.OMPW_E2E_URL}/api/mode`, {
		method: "POST",
		headers: {
			"x-omp-webui-token": String(process.env.OMPW_E2E_ACCESS_TOKEN),
			"x-omp-webui": "1",
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});

test.beforeEach(async () => {
	await api({ mode: "full", lightModels: "yours" });
});
test.afterAll(async () => {
	await api({ mode: "full", lightModels: "yours" });
});

const badge = (page: Page) => page.getByTestId("mode-badge");

/** Open the conversation and run a command in it, so that its omp is there. */
async function openConversation(page: Page, n: number, title: string, probe: string) {
	ownSession(n, title);
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, title, probe);
}

/** Show the conversation's *This session* panel (typing in the composer closes it), and return its Mode section. */
async function showMode(page: Page) {
	await page.getByTestId("session-controls").click();
	const mode = page.getByTestId("session-mode");
	await expect(mode).toBeVisible({ timeout: 60_000 });
	return mode;
}

test("an idle conversation is switched to Light and back, and is the same conversation", async ({ page }) => {
	await openConversation(page, 0xe1, "Mode switch idle", "mode-switch-idle-up");
	const mode = await showMode(page);
	await expect(badge(page)).toHaveCount(0);
	await expect(mode).toHaveAttribute("data-mode", "full");
	await expect(page.getByTestId("session-mode-full")).toBeChecked();

	await page.getByTestId("session-mode-light").click();
	await expect(badge(page)).toBeVisible({ timeout: 60_000 });
	await expect(badge(page)).toHaveText("Light");
	await expect(badge(page)).toHaveAttribute("data-models", "yours");
	await expect(mode).toHaveAttribute("data-mode", "light");
	await expect(page.getByTestId("session-mode-light")).toBeChecked();
	// Resumed, not replaced: what was done in it before is still in it.
	await expect(page.getByText("mode-switch-idle-up", { exact: true })).toBeVisible();

	await page.getByTestId("session-mode-full").click();
	await expect(badge(page)).toHaveCount(0, { timeout: 60_000 });
	await expect(mode).toHaveAttribute("data-mode", "full");
	await expect(page.getByText("mode-switch-idle-up", { exact: true })).toBeVisible();
});

test("a conversation that works waits for the turn to end, says so, can be taken back, and switches then", async ({
	page,
}) => {
	await openConversation(page, 0xe2, "Mode switch busy", "mode-switch-busy-up");
	const composer = page.getByTestId("composer");
	await composer.fill("!sleep 12");
	await composer.press("Enter");
	const mode = await showMode(page);

	await page.getByTestId("session-mode-light").click();
	const pending = page.getByTestId("session-mode-pending");
	await expect(pending).toBeVisible();
	await expect(pending).toHaveAttribute("data-to", "light");
	await expect(mode).toHaveAttribute("data-pending", "light");
	await expect(badge(page)).toHaveCount(0);

	// Taking it back: the conversation stays as it is.
	await page.getByTestId("session-mode-cancel").click();
	await expect(pending).toHaveCount(0);
	await expect(mode).toHaveAttribute("data-pending", "");

	// Asked again, it is made when the command has exited.
	await page.getByTestId("session-mode-light").click();
	await expect(pending).toBeVisible();
	await expect(badge(page)).toBeVisible({ timeout: 90_000 });
	await expect(pending).toHaveCount(0);
	await expect(mode).toHaveAttribute("data-mode", "light");
});

test.describe("in Chinese", () => {
	test.use({ locale: "zh-CN" });
	test("the switch is worded in zh-CN", async ({ page }) => {
		await openConversation(page, 0xe3, "Mode switch zh", "mode-switch-zh-up");
		await showMode(page);
		await expect(page.getByTestId("session-mode")).toContainText("完整");
		await expect(page.getByTestId("session-mode")).toContainText("轻量");
		await expect(page.getByTestId("session-mode")).not.toContainText("会话");
	});
});
