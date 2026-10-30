import { ownSession, startLive } from "../support/live.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * What the page does with the deadline omp gives a dialog (`ask.timeout`), and with a message typed while a tool approval
 * waits. The frames are pushed (the server's own are covered by tests/contract/dialogs.test.ts), so no model is called.
 */

async function chat(page: Page, title: string, n: number): Promise<{ tap: SocketTap; liveId: string }> {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `dialogs-${n}`);
	return { tap, liveId };
}

const push = (tap: SocketTap, liveId: string, frame: Record<string, unknown>) =>
	tap.push({ t: "frame", liveId, frame });

const ask = (timeout?: number) => ({
	type: "extension_ui_request",
	method: "ask",
	id: "ask-1",
	...(timeout ? { timeout } : {}),
	questions: [
		{
			id: "colour",
			question: "Which colour?",
			options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }],
			recommended: 1,
		},
	],
});

const approval = (id: string, tool: string) => ({
	type: "extension_ui_request",
	id,
	method: "select",
	title: `Allow tool: ${tool}\necho hi`,
	options: ["Approve", "Approve bash for this session", "Deny"],
});

const card = (page: Page) => page.getByTestId("ui-request");
const countdown = (page: Page) => page.getByTestId("ui-request-countdown");
const timeoutNote = (page: Page) => page.getByTestId("dialog-timeout-note");

test("a question omp gives a deadline shows what is left, and when omp closes it unanswered the conversation says what omp chose", async ({
	page,
}) => {
	const { tap, liveId } = await chat(page, "Dialog timeout probe", 0xd1);
	push(tap, liveId, ask(1500));
	await expect(card(page)).toBeVisible();
	await expect(countdown(page)).toHaveText(/^omp picks its recommended answer in [12]s$/);

	// The time running out closes nothing here: omp does, and the page waits to be told. The countdown stops at zero.
	await expect(countdown(page)).toHaveText("omp picks its recommended answer in 0s");
	await expect(card(page)).toBeVisible();
	await expect(timeoutNote(page)).toHaveCount(0);

	push(tap, liveId, { type: "extension_ui_request", method: "cancel", id: "x-1", targetId: "ask-1", timedOut: true });
	await expect(card(page)).toHaveCount(0);
	await expect(timeoutNote(page)).toBeVisible();
	await expect(timeoutNote(page)).toContainText("A question timed out");
	await expect(page.getByTestId("dialog-timeout-chosen")).toContainText("Which colour? → Blue");
	// The user answered nothing: no answer went to omp from the page.
	expect(tap.sent.filter((m) => m.t === "ui_response")).toHaveLength(0);
});

test("a dialog without a deadline has no countdown, and one closed for another reason leaves no note", async ({
	page,
}) => {
	const { tap, liveId } = await chat(page, "Dialog no timeout probe", 0xd2);
	push(tap, liveId, ask());
	await expect(card(page)).toBeVisible();
	await expect(countdown(page)).toHaveCount(0);
	// Closed by another tab, or by the turn being stopped: omp did not run out of patience.
	push(tap, liveId, { type: "extension_ui_request", method: "cancel", id: "x-1", targetId: "ask-1" });
	await expect(card(page)).toHaveCount(0);
	await expect(timeoutNote(page)).toHaveCount(0);

	// Answered here before the deadline: the card goes, and the cancel the server sends after nobody is told "timed out".
	push(tap, liveId, { ...ask(60_000), id: "ask-2" });
	await expect(countdown(page)).toContainText("59s");
	await page.getByRole("button", { name: "Submit answers" }).click();
	await expect(card(page)).toHaveCount(0);
	push(tap, liveId, { type: "extension_ui_request", method: "cancel", id: "answered-ask-2", targetId: "ask-2" });
	await expect(timeoutNote(page)).toHaveCount(0);
});

