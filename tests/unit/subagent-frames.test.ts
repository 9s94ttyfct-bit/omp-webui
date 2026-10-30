import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { LiveInfo, OmpFrame } from "../../shared/protocol.ts";
import { isOver } from "../../web/src/lib/subagents.ts";
import { applyFrame, initialLive, type LiveState } from "../../web/src/store/live.ts";
import { endAll, mergeSnapshot } from "../../web/src/store/subagents-live.ts";

/**
 * What omp's subagent frames do to a conversation's state: when each subagent started and ended (the
 * panel's order and elapsed time come from it), its in-flight message, and its tools with their live output.
 */

const NOW = Date.parse("2026-01-05T12:00:00.000Z");
beforeEach(() => setSystemTime(new Date(NOW)));
afterEach(() => setSystemTime());

const info: LiveInfo = {
	liveId: "L1",
	pid: 1,
	cwd: "/x",
	sessionFile: "/x/s.jsonl",
	sessionId: "s",
	args: [],
	startedAt: NOW,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};

const lifecycle = (payload: Record<string, unknown>): OmpFrame => ({
	type: "subagent_lifecycle",
	payload: { id: "Scout", agent: "explore", index: 0, ...payload },
});
const progress = (progress: Record<string, unknown>, payload: Record<string, unknown> = {}): OmpFrame => ({
	type: "subagent_progress",
	payload: { index: 0, agent: "explore", task: "t", progress: { id: "Scout", ...progress }, ...payload },
});
const event = (ev: Record<string, unknown>, id = "Scout"): OmpFrame => ({
	type: "subagent_event",
	payload: { id, event: ev },
});
const fold = (...frames: OmpFrame[]): LiveState => frames.reduce(applyFrame, initialLive(info));
const scout = (s: LiveState) => {
	const found = s.subagents.Scout;
	if (!found) throw new Error("no Scout");
	return found;
};

describe("lifecycle", () => {
	test("a started subagent is running, and starts now", () => {
		const s = scout(
			fold(
				lifecycle({
					status: "started",
					description: "Find config files",
					sessionFile: "/x/s/Scout.jsonl",
					parentToolCallId: "call_1",
					detached: true,
				}),
			),
		);
		expect(s).toMatchObject({
			status: "running",
			agent: "explore",
			description: "Find config files",
			sessionFile: "/x/s/Scout.jsonl",
			parentToolCallId: "call_1",
			detached: true,
			index: 0,
			startedAt: NOW,
		});
		expect(s.finishedAt).toBeUndefined();
	});

	test("an ended subagent keeps its start and records when it ended", () => {
		const first = fold(lifecycle({ status: "started" }));
		setSystemTime(new Date(NOW + 5000));
		const done = scout(applyFrame(first, lifecycle({ status: "completed" })));
		expect(done).toMatchObject({ status: "completed", startedAt: NOW, finishedAt: NOW + 5000 });
		for (const status of ["failed", "aborted"]) {
			expect(scout(applyFrame(first, lifecycle({ status }))).finishedAt).toBe(NOW + 5000);
		}
	});

	test("starting again under the same id begins a new run", () => {
		let s = fold(
			lifecycle({ status: "started" }),
			event({ type: "message_start", message: { role: "assistant", content: [] } }),
			event({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} }),
			lifecycle({ status: "completed" }),
		);
		setSystemTime(new Date(NOW + 60_000));
		s = applyFrame(s, lifecycle({ status: "started" }));
		expect(scout(s)).toMatchObject({ status: "running", startedAt: NOW + 60_000, streaming: null, tools: {} });
		expect(scout(s).finishedAt).toBeUndefined();
	});
});

