import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A message sent to a conversation that looks idle can reach omp just after another page's message started a turn (two
 * pages on one conversation, #394). omp refuses a prompt that says nothing of how to queue it while a turn runs ("Agent is
 * already processing. Use steer() or followUp()…"), so the composer's ordinary message says to follow up: omp starts a turn
 * with it when it is idle and queues it behind the turn that has just started otherwise. omp's answer is played here.
 */
test("a message sent as another page's turn starts is queued behind it, not refused (#394)", async ({ page }) => {
	const title = "Send race probe";
	ownSession(0xd6, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, title, "send-race-up");

	// A turn has just started (another page's message): omp refuses a prompt that does not say to queue it.
	tap.answer("prompt", (c) =>
		c.streamingBehavior
			? { ok: true }
			: {
					ok: false,
					error: "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.",
				},
	);
	const composer = page.getByTestId("composer");
	await composer.fill("Send race: my message");
	await composer.press("Enter");
	await expect.poll(() => tap.commands("prompt").map((c) => c.message)).toEqual(["Send race: my message"]);
	expect(tap.commands("prompt")[0]?.streamingBehavior).toBe("followUp");
	await expect(composer).toHaveValue("");
	await expect(page.getByText(/Agent is already processing/)).toHaveCount(0);
});
