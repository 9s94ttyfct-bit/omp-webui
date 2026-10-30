import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * A running tool's card opens by itself and shows its output as it streams in (a `tool_execution_update` carries what
 * the tool has printed so far); when the tool ends the card folds, like a thinking block. A click by hand, either way,
 * wins for that card. Frames are injected: no model runs.
 */

const call = (id: string, command: string) => ({ type: "toolCall", id, name: "bash", arguments: { command } });
const text = (s: string) => ({ content: [{ type: "text", text: s }] });

async function openProbe(page: Page, n: number, title: string) {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `probe-${n}`);
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const start = (id: string, command: string) =>
		frame({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command } });
	const update = (id: string, output: string) =>
		frame({ type: "tool_execution_update", toolCallId: id, toolName: "bash", partialResult: text(output) });
	const end = (id: string, output: string) =>
		frame({ type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: false, result: text(output) });
	return { tap, frame, start, update, end };
}

const header = (card: Locator) => card.locator("button[aria-expanded]").first();

test("a running tool's card opens, streams its output, and folds when the tool ends", async ({ page }) => {
	const { frame, start, update, end } = await openProbe(page, 0xc0, "Tool auto expand probe");
	frame({
		type: "message_start",
		messageId: "m-auto",
		message: { role: "assistant", content: [call("toolu_auto", "make build-auto")] },
	});
	const card = page.locator('[data-testid="tool-card"]', { hasText: "make build-auto" });
	// The call is known before the tool runs: nothing to show yet, the card is folded.
	await expect(card).toBeVisible();
	await expect(header(card)).toHaveAttribute("aria-expanded", "false");

	start("toolu_auto", "make build-auto");
	await expect(header(card)).toHaveAttribute("aria-expanded", "true");
	update("toolu_auto", "compiling a.c");
	await expect(card.getByText("compiling a.c")).toBeVisible();
	update("toolu_auto", "compiling a.c\ncompiling b.c");
	await expect(card.getByText("compiling b.c")).toBeVisible();
	await expect(card).toContainText("Output (streaming)");
	await expect(header(card)).toHaveAttribute("aria-expanded", "true");

	end("toolu_auto", "compiling a.c\ncompiling b.c\nlinked");
	await expect(header(card)).toHaveAttribute("aria-expanded", "false");
	await expect(card.getByText("compiling b.c")).toHaveCount(0);
	await expect(card.getByLabel("Done")).toBeVisible();
});

test("a long output shows its end and follows it while the tool runs", async ({ page }) => {
	const { frame, start, update } = await openProbe(page, 0xc1, "Tool tail probe");
	frame({
		type: "message_start",
		messageId: "m-tail",
		message: { role: "assistant", content: [call("toolu_tail", "seq 1 2000")] },
	});
	start("toolu_tail", "seq 1 2000");
	const card = page.locator('[data-testid="tool-card"]', { hasText: "seq 1 2000" });
	const lines = (n: number) => Array.from({ length: n }, (_, i) => `row-${i + 1}`).join("\n");
	update("toolu_tail", lines(1500));
	// Past what the card shows whole, the end is what is shown, scrolled into view.
	const out = card.locator("pre").last();
	await expect(out).toContainText("row-1500");
	await expect(out).not.toContainText(/\brow-1\b/);
	await expect.poll(() => out.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 24)).toBe(true);
	update("toolu_tail", lines(1600));
	await expect(out).toContainText("row-1600");
	await expect.poll(() => out.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 24)).toBe(true);
});

test("a card the reader toggled by hand while it ran is not toggled again", async ({ page }) => {
	const { frame, start, update, end } = await openProbe(page, 0xc2, "Tool manual probe");
	frame({
		type: "message_start",
		messageId: "m-manual",
		message: { role: "assistant", content: [call("toolu_fold", "job-fold"), call("toolu_keep", "job-keep")] },
	});
	start("toolu_fold", "job-fold");
	start("toolu_keep", "job-keep");
	const fold = page.locator('[data-testid="tool-card"]', { hasText: "job-fold" });
	const keep = page.locator('[data-testid="tool-card"]', { hasText: "job-keep" });
	update("toolu_fold", "fold out 1");
	update("toolu_keep", "keep out 1");
	await expect(header(fold)).toHaveAttribute("aria-expanded", "true");
	await expect(header(keep)).toHaveAttribute("aria-expanded", "true");
	await expect(fold.getByText("fold out 1")).toBeVisible();

	// One is folded by hand: it stays folded as output arrives and when the tool ends.
	await header(fold).click();
	await expect(header(fold)).toHaveAttribute("aria-expanded", "false");
	// The other is folded and opened again by hand: it stays open after the end.
	await header(keep).click();
	await header(keep).click();
	await expect(header(keep)).toHaveAttribute("aria-expanded", "true");

	update("toolu_fold", "fold out 1\nfold out 2");
	update("toolu_keep", "keep out 1\nkeep out 2");
	await expect(keep.getByText("keep out 2")).toBeVisible();
	await expect(header(fold)).toHaveAttribute("aria-expanded", "false");
	await expect(fold.getByText("fold out 2")).toHaveCount(0);

	end("toolu_fold", "fold done");
	end("toolu_keep", "keep done");
	await expect(keep.getByLabel("Done")).toBeVisible();
	await expect(fold.getByLabel("Done")).toBeVisible();
	await expect(header(fold)).toHaveAttribute("aria-expanded", "false");
	await expect(header(keep)).toHaveAttribute("aria-expanded", "true");
	await expect(keep.getByText("keep done")).toBeVisible();
});

