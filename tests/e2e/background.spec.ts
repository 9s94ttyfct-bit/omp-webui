import { rmSync } from "node:fs";
import { basename } from "node:path";
import { writeSimpleSession } from "../support/fixtures.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A dialog that arrives for a conversation that is not open raises a toast that opens it (no model call: the frame is
 * injected). Opening the conversation attaches the page to its process, and the server says what it holds for the page
 * (`attached`): a dialog it does not list was settled while the page was away and is dropped (#362). The injected dialog
 * stands for omp's own, which the server would hold and list, so the server's answer is made to say so.
 */

test("a dialog for a conversation that is not open raises a toast that takes you to it", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const asking = writeSimpleSession(agentDir, 0x74, "Asks elsewhere");
	const here = writeSimpleSession(agentDir, 0x75, "Stays open");
	// The page's socket: learn which process runs which file, and deliver a server frame by hand.
	const tap = await tapSocket(page);
	const liveOf = new Map<string, string>();
	tap.rewrite((msg) => {
		const info = msg.t === "live" ? (msg.info as { liveId: string; sessionFile: string | null }) : null;
		if (info?.sessionFile) liveOf.set(basename(info.sessionFile), info.liveId);
		// The server holds the dialog: it says so to a page that attaches to the conversation it is in.
		if (msg.t === "attached" && msg.liveId === liveOf.get(basename(asking)))
			return { ...msg, dialogs: [...(msg.dialogs as string[]), "bg-1"] };
		return msg;
	});
	const row = (title: string) => page.locator('[data-testid="session-item"]', { hasText: title });
	try {
		await page.goto("/");
		await row("Asks elsewhere").click();
		// A `!command` starts the conversation's omp process without calling the model.
		await page.getByTestId("composer").fill("!echo started-$((6*7))");
		await page.getByTestId("composer").press("Enter");
		await expect(page.getByText("started-42")).toBeVisible({ timeout: 30_000 });
		await row("Stays open").click();
		await expect(page.getByTestId("chat-title")).toHaveText("Stays open");

		const liveId = liveOf.get(basename(asking));
		expect(liveId).toBeTruthy();
		tap.push({
			t: "frame",
			liveId,
			frame: {
				type: "extension_ui_request",
				method: "confirm",
				id: "bg-1",
				title: "Allow echo?",
				message: "Run echo?",
			},
		});

		const toast = page.getByTestId("toast").filter({ hasText: "Asks elsewhere" });
		await expect(toast).toBeVisible();
		await toast.getByTestId("toast-action").click();
		await expect(page.getByTestId("chat-title")).toHaveText("Asks elsewhere");
		await expect(page.getByTestId("ui-request")).toContainText("Allow echo?");
	} finally {
		rmSync(asking, { force: true });
		rmSync(here, { force: true });
	}
});
