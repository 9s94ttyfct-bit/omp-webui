import { ownSession, startLive } from "../support/live.ts";
import { type Msg, type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Editing a message that waits in omp's queue. omp has no edit command: the message is withdrawn and queued again.
 * No model is called: the queue arrives as pushed frames and omp's answers to the two commands are stubbed.
 */

const PICTURE = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

async function queued(
	page: Page,
	title: string,
	n: number,
	queue: { steering?: string[]; followUp?: string[]; liveSteered?: number },
) {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `queue-edit-${n}`);
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "queue_update", steering: [], followUp: [], liveSteered: 0, ...queue },
	});
	return { tap, liveId };
}

const chip = (page: Page, text: string) => page.getByTestId("queue-chip").filter({ hasText: text });
const sentOf = (tap: SocketTap, type: string): Msg[] =>
	tap.sent.filter((m) => m.t === "rpc" && m.command?.type === type);

test("saving withdraws the message and queues the edit again as the same kind, with its images, at the end", async ({
	page,
}) => {
	const { tap } = await queued(page, "Queue edit save", 0x70, {
		steering: ["steer one"],
		followUp: ["first", "second"],
	});
	tap.answer("remove_queued_message", () => ({ ok: true, data: { removed: true, images: [PICTURE] } }));
	tap.answer("prompt", () => ({ ok: true, data: { agentInvoked: true } }));

	await chip(page, "first").getByTestId("queue-edit-open").click();
	const editor = page.getByTestId("queue-edit");
	await expect(editor).toContainText("Editing a queued follow-up");
	await expect(editor).toHaveAttribute("data-kind", "followUp");
	await expect(page.getByTestId("queue-edit-text")).toHaveValue("first");
	await expect(page.getByTestId("queue-edit-text")).toBeFocused();
	// One message is queued after it, and the editor says the edit goes behind it.
	await expect(page.getByTestId("queue-edit-end")).toContainText("1 message that was behind it");

	// Shift+Enter is a new line; Enter saves.
	const text = page.getByTestId("queue-edit-text");
	await text.press("End");
	await text.pressSequentially(" edited");
	await text.press("Shift+Enter");
	await text.pressSequentially("line two");
	expect(sentOf(tap, "remove_queued_message")).toHaveLength(0);
	await text.press("Enter");

	await expect(editor).toHaveCount(0);
	await expect.poll(() => sentOf(tap, "prompt")).toHaveLength(1);
	const [remove] = sentOf(tap, "remove_queued_message");
	expect(remove.command).toEqual({ type: "remove_queued_message", message: "first", queue: "followUp" });
	const [prompt] = sentOf(tap, "prompt");
	expect(prompt.command).toEqual({
		type: "prompt",
		message: "first edited\nline two",
		images: [PICTURE],
		streamingBehavior: "followUp",
	});
	// A user action: a paused conversation answers it (and stays paused).
	expect(remove.user).toBe(true);
	expect(prompt.user).toBe(true);
	expect(tap.sent.indexOf(remove)).toBeLessThan(tap.sent.indexOf(prompt));
	// Nothing else went out: no steer, nothing for the composer.
	expect(sentOf(tap, "steer")).toHaveLength(0);
	await expect(page.getByTestId("composer")).toHaveValue("");
});

test("a steering message is queued again as a steer, and the last one in its queue carries no ordering note", async ({
	page,
}) => {
	const { tap } = await queued(page, "Queue edit steer", 0x71, { steering: ["go left"], followUp: ["later"] });
	tap.answer("remove_queued_message", () => ({ ok: true, data: { removed: true } }));
	tap.answer("prompt", () => ({ ok: true, data: { agentInvoked: true } }));

	await chip(page, "go left").getByTestId("queue-edit-open").click();
	await expect(page.getByTestId("queue-edit")).toContainText("Editing a steering message");
	// The follow-up queued behind it is another queue: nothing moves behind anything.
	await expect(page.getByTestId("queue-edit-end")).toHaveCount(0);
	await page.getByTestId("queue-edit-text").fill("go right");
	await page.getByTestId("queue-edit-save").click();

	await expect.poll(() => sentOf(tap, "prompt")).toHaveLength(1);
	expect(sentOf(tap, "remove_queued_message")[0].command).toMatchObject({ message: "go left", queue: "steering" });
	expect(sentOf(tap, "prompt")[0].command).toEqual({ type: "prompt", message: "go right", streamingBehavior: "steer" });
});

test("Esc and Cancel close the editor and send nothing; so does saving the text unchanged", async ({ page }) => {
	const { tap } = await queued(page, "Queue edit cancel", 0x72, { followUp: ["keep me"] });
	const open = chip(page, "keep me").getByTestId("queue-edit-open");

	await open.click();
	await page.getByTestId("queue-edit-text").fill("typed but dropped");
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("queue-edit")).toHaveCount(0);
	await expect(open).toBeFocused();

	// Reopened, the editor starts from the queued text, not from the abandoned edit.
	await open.click();
	await expect(page.getByTestId("queue-edit-text")).toHaveValue("keep me");
	await page.getByTestId("queue-edit-text").fill("typed but dropped again");
	await page.getByTestId("queue-edit-cancel").click();
	await expect(page.getByTestId("queue-edit")).toHaveCount(0);

	await open.click();
	await page.getByTestId("queue-edit-text").press("Enter");
	await expect(page.getByTestId("queue-edit")).toHaveCount(0);

	expect(sentOf(tap, "remove_queued_message")).toHaveLength(0);
	expect(sentOf(tap, "prompt")).toHaveLength(0);
	await expect(chip(page, "keep me")).toHaveCount(1);
});

