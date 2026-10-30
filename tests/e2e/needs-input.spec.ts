import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A conversation waiting for the user's answer (a tool approval, a question) must not look like it is
 * still working. The dialog arrives as a pushed frame, so no model call is made.
 */

const TITLE = "Needs input probe";

test("a background chat waiting for input shows its own sidebar state, even while running", async ({ page }) => {
	ownSession(0x50, TITLE);
	// Auto-titling would send a prompt to the model when the pushed turn ends.
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, TITLE, "needs-input-probe");
	await page.getByTestId("new-chat").click();
	const dot = (name: string) => sessionRow(page, TITLE).getByRole("img", { name });
	await expect(dot("Open")).toBeVisible();

	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	frame({ type: "agent_start" });
	await expect(dot("Running")).toBeVisible();

	// omp now waits on an approval: that beats "running" because nothing is progressing.
	frame({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow bash?", message: "echo hi" });
	await expect(dot("Needs your input")).toBeVisible();
	await expect(dot("Running")).toHaveCount(0);
	await expect(dot("Open")).toHaveCount(0);

	// Answered elsewhere (or timed out): back to plain running, then idle.
	frame({ type: "extension_ui_request", id: "ui-1-cancel", method: "cancel", targetId: "ui-1" });
	await expect(dot("Running")).toBeVisible();
	await expect(dot("Needs your input")).toHaveCount(0);
	frame({ type: "agent_end" });
	await expect(dot("Open")).toBeVisible();
});