test("a message typed while a tool approval waits is sent, and the approval is denied after it", async ({ page }) => {
	const { tap, liveId } = await chat(page, "Approval message probe", 0xd3);
	tap.answer("prompt", () => ({ ok: true, data: { agentInvoked: true } }));
	tap.answer("steer", () => ({ ok: true, data: {} }));
	push(tap, liveId, { type: "agent_start" });
	push(tap, liveId, approval("ap-1", "bash"));
	await expect(card(page)).toBeVisible();

	const composer = page.getByTestId("composer");
	await composer.fill("Never mind, skip that");
	await composer.press("Enter");
	await expect.poll(() => tap.commands("prompt")).toHaveLength(1);
	await expect(card(page)).toHaveCount(0);
	// Denied with the approval's own Deny choice, and after the message went out: a denial is what the message asked for.
	const responses = tap.sent.filter((m) => m.t === "ui_response");
	expect(responses).toHaveLength(1);
	expect(responses[0]).toMatchObject({ liveId, response: { id: "ap-1", value: "Deny" } });
	const sentPrompt = tap.sent.findIndex((m) => m.t === "rpc" && m.command?.type === "prompt");
	expect(tap.sent.indexOf(responses[0])).toBeGreaterThan(sentPrompt);
	expect(tap.commands("prompt")[0]).toMatchObject({ message: "Never mind, skip that", streamingBehavior: "followUp" });
	await expect(page.getByTestId("approval-denied-note")).toHaveText("Denied bash: you sent a message instead.");

	// The same for a steer (Ctrl/Cmd+Enter) while the next approval waits.
	push(tap, liveId, approval("ap-2", "write"));
	await expect(card(page)).toBeVisible();
	await composer.fill("Use the other file");
	await composer.press("ControlOrMeta+Enter");
	await expect.poll(() => tap.commands("steer")).toHaveLength(1);
	const second = tap.sent.filter((m) => m.t === "ui_response");
	expect(second).toHaveLength(2);
	expect(second[1]).toMatchObject({ response: { id: "ap-2", value: "Deny" } });
	expect(tap.sent.indexOf(second[1])).toBeGreaterThan(
		tap.sent.findIndex((m) => m.t === "rpc" && m.command?.type === "steer"),
	);
	await expect(card(page)).toHaveCount(0);
});

test("a message that cannot be sent leaves the approval alone: nothing is denied that the user did not decide on", async ({
	page,
}) => {
	const { tap, liveId } = await chat(page, "Approval failed send probe", 0xd5);
	// omp refuses the message: the send fails, and the draft comes back.
	tap.answer("prompt", () => ({ ok: false, error: "Agent is already processing a prompt." }));
	push(tap, liveId, { type: "agent_start" });
	push(tap, liveId, approval("ap-1", "bash"));
	await expect(card(page)).toBeVisible();

	const composer = page.getByTestId("composer");
	await composer.fill("Never mind, skip that");
	await composer.press("Enter");
	await expect(page.getByTestId("toast").filter({ hasText: "Agent is already processing" })).toBeVisible();
	// The approval was not denied: the user never sent that message.
	expect(tap.sent.filter((m) => m.t === "ui_response")).toHaveLength(0);
	await expect(card(page)).toBeVisible();
	await expect(page.getByTestId("approval-denied-note")).toHaveCount(0);
	// The draft is back in the composer.
	await expect(composer).toHaveValue("Never mind, skip that");
});

test("a message sent with no approval waiting answers nothing, and a question that is not an approval stays open", async ({
	page,
}) => {
	const { tap, liveId } = await chat(page, "Approval message none probe", 0xd4);
	tap.answer("prompt", () => ({ ok: true, data: { agentInvoked: true } }));
	push(tap, liveId, { type: "agent_start" });
	const composer = page.getByTestId("composer");
	await composer.fill("Just a follow-up");
	await composer.press("Enter");
	await expect.poll(() => tap.commands("prompt")).toHaveLength(1);
	expect(tap.sent.filter((m) => m.t === "ui_response")).toHaveLength(0);
	await expect(page.getByTestId("approval-denied-note")).toHaveCount(0);

	// A question of the model's is not a tool approval: sending a message does not answer it for the user.
	push(tap, liveId, ask());
	await expect(card(page)).toBeVisible();
	await composer.fill("And another");
	await composer.press("Enter");
	await expect.poll(() => tap.commands("prompt")).toHaveLength(2);
	await expect(card(page)).toBeVisible();
	expect(tap.sent.filter((m) => m.t === "ui_response")).toHaveLength(0);
});

