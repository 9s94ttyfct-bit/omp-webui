import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A goal's next turn starts a moment after the terminal `agent_end` of the last: a page that let go of the process on that
 * `agent_end` would hear nothing of the turns that follow, not even an approval that waits for the user (#359). The page
 * listens until omp says it is settled. Frames are pushed by hand and omp's `get_state` is answered by the spec: no model call.
 */

const TITLE = "Goal detach probe";

const state = (extra: Record<string, unknown>) => ({
	isStreaming: false,
	isCompacting: false,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	interruptMode: "immediate",
	messageCount: 4,
	queuedMessageCount: 0,
	sessionId: "goal-detach",
	sessionName: "Named already",
	...extra,
});

test("a conversation in the background stays attached between the turns of a goal, and is let go of when omp settles", async ({
	page,
}) => {
	ownSession(0xe2, TITLE);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, TITLE, "goal-detach-probe");
	const dot = (name: string) => sessionRow(page, TITLE).getByRole("img", { name });
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const detaches = () => tap.sent.filter((m) => m.t === "detach" && m.liveId === liveId);

	// The goal is running when the user goes to another conversation.
	frame({ type: "agent_start" });
	frame({ type: "goal_updated", goal: { id: "g", objective: "ship it", status: "active" } });
	await page.getByTestId("new-chat").click();
	await expect(dot("Running")).toBeVisible();
	// omp, as measured: the continuation turn has started by the time `get_state` is answered for the terminal agent_end.
	tap.answer("get_state", () => ({ ok: true, data: state({ isStreaming: true, isSettled: false }) }));
	frame({ type: "agent_end", isTerminal: true });
	frame({ type: "agent_start" });
	// The next turn raises an approval: the page still hears it.
	frame({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow bash?", message: "echo hi" });
	await expect(dot("Needs your input")).toBeVisible();
	expect(detaches()).toHaveLength(0);

	frame({ type: "extension_ui_request", id: "ui-1-cancel", method: "cancel", targetId: "ui-1" });
	tap.answer("get_state", () => ({ ok: true, data: state({ isStreaming: false, isSettled: false }) }));
	frame({ type: "agent_end", isTerminal: true });
	// Idle-looking, but omp has not said it is done: the run goes on, so the conversation still lists as running (as it does
	// on a page that only lists it, #592) and the page is still attached.
	await expect(dot("Running")).toBeVisible();
	expect(detaches()).toHaveLength(0);

	tap.answer("get_state", () => ({ ok: true, data: state({ isSettled: true }) }));
	frame({ type: "session_settled" });
	await expect.poll(detaches).toHaveLength(1);
	await expect(dot("Open")).toBeVisible();
});