describe("progress", () => {
	test("anchors the start to the elapsed time omp reports", () => {
		const s = scout(
			fold(lifecycle({ status: "started" }), progress({ status: "running", durationMs: 12_000, cost: 0.5 })),
		);
		expect(s.startedAt).toBe(NOW - 12_000);
		expect(s.progress).toMatchObject({ durationMs: 12_000, cost: 0.5 });
	});

	test("shows the agent's own completion estimate", () => {
		const s = scout(fold(progress({ status: "running", completionPercent: 40, resolvedModel: "claude-haiku-5-5" })));
		expect(s.progress).toMatchObject({ completionPercent: 40, resolvedModel: "claude-haiku-5-5" });
	});

	test("a progress frame for an unseen subagent adds a running one, with what the frame knows about it", () => {
		const s = scout(
			fold(
				progress({ status: "running", durationMs: 1000, description: "Reading" }, { assignment: "Do it", task: "Do" }),
			),
		);
		expect(s).toMatchObject({
			status: "running",
			assignment: "Do it",
			task: "Do",
			description: "Reading",
			startedAt: NOW - 1000,
		});
	});

	test("a final progress frame ends the subagent without moving its start", () => {
		const running = fold(lifecycle({ status: "started" }));
		setSystemTime(new Date(NOW + 9000));
		const s = scout(applyFrame(running, progress({ status: "completed", durationMs: 9000 })));
		expect(s).toMatchObject({ status: "completed", startedAt: NOW, finishedAt: NOW + 9000 });
	});
});

describe("events", () => {
	const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 5 });

	test("keep the message being written, and mark it ended when it is", () => {
		const writing = scout(
			fold(
				lifecycle({ status: "started" }),
				event({ type: "message_start", message: assistant("") }),
				event({ type: "message_update", assistantMessageEvent: { type: "text_delta", partial: assistant("Hel") } }),
			),
		);
		expect(writing.streaming).toEqual(assistant("Hel"));
		expect(writing.streamEnded).toBe(false);

		const ended = scout(
			fold(
				lifecycle({ status: "started" }),
				event({ type: "message_update", assistantMessageEvent: { partial: assistant("Hello") } }),
				event({ type: "message_end", message: assistant("Hello.") }),
			),
		);
		expect(ended.streaming).toEqual(assistant("Hello."));
		expect(ended.streamEnded).toBe(true);

		const next = scout(
			applyFrame(
				fold(lifecycle({ status: "started" }), event({ type: "message_end", message: assistant("Hello.") })),
				event({ type: "message_start", message: assistant("") }),
			),
		);
		expect(next.streamEnded).toBe(false);
		expect(next.streaming).toEqual(assistant(""));
	});

	test("ignore messages that are not the assistant's", () => {
		const s = scout(
			fold(
				lifecycle({ status: "started" }),
				event({ type: "message_start", message: { role: "user", content: "steer" } }),
				event({ type: "message_end", message: { role: "toolResult", content: [] } }),
			),
		);
		expect(s.streaming ?? null).toBeNull();
	});

	test("the final message stays until the next one starts, even after the agent ends", () => {
		const s = scout(
			fold(
				lifecycle({ status: "started" }),
				event({ type: "message_end", message: assistant("Done.") }),
				event({ type: "agent_end" }),
			),
		);
		expect(s.streaming).toEqual(assistant("Done."));
		expect(s.streamEnded).toBe(true);
	});

	test("follow its tools with their live output", () => {
		const s = scout(
			fold(
				lifecycle({ status: "started" }),
				event({
					type: "tool_execution_start",
					toolCallId: "t1",
					toolName: "bash",
					args: { command: "ls" },
					intent: "List",
				}),
				event({
					type: "tool_execution_update",
					toolCallId: "t1",
					partialResult: { content: [{ type: "text", text: "a\nb" }] },
				}),
			),
		);
		expect(s.tools?.t1).toMatchObject({
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
			intent: "List",
			done: false,
			partial: { content: [{ type: "text", text: "a\nb" }] },
		});
		const ended = scout(
			applyFrame(
				fold(
					lifecycle({ status: "started" }),
					event({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} }),
				),
				event({ type: "tool_execution_end", toolCallId: "t1", result: { content: [] }, isError: true }),
			),
		);
		expect(ended.tools?.t1).toMatchObject({ done: true, isError: true, result: { content: [] } });
	});

	test("from a subagent not seen before add it as a running one that starts now", () => {
		const s = scout(fold(event({ type: "agent_start" })));
		expect(s).toMatchObject({ status: "running", startedAt: NOW });
	});

	test("a tool's output after the tool has ended is not taken back", () => {
		const s = scout(
			fold(
				lifecycle({ status: "started" }),
				event({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} }),
				event({ type: "tool_execution_end", toolCallId: "t1", result: "ok" }),
				event({ type: "tool_execution_update", toolCallId: "t1", partialResult: "late" }),
			),
		);
		expect(s.tools?.t1.done).toBe(true);
		expect(s.tools?.t1.result).toBe("ok");
	});
});

