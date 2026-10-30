import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * What a page that attaches again holds of things that were settled while its connection was down: a dialog (#362) and a
 * half-written reply (#363). The page's connection is cut by hand after frames are pushed to it by hand, so the real server
 * (whose omp is idle) says on the new connection that nothing waits and nothing is being written. No model call.
 */

test("a dialog that is not pending any more when the page attaches again is not shown as waiting for the user", async ({
	page,
}) => {
	const title = "Resync dialog probe";
	ownSession(0xe3, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "resync-dialog-probe");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const dot = (name: string) => sessionRow(page, title).getByRole("img", { name });

	// A turn is running when the user goes to another conversation, and omp asks for an approval.
	frame({ type: "agent_start" });
	await page.getByTestId("new-chat").click();
	frame({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow bash?", message: "echo hi" });
	await expect(dot("Needs your input")).toBeVisible();
	await expect(page).toHaveTitle(/^\(1\)/);

	// The connection drops; the approval is answered elsewhere (another tab), or omp gives up on it, while it is down. The
	// page never hears of the cancel: on the new connection the server replays what still waits, which is nothing.
	tap.drop();
	await expect(dot("Needs your input")).toHaveCount(0);
	await expect(page).not.toHaveTitle(/^\(1\)/);
});

test("a half-written reply that is not in flight any more when the page attaches again is not left under the transcript", async ({
	page,
}) => {
	const title = "Resync message probe";
	ownSession(0xe4, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "resync-message-probe");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });

	frame({ type: "agent_start" });
	frame({ type: "message_start", messageId: "m1", message: { role: "assistant", content: [], timestamp: 5 } });
	frame({
		type: "message_update",
		messageId: "m1",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_start", contentIndex: 0 },
	});
	frame({
		type: "message_update",
		messageId: "m1",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Half of a sentence that never ended" },
	});
	await expect(page.getByText("Half of a sentence that never ended")).toBeVisible();

	// The reply ended while the connection was down, and its end was never heard.
	tap.drop();
	await expect(page.getByText("Half of a sentence that never ended")).toHaveCount(0);
});

test("coming back to a conversation that nothing happened in reads only what came after its last entry, not the whole transcript (#360)", async ({
	page,
}) => {
	const title = "Resync since probe";
	ownSession(0xe5, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, title, "resync-since-probe");
	// Everything of the command has settled: the page has the transcript, and nothing is running.
	await expect(page.getByText("resync-since-probe", { exact: true })).toBeVisible();
	await page.getByTestId("new-chat").click();
	// The conversation is idle and off screen: the page lets go of it.
	await expect.poll(() => tap.sent.filter((m) => m.t === "detach").length).toBe(1);
	const asked = tap.commands("get_entries").length;
	const attached = () => tap.sent.filter((m) => m.t === "attach").length;

	await sessionRow(page, title).click();
	await expect.poll(attached).toBe(1);
	await expect.poll(() => tap.commands("get_entries").length).toBeGreaterThan(asked);
	// omp serialises the whole history for a read without `since`: the page asks for what came after what it has.
	for (const command of tap.commands("get_entries").slice(asked)) expect(command.since).toEqual(expect.any(String));
	await expect(page.getByText("resync-since-probe", { exact: true })).toBeVisible();
});