test("a hand-made choice survives the card's message being saved to the transcript", async ({ page }) => {
	const { tap, frame, start, update, end } = await openProbe(page, 0xc3, "Tool remount probe");
	const content = [call("toolu_saved", "job-saved"), call("toolu_open", "job-open")];
	frame({ type: "message_start", messageId: "m-saved", message: { role: "assistant", content } });
	start("toolu_saved", "job-saved");
	start("toolu_open", "job-open");
	const folded = page.locator('[data-testid="tool-card"]', { hasText: "job-saved" });
	const untouched = page.locator('[data-testid="tool-card"]', { hasText: "job-open" });
	update("toolu_saved", "saved out 1");
	update("toolu_open", "open out 1");
	await expect(header(folded)).toHaveAttribute("aria-expanded", "true");
	await header(folded).click();
	await expect(header(folded)).toHaveAttribute("aria-expanded", "false");

	// omp saves the message while its tools still run: the card is drawn anew, from the saved entry instead of the stream.
	let saved = false;
	tap.answer("get_entries", (command) => {
		if (!saved) return undefined;
		const since = typeof command.since === "string" ? command.since : null;
		if (since === "saved-asst") return { ok: true, data: { entries: [], leafId: "saved-asst" } };
		const at = (id: string, parentId: string | null, message: Record<string, unknown>) => ({
			type: "message",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			message: { ...message, timestamp: Date.now() },
		});
		return {
			ok: true,
			data: {
				entries: [
					at("saved-user", since, {
						role: "user",
						content: [{ type: "text", text: "run the jobs" }],
						attribution: "user",
					}),
					at("saved-asst", "saved-user", {
						role: "assistant",
						content,
						provider: "anthropic",
						model: "claude-haiku-5-5",
						stopReason: "toolUse",
					}),
				],
				leafId: "saved-asst",
			},
		};
	});
	saved = true;
	frame({ type: "message_end", messageId: "m-saved", message: { role: "assistant", content } });
	await expect(page.locator('[data-testid="msg-assistant"][data-entry-id="saved-asst"]')).toBeVisible();
	await expect(page.locator('[data-testid="tool-card"]', { hasText: "job-saved" })).toHaveCount(1);

	// The card that was not touched follows the tool; the one folded by hand stays folded, still running and when done.
	await expect(header(untouched)).toHaveAttribute("aria-expanded", "true");
	await expect(header(folded)).toHaveAttribute("aria-expanded", "false");
	update("toolu_saved", "saved out 1\nsaved out 2");
	await expect(header(folded)).toHaveAttribute("aria-expanded", "false");
	end("toolu_saved", "saved done");
	end("toolu_open", "open done");
	await expect(folded.getByLabel("Done")).toBeVisible();
	await expect(header(folded)).toHaveAttribute("aria-expanded", "false");
	await expect(header(untouched)).toHaveAttribute("aria-expanded", "false");
});

test("a call's card is the same card from its first streamed frame on: its spinner keeps turning when the arguments are complete (#708)", async ({
	page,
}) => {
	const { frame, start, end } = await openProbe(page, 0xce, "Tool card identity probe");
	const update = (assistantMessageEvent: Record<string, unknown>) =>
		frame({ type: "message_update", messageId: "m-id", message: { role: "assistant" }, assistantMessageEvent });
	frame({ type: "agent_start" });
	frame({ type: "message_start", messageId: "m-id", message: { role: "assistant", content: [] } });
	// The model starts the call: its arguments stream, and the card spins already.
	update({ type: "toolcall_start", contentIndex: 0 });
	const spinner = page.locator('[data-testid="tool-card"] .animate-spin');
	await expect(spinner).toHaveCount(1);
	await spinner.evaluate((el) => {
		(window as unknown as { spinnerSeen: Element }).spinnerSeen = el;
	});
	update({ type: "toolcall_delta", contentIndex: 0, delta: '{"command": "make identity"}' });
	// The arguments are complete: the call has its id and its name now, on the same card, whose spin goes on where it was.
	update({ type: "toolcall_end", contentIndex: 0, toolCall: call("toolu_identity", "make identity") });
	const card = page.locator('[data-testid="tool-card"][data-tool="bash"]', { hasText: "make identity" });
	await expect(card).toBeVisible();
	expect(
		await card
			.locator(".animate-spin")
			.evaluate((el) => el === (window as unknown as { spinnerSeen: Element }).spinnerSeen),
	).toBe(true);
	start("toolu_identity", "make identity");
	expect(
		await card
			.locator(".animate-spin")
			.evaluate((el) => el === (window as unknown as { spinnerSeen: Element }).spinnerSeen),
	).toBe(true);
	end("toolu_identity", "identity done");
	await expect(card.getByLabel("Done")).toBeVisible();
});