describe("snapshot (get_subagents)", () => {
	const listed = (extra: Record<string, unknown> = {}) => ({
		id: "Scout",
		index: 0,
		agent: "explore",
		status: "running",
		sessionFile: "/x/s/Scout.jsonl",
		lastUpdate: NOW - 3000,
		...extra,
	});

	test("adds the subagents omp is running, with the start its elapsed time implies", () => {
		const subagents = mergeSnapshot(
			{},
			[listed({ description: "Find", progress: { id: "Scout", status: "running", durationMs: 20_000, cost: 0.2 } })],
			NOW,
		);
		expect(subagents.Scout).toMatchObject({
			status: "running",
			agent: "explore",
			description: "Find",
			sessionFile: "/x/s/Scout.jsonl",
			startedAt: NOW - 20_000,
			progress: { durationMs: 20_000, cost: 0.2 },
		});
	});

	test("keeps the start it already knew, and what the frames said about it", () => {
		const before = fold(
			lifecycle({ status: "started", parentToolCallId: "call_1" }),
			event({ type: "agent_start" }),
		).subagents;
		setSystemTime(new Date(NOW + 4000));
		const subagents = mergeSnapshot(before, [listed()], NOW + 4000);
		expect(subagents.Scout).toMatchObject({ startedAt: NOW, parentToolCallId: "call_1", status: "running" });
	});

	test("a running subagent omp no longer lists has ended, with an outcome nobody knows: it is not shown as completed (#366)", () => {
		const before = fold(lifecycle({ status: "started" })).subagents;
		const subagents = mergeSnapshot(before, [], NOW + 8000);
		// It may have failed, been aborted or cancelled while its end frame was missed: only omp's own words say how it ended.
		expect(subagents.Scout).toMatchObject({ status: "ended", startedAt: NOW, finishedAt: NOW + 8000 });
		expect(isOver(subagents.Scout.status)).toBe(true);
		expect(subagents.Scout.status).not.toBe("completed");
	});

	test("a subagent that omp's registry lists as over, or whose end frame was seen, keeps what omp said", () => {
		const before = fold(lifecycle({ status: "started" }), lifecycle({ status: "failed" })).subagents;
		expect(mergeSnapshot(before, [], NOW + 8000).Scout.status).toBe("failed");
		const running = fold(lifecycle({ status: "started" })).subagents;
		expect(mergeSnapshot(running, [{ id: "Scout", status: "aborted" }], NOW + 8000).Scout.status).toBe("aborted");
	});

	test("leaves ended subagents alone, and ignores entries without an id", () => {
		const before = fold(lifecycle({ status: "started" }), lifecycle({ status: "failed" })).subagents;
		const subagents = mergeSnapshot(before, [{ status: "running" }, null], NOW + 9000);
		expect(subagents.Scout.status).toBe("failed");
		expect(Object.keys(subagents)).toEqual(["Scout"]);
	});
});

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 5 });

