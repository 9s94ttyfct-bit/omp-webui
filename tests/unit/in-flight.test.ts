import { expect, test } from "bun:test";
import { InFlightMessage, mayRewriteEntries } from "../../server/omp/in-flight.ts";
import { isRecord } from "../../shared/guards.ts";
import type { OmpFrame } from "../../shared/protocol.ts";

/** The message omp is writing, kept so that a tab that attaches in the middle of it is shown what it missed (#363). */

const start = (messageId = "m1"): OmpFrame => ({
	type: "message_start",
	messageId,
	message: { role: "assistant", content: [] },
});
const update = (
	type: string,
	contentIndex: number,
	extra: Record<string, unknown> = {},
	messageId = "m1",
): OmpFrame => ({
	type: "message_update",
	messageId,
	message: { role: "assistant" },
	assistantMessageEvent: { type, contentIndex, ...extra },
});
const text = (delta: string, contentIndex = 0) => update("text_delta", contentIndex, { delta });
const deltas = (m: InFlightMessage) => m.replay().map((f) => f.assistantMessageEvent);

test("the increments of one block are one frame, and a different block or kind of increment is not joined to it", () => {
	const m = new InFlightMessage();
	for (const f of [
		start(),
		update("thinking_start", 0),
		update("thinking_delta", 0, { delta: "Hmm, " }),
		update("thinking_delta", 0, { delta: "let me see." }),
		update("thinking_end", 0, { content: "Hmm, let me see." }),
		update("text_start", 1),
		text("The ", 1),
		text("end.", 1),
		text("Another block", 2),
	])
		m.note(f);
	expect(m.messageId).toBe("m1");
	expect(deltas(m)).toEqual([
		undefined,
		{ type: "thinking_start", contentIndex: 0 },
		{ type: "thinking_delta", contentIndex: 0, delta: "Hmm, let me see." },
		{ type: "thinking_end", contentIndex: 0, content: "Hmm, let me see." },
		{ type: "text_start", contentIndex: 1 },
		{ type: "text_delta", contentIndex: 1, delta: "The end." },
		{ type: "text_delta", contentIndex: 2, delta: "Another block" },
	]);
});

test("the frames omp sent are not changed: the tabs that were there hold the same objects", () => {
	const m = new InFlightMessage();
	const first = text("one ");
	const second = text("two");
	for (const f of [start(), first, second]) m.note(f);
	expect(first.assistantMessageEvent).toEqual({ type: "text_delta", contentIndex: 0, delta: "one " });
	expect(second.assistantMessageEvent).toEqual({ type: "text_delta", contentIndex: 0, delta: "two" });
});

test("arguments being typed are not kept (the page shows a call only once it ends); the call's start and end are", () => {
	const m = new InFlightMessage();
	for (const f of [
		start(),
		update("toolcall_start", 0),
		update("toolcall_delta", 0, { delta: '{"comm' }),
		update("toolcall_delta", 0, { delta: 'and":"ls"}' }),
		update("toolcall_end", 0, { toolCall: { id: "c1", name: "bash", arguments: { command: "ls" } } }),
	])
		m.note(f);
	expect(m.replay().map((f) => (isRecord(f.assistantMessageEvent) ? f.assistantMessageEvent.type : undefined))).toEqual(
		[undefined, "toolcall_start", "toolcall_end"],
	);
});

test("a snapshot of the whole message replaces what came before it", () => {
	const m = new InFlightMessage();
	const snapshot = update("text_delta", 0, {
		partial: { role: "assistant", content: [{ type: "text", text: "so far" }] },
	});
	for (const f of [start(), text("a"), text("b"), snapshot]) m.note(f);
	expect(m.replay()).toEqual([snapshot]);
});

test("the end of the message, and the end of the turn, leave nothing in flight; another message's updates are not taken for it", () => {
	const m = new InFlightMessage();
	m.note(start());
	m.note(text("stray", 0));
	m.note(update("text_delta", 0, { delta: "of another" }, "m2"));
	expect(deltas(m)).toEqual([undefined, { type: "text_delta", contentIndex: 0, delta: "stray" }]);
	m.note({ type: "message_end", messageId: "m1", message: { role: "assistant", content: [] } });
	expect(m.messageId).toBeNull();
	expect(m.replay()).toEqual([]);

	// A turn that is stopped may not end its message by itself.
	m.note(start("m3"));
	m.note({ type: "agent_end", isTerminal: true });
	expect(m.messageId).toBeNull();
	expect(m.replay()).toEqual([]);
	// And a message that began is replaced by the one that begins after it.
	m.note(start("m4"));
	m.note(start("m5"));
	expect(m.messageId).toBe("m5");
	expect(m.replay()).toHaveLength(1);
});

test("a frame that streams content, reports progress or asks the user cannot rewrite an entry; the rest may", () => {
	for (const type of [
		"message_update",
		"tool_execution_update",
		"subagent_progress",
		"extension_ui_request",
		"queue_update",
	])
		expect(mayRewriteEntries({ type }), type).toBe(false);
	for (const type of [
		"agent_start",
		"message_end",
		"agent_end",
		"auto_retry_end",
		"auto_compaction_end",
		"command_output",
		"session_settled",
	])
		expect(mayRewriteEntries({ type }), type).toBe(true);
});
