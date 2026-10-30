import { existsSync, rmSync } from "node:fs";
import { writeSimpleSession } from "../support/fixtures.ts";
import { startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A conversation that is replying cannot be deleted: the dialog says why before anything is sent, and the server
 * refuses (409) a delete the page did not know to be wrong — the conversation is left running, not killed. No model
 * is called: the reply is a pushed frame, the busy server side is a `!command`.
 */

async function openDeleteDialog(page: Page, title: string) {
	const row = page.getByRole("complementary").locator('[data-testid="session-item"]', { hasText: title });
	await row.hover();
	await page.getByRole("button", { name: `Actions for ${title}` }).click();
	await page.getByRole("menuitem", { name: "Delete…" }).click();
}

test("the delete dialog of a replying conversation says to stop it first and cannot be confirmed", async ({ page }) => {
	const title = "Delete while replying";
	const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0x26, title);
	try {
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		const tap = await tapSocket(page);
		await page.goto("/");
		const liveId = await startLive(page, tap, title, "delete-replying-up");
		tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
		await expect(page.getByTestId("stop")).toBeVisible();

		await openDeleteDialog(page, title);
		const dialog = page.getByRole("dialog");
		await expect(dialog).toContainText("Stop it first, then delete it");
		await expect(page.getByTestId("confirm-session-action")).toBeDisabled();
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);

		// Once the reply is over, the same dialog is the ordinary one.
		tap.push({ t: "frame", liveId, frame: { type: "agent_end", messages: [] } });
		await expect(page.getByTestId("stop")).toHaveCount(0);
		await openDeleteDialog(page, title);
		await expect(dialog).toContainText("This cannot be undone");
		await expect(page.getByTestId("confirm-session-action")).toBeEnabled();
		expect(existsSync(file)).toBe(true);
	} finally {
		rmSync(file, { force: true });
	}
});

test("a delete the server refuses because the conversation is busy tells why, and leaves it running", async ({
	page,
}) => {
	const title = "Delete while command";
	const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0x27, title);
	try {
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		const tap = await tapSocket(page);
		await page.goto("/");
		await startLive(page, tap, title, "delete-command-up");
		await page.getByTestId("composer").fill("!sleep 20 && echo never-printed-by-delete");
		await page.getByTestId("composer").press("Enter");
		await expect(page.getByTestId("pending-command")).toHaveCount(1);

		// The page saw no reply under way, so the dialog is the ordinary one; the server knows better.
		await openDeleteDialog(page, title);
		await page.getByTestId("confirm-session-action").click();
		await expect(page.getByTestId("toast").first()).toContainText(/Delete failed:.*stop it first/i);
		expect(existsSync(file)).toBe(true);

		// The command was not cut off by the attempt: it is still running, and Stop ends it.
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("pending-command")).toHaveCount(1);
		await page.getByTestId("stop").click();
		await expect(page.getByTestId("pending-command")).toHaveCount(0, { timeout: 15_000 });
		await expect(page.getByText("never-printed-by-delete", { exact: true })).toHaveCount(0);
	} finally {
		rmSync(file, { force: true });
	}
});