describe("tools of a run that is over", () => {
	const open = (...more: OmpFrame[]) =>
		fold(
			lifecycle({ status: "started" }),
			event({ type: "message_start", message: assistant("working") }),
			event({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } }),
			event({ type: "tool_execution_update", toolCallId: "t1", partialResult: "a" }),
			event({ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: {} }),
			event({ type: "tool_execution_end", toolCallId: "t2", result: "ok" }),
			...more,
		);
	const noneOpen = (s: LiveState["subagents"][string]) =>
		expect(Object.values(s.tools ?? {}).filter((t) => !t.done)).toEqual([]);

	test("every way a subagent ends closes its open tools as failed, and drops what it was writing", () => {
		const ends: [string, LiveState["subagents"]][] = [
			["lifecycle", open(lifecycle({ status: "cancelled" })).subagents],
			["progress", open(progress({ status: "failed" })).subagents],
			["snapshot", mergeSnapshot(open().subagents, [], NOW + 1000)],
			["snapshot status", mergeSnapshot(open().subagents, [{ id: "Scout", status: "aborted" }], NOW + 1000)],
			["process gone", endAll(open().subagents, NOW + 1000)],
		];
		for (const [how, subagents] of ends) {
			const s = subagents.Scout;
			expect(Object.keys(s.tools ?? {}).sort(), how).toEqual(["t1", "t2"]);
			noneOpen(s);
			expect(s.tools?.t1, how).toMatchObject({ done: true, isError: true });
			// A tool that had finished on its own keeps its outcome.
			expect(s.tools?.t2, how).toMatchObject({ done: true, result: "ok" });
			expect(s.tools?.t2.isError, how).toBe(false);
			expect(s.streaming, how).toBeNull();
		}
	});

	test("a running subagent keeps its open tools and its stream", () => {
		const s = scout(open());
		expect(s.tools?.t1.done).toBe(false);
		expect(s.streaming).toEqual(assistant("working"));
	});

	test("frames that straggle in after the end do not open a tool again", () => {
		const s = scout(
			applyFrame(
				open(lifecycle({ status: "aborted" })),
				event({ type: "tool_execution_start", toolCallId: "t3", toolName: "bash", args: {} }),
			),
		);
		noneOpen(s);
		expect(s.streaming).toBeNull();
	});
});

describe("what a subagent's live state retains", () => {
	const big = "x".repeat(40_000);
	const bytes = (v: unknown) => JSON.stringify(v).length;

	test("a tool that ends drops what it printed on the way and what it was called with", () => {
		const s = scout(
			fold(
				lifecycle({ status: "started" }),
				event({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: big } }),
				event({ type: "tool_execution_update", toolCallId: "t1", partialResult: big }),
				event({ type: "tool_execution_end", toolCallId: "t1", result: "ok" }),
			),
		);
		expect(s.tools?.t1.partial).toBeUndefined();
		expect(s.tools?.t1.args).toBeUndefined();
		expect(s.tools?.t1.result).toBe("ok");
	});

	test("two thousand tools of 40 KB leave only the latest few finished ones, and the open one", () => {
		let live = fold(lifecycle({ status: "started" }));
		for (let i = 0; i < 2000; i++) {
			setSystemTime(new Date(NOW + i));
			live = [
				event({ type: "tool_execution_start", toolCallId: `t${i}`, toolName: "bash", args: { command: big } }),
				event({ type: "tool_execution_update", toolCallId: `t${i}`, partialResult: big }),
				event({ type: "tool_execution_end", toolCallId: `t${i}`, result: { content: [{ type: "text", text: big }] } }),
			].reduce(applyFrame, live);
		}
		setSystemTime(new Date(NOW + 5000));
		live = applyFrame(live, event({ type: "tool_execution_start", toolCallId: "open", toolName: "bash", args: {} }));
		const s = scout(live);
		const ids = Object.keys(s.tools ?? {});
		expect(ids.length).toBe(21);
		expect(ids).toContain("open");
		expect(ids).toContain("t1999");
		expect(ids).not.toContain("t1979");
		// 20 results of 40 KB, not 2000.
		expect(bytes(s.tools)).toBeLessThan(1_000_000);
	});

	test("a subagent's streaming message is gone once it ends", () => {
		const s = scout(
			fold(
				lifecycle({ status: "started" }),
				event({ type: "message_start", message: assistant(big) }),
				lifecycle({ status: "completed" }),
			),
		);
		expect(s.streaming).toBeNull();
		expect(bytes(s)).toBeLessThan(5000);
	});
});
