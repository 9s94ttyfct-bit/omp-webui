import { expect, test } from "bun:test";
import type { LiveInfo, OmpFrame, SessionEntry } from "../../shared/protocol.ts";
import { applyFrame, initialLive, type LiveState } from "../../web/src/store/live.ts";

/**
 * A page that opens a conversation while a long tool runs (#598) never saw `tool_execution_start`: the tool's output
 * is shown from the first update on, and its end closes it like any other.
 */

const info: LiveInfo = {
	liveId: "L1",
	pid: 1,
	cwd: "/",
	sessionFile: null,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: true,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};

const fold = (frames: OmpFrame[], from: LiveState = initialLive(info)): LiveState => frames.reduce(applyFrame, from);

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

const update = (value: string): OmpFrame => ({
	type: "tool_execution_update",
	toolCallId: "call_wait",
	toolName: "wait",
	args: { ids: ["Scout"] },
	intent: "Waiting for Scout",
	partialResult: text(value),
});

const end: OmpFrame = {
	type: "tool_execution_end",
	toolCallId: "call_wait",
	toolName: "wait",
	result: text("done"),
	isError: false,
};

test("what a tool prints is shown as the output of a running tool, though the page never saw the tool start", () => {
	const s = fold([update("Waiting on Scout: 12 s")]);
	expect(s.tools.call_wait).toMatchObject({
		toolCallId: "call_wait",
		toolName: "wait",
		args: { ids: ["Scout"] },
		intent: "Waiting for Scout",
		partial: text("Waiting on Scout: 12 s"),
		done: false,
	});
});

test("the next update replaces the output, and the end closes the tool with its result", () => {
	const running = fold([update("Waiting on Scout: 12 s"), update("Waiting on Scout: 13 s")]);
	expect(running.tools.call_wait.partial).toEqual(text("Waiting on Scout: 13 s"));
	expect(running.tools.call_wait.done).toBe(false);
	const ended = fold([end], running);
	expect(ended.tools.call_wait).toMatchObject({ done: true, result: text("done"), isError: false });
});

test("a tool that started under this page keeps what it had when an update comes", () => {
	const s = fold([
		{
			type: "tool_execution_start",
			toolCallId: "call_wait",
			toolName: "wait",
			args: { ids: ["Scout"] },
			intent: "Own",
		},
		update("Waiting on Scout: 12 s"),
	]);
	expect(s.tools.call_wait).toMatchObject({ intent: "Own", partial: text("Waiting on Scout: 12 s"), done: false });
});

test("an update that comes after the end does not reopen the tool", () => {
	const s = fold([update("12 s"), end, update("late")]);
	expect(s.tools.call_wait.done).toBe(true);
	expect(s.tools.call_wait.result).toEqual(text("done"));
});

test("an update with no tool call id is no tool", () => {
	const s = fold([{ type: "tool_execution_update", toolName: "wait", partialResult: text("x") }]);
	expect(s.tools).toEqual({});
});

const stream: OmpFrame = {
	type: "tool_stream_update",
	toolCallId: "call_edit",
	toolName: "edit",
	partial: { path: "a.ts" },
};

test("the arguments of a call being written (`tool_stream_update`) are no tool running: nothing starts it but the tool's own output", () => {
	const before = initialLive(info);
	// Seen before its start: omp's `edit` streams its arguments while the model is still typing the call.
	expect(fold([stream], before)).toBe(before);
	expect(fold([stream], before).tools).toEqual({});
});

test("a tool that started keeps what its stream says of it", () => {
	const s = fold([
		{ type: "tool_execution_start", toolCallId: "call_edit", toolName: "edit", args: { path: "a.ts" } },
		stream,
	]);
	expect(s.tools.call_edit).toMatchObject({ done: false, partial: { path: "a.ts" } });
});

const resultEntry = (id: string, toolCallId: string): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text: "ok" }] },
});

test("a late update for a call that is over, and was forgotten since, does not start it again", () => {
	// 60 calls start and end: the page keeps the last of them, and has forgotten the first (see `trimTools`).
	const frames: OmpFrame[] = [];
	for (let i = 0; i < 60; i++) {
		frames.push(
			{ type: "tool_execution_start", toolCallId: `c${i}`, toolName: "bash", args: {} },
			{ type: "tool_execution_end", toolCallId: `c${i}`, toolName: "bash", result: text("ok") },
		);
	}
	const done = fold(frames, { ...initialLive(info), entries: [resultEntry("r0", "c0")] });
	expect(done.tools.c0).toBeUndefined();
	expect(done.tools.c59?.done).toBe(true);
	const late: OmpFrame = {
		type: "tool_execution_update",
		toolCallId: "c0",
		toolName: "bash",
		partialResult: text("late"),
	};
	expect(fold([late], done)).toBe(done);
	// A call whose result is only announced so far (the entries have not caught up) is over too.
	const announced = fold([
		{
			type: "message_end",
			messageId: "r1",
			message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }] },
		},
	]);
	const lateAnnounced: OmpFrame = { type: "tool_execution_update", toolCallId: "c1", partialResult: text("late") };
	expect(fold([lateAnnounced], announced)).toBe(announced);
	// One with no result anywhere is still a call the page missed the start of.
	expect(fold([update("12 s")], done).tools.call_wait?.done).toBe(false);
});