test("a message omp already took is not queued again; a notice says so", async ({ page }) => {
	const { tap } = await queued(page, "Queue edit gone", 0x73, { followUp: ["too late"] });
	tap.answer("remove_queued_message", () => ({ ok: true, data: { removed: false } }));
	tap.answer("prompt", () => ({ ok: true, data: { agentInvoked: true } }));

	await chip(page, "too late").getByTestId("queue-edit-open").click();
	await page.getByTestId("queue-edit-text").fill("too late, edited");
	await page.getByTestId("queue-edit-save").click();

	await expect(page.getByTestId("toast").filter({ hasText: "already taken that message" })).toBeVisible();
	await expect(page.getByTestId("queue-edit")).toHaveCount(0);
	expect(sentOf(tap, "remove_queued_message")).toHaveLength(1);
	expect(sentOf(tap, "prompt")).toHaveLength(0);
});

test("when the edit cannot be queued its text is back in the composer", async ({ page }) => {
	const { tap } = await queued(page, "Queue edit failed", 0x74, { followUp: ["will fail"] });
	tap.answer("remove_queued_message", () => ({ ok: true, data: { removed: true, images: [PICTURE] } }));
	tap.answer("prompt", () => ({ ok: false, error: "queue is closed" }));

	await chip(page, "will fail").getByTestId("queue-edit-open").click();
	await page.getByTestId("queue-edit-text").fill("will fail, edited");
	await page.getByTestId("queue-edit-save").click();

	await expect(page.getByTestId("toast").filter({ hasText: "queue is closed" })).toBeVisible();
	await expect(page.getByTestId("composer")).toHaveValue("will fail, edited");
	await expect(page.getByAltText("image")).toHaveCount(1);
});

test("steering omp already sent into the running response cannot be edited or removed, and says why", async ({
	page,
}) => {
	await queued(page, "Queue edit locked", 0x75, { steering: ["already sent", "still waiting"], liveSteered: 1 });

	const locked = chip(page, "already sent");
	await expect(locked).toHaveAttribute("data-locked", "true");
	await expect(locked).toHaveAttribute("title", /already sent this into the running response/);
	await expect(locked.getByTestId("queue-edit-open")).toHaveCount(0);
	await expect(locked.getByRole("button")).toHaveCount(0);

	// The one behind it can still be edited.
	const waiting = chip(page, "still waiting");
	await expect(waiting.getByTestId("queue-edit-open")).toBeVisible();
	await expect(waiting.getByRole("button", { name: "Remove queued message" })).toBeVisible();
	// Its queue position counts only what is behind it.
	await waiting.getByTestId("queue-edit-open").click();
	await expect(page.getByTestId("queue-edit-end")).toHaveCount(0);
});

test("an edit in progress is put back into the composer when omp takes the message meanwhile", async ({ page }) => {
	const { tap, liveId } = await queued(page, "Queue edit taken", 0x76, { followUp: ["about to go", "stays"] });
	const composer = page.getByTestId("composer");

	await chip(page, "about to go").getByTestId("queue-edit-open").click();
	await page.getByTestId("queue-edit-text").fill("about to go, reworded");
	// omp starts the turn and takes the first message out of its queue while the editor is open.
	tap.push({ t: "frame", liveId, frame: { type: "queue_update", steering: [], followUp: ["stays"], liveSteered: 0 } });

	await expect(chip(page, "about to go")).toHaveCount(0);
	await expect(page.getByTestId("queue-edit")).toHaveCount(0);
	await expect(composer).toHaveValue("about to go, reworded");
	await expect(page.getByTestId("toast").filter({ hasText: "already taken that message" })).toBeVisible();
	// Nothing was sent for it, and the message still waiting is untouched.
	expect(sentOf(tap, "remove_queued_message")).toHaveLength(0);
	expect(sentOf(tap, "prompt")).toHaveLength(0);
	await expect(chip(page, "stays")).toHaveCount(1);
});

test("an editor with nothing changed, or closed, leaves the composer alone when its message goes", async ({ page }) => {
	const { tap, liveId } = await queued(page, "Queue edit quiet", 0x77, { followUp: ["one", "two"] });
	const composer = page.getByTestId("composer");
	await composer.fill("my own draft");

	// Opened and not changed.
	await chip(page, "one").getByTestId("queue-edit-open").click();
	// Typed, then cancelled with Esc.
	await page.keyboard.press("Escape");
	await chip(page, "two").getByTestId("queue-edit-open").click();
	await page.getByTestId("queue-edit-text").fill("two, abandoned");
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("queue-edit")).toHaveCount(0);

	tap.push({ t: "frame", liveId, frame: { type: "queue_update", steering: [], followUp: [], liveSteered: 0 } });
	await expect(page.getByTestId("queue-chip")).toHaveCount(0);
	await expect(composer).toHaveValue("my own draft");
	await expect(page.getByTestId("toast").filter({ hasText: "already taken that message" })).toHaveCount(0);
});