test("text that only starts with a slash is a message, so it denies the approval like any other", async ({ page }) => {
	const { tap, liveId } = await chat(page, "Approval slash text probe", 0xd7);
	tap.answer("prompt", () => ({ ok: true, data: { agentInvoked: true } }));
	push(tap, liveId, { type: "agent_start" });
	push(tap, liveId, approval("ap-1", "bash"));
	await expect(card(page)).toBeVisible();

	const composer = page.getByTestId("composer");
	// A path, not a command: omp hands it to the model as text, so it is a message.
	await composer.fill("/Users/me/project/src/main.ts is broken");
	await composer.press("Enter");
	await expect.poll(() => tap.commands("prompt")).toHaveLength(1);
	await expect(card(page)).toHaveCount(0);
	expect(tap.sent.filter((m) => m.t === "ui_response")).toHaveLength(1);
	expect(tap.sent.find((m) => m.t === "ui_response")).toMatchObject({ response: { id: "ap-1", value: "Deny" } });
});

test("a command omp runs at once leaves the approval alone", async ({ page }) => {
	const { tap, liveId } = await chat(page, "Approval command probe", 0xd8);
	tap.answer("prompt", () => ({ ok: true, data: { agentInvoked: true } }));
	push(tap, liveId, { type: "agent_start" });
	push(tap, liveId, approval("ap-1", "bash"));
	await expect(card(page)).toBeVisible();

	const composer = page.getByTestId("composer");
	// A command of omp's own catalog: omp runs it at once, so it is not a message that denies anything.
	await composer.fill("/context now");
	await composer.press("Enter");
	await expect.poll(() => tap.commands("prompt")).toHaveLength(1);
	await expect(card(page)).toBeVisible();
	expect(tap.sent.filter((m) => m.t === "ui_response")).toHaveLength(0);
});

test("sending a queued follow-up now denies the approval too: it is a message as well", async ({ page }) => {
	const { tap, liveId } = await chat(page, "Approval promote probe", 0xd9);
	tap.answer("promote_queued_message", () => ({ ok: true, data: { promoted: true } }));
	// omp's own state: the queued follow-up is still waiting, and the turn is running.
	tap.answer("get_state", () => ({
		ok: true,
		data: {
			isStreaming: true,
			isSettled: false,
			messageCount: 2,
			queuedMessages: { steering: [], followUp: ["later please"], liveSteered: 0 },
		},
	}));
	push(tap, liveId, { type: "agent_start" });
	push(tap, liveId, { type: "queue_update", steering: [], followUp: ["later please"], liveSteered: 0 });
	push(tap, liveId, approval("ap-1", "bash"));
	await expect(card(page)).toBeVisible();
	await expect(page.getByTestId("queue-chip")).toBeVisible();

	await page.getByRole("button", { name: "Steer now" }).click();
	await expect.poll(() => tap.commands("promote_queued_message")).toHaveLength(1);
	await expect(card(page)).toHaveCount(0);
	expect(tap.sent.filter((m) => m.t === "ui_response")).toHaveLength(1);
	expect(tap.sent.find((m) => m.t === "ui_response")).toMatchObject({ response: { id: "ap-1", value: "Deny" } });
});

test("while an approval is open, the card and the composer say that a message denies it", async ({ page }) => {
	const { tap, liveId } = await chat(page, "Approval hint probe", 0xda);
	push(tap, liveId, { type: "agent_start" });
	push(tap, liveId, approval("ap-1", "bash"));
	await expect(card(page)).toBeVisible();

	// The card says what pressing Enter will do, before it is pressed.
	await expect(page.getByTestId("approval-deny-hint")).toHaveText(
		"Sending a message denies this and sends the message.",
	);
	// And the composer, where the message is typed, says it too.
	await expect(page.getByTestId("composer")).toHaveAttribute("placeholder", /denies the approval/);

	// A question that is not an approval says nothing of the sort: sending a message does not answer it.
	push(tap, liveId, { type: "extension_ui_request", id: "q-1", method: "confirm", title: "Run it?" });
	await expect(page.getByTestId("approval-deny-hint")).toHaveCount(1);
});
