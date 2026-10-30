import "./browser-globals.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SessionEntry } from "../../shared/protocol.ts";
import { pinnedRange, sameTurn, windowAround, windowStart } from "../../web/src/components/AgentTurn.tsx";
import { sameRow } from "../../web/src/components/Message.tsx";
import type { AgentMessage } from "../../web/src/lib/messages.ts";
import { indexTree } from "../../web/src/lib/tree.ts";
import { type Segment, segmentTranscript, shareSegments } from "../../web/src/lib/turns.ts";
import { applyFrame, initialLive, type ToolExec } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * What a streaming goal run costs the page must not grow with how long it has run: it is one turn of thousands of
 * steps, and a tool somewhere moves several times a second. These pin down the parts that decide it: how many rows of
 * a turn are drawn, which rows and turns are drawn again for a change that is none of theirs, and what a process
 * remembers of the tools it ran.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const stamp = "2026-01-05T10:00:00.000Z";
const user = (id: string, parentId: string | null): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: stamp,
	message: { role: "user", content: [{ type: "text", text: id }], attribution: "user" },
});
const step = (n: number, parentId: string): SessionEntry[] => [
	{
		type: "message",
		id: `a${n}`,
		parentId,
		timestamp: stamp,
		message: { role: "assistant", content: [{ type: "toolCall", id: `call${n}`, name: "bash", arguments: {} }] },
	},
	{
		type: "message",
		id: `r${n}`,
		parentId: `a${n}`,
		timestamp: stamp,
		message: { role: "toolResult", toolCallId: `call${n}`, toolName: "bash", content: [{ type: "text", text: "ok" }] },
	},
];
/** A prompt and `steps` steps of one turn. */
function conversation(steps: number): SessionEntry[] {
	const out = [user("u1", null)];
	let parent = "u1";
	for (let i = 0; i < steps; i++) {
		const pair = step(i, parent);
		out.push(...pair);
		parent = pair[1].id;
	}
	return out;
}
const split = (rows: SessionEntry[]): Segment[] => segmentTranscript(rows, indexTree(rows));

test("a turn of thousands of rows draws a few dozen, and its window moves a block at a time", () => {
	// Shown whole while it fits.
	expect(windowStart(40, 60)).toBe(0);
	expect(windowStart(60, 60)).toBe(0);
	expect(windowStart(119, 60)).toBe(0);
	// Then the last 60 or a block more, so the first row drawn does not change with every row added.
	expect(windowStart(120, 60)).toBe(60);
	expect(windowStart(150, 60)).toBe(60);
	expect(windowStart(179, 60)).toBe(60);
	expect(windowStart(180, 60)).toBe(120);
	// What is drawn is never more than two blocks, however long the turn.
	for (const total of [500, 3448, 10_000]) expect(total - windowStart(total, 60)).toBeLessThan(120);
	// "Show earlier steps" asks for a block more, and gets it.
	expect(windowStart(3448, 60 + 60)).toBe(windowStart(3448, 60) - 60);
});

test("a search hit among the rows that are not drawn gets a block of rows of its own, not everything from there to the end", () => {
	// Drawn already: nothing to do.
	expect(windowAround(3448, 60, 3440)).toBeNull();
	expect(windowAround(3448, 60, windowStart(3448, 60))).toBeNull();
	expect(windowAround(100, 60, 5)).toBeNull();
	expect(windowAround(3448, 60, -1)).toBeNull();
	// Hidden: the block it is in, with a few rows before it and at most two blocks in all.
	expect(windowAround(3448, 60, 100)).toEqual({ from: 60, to: 180 });
	expect(windowAround(3448, 60, 62)).toEqual({ from: 0, to: 120 });
	expect(windowAround(3448, 60, 1000)).toEqual({ from: 960, to: 1080 });
	for (const hit of [0, 3, 59, 60, 61, 62, 63, 500, 3000]) {
		const w = windowAround(3448, 60, hit);
		if (!w) continue;
		expect(w.from).toBeLessThanOrEqual(hit);
		expect(w.to).toBeGreaterThan(hit);
		expect(w.to - w.from).toBeLessThanOrEqual(120);
	}
	// Near the end of a turn that is not long: the window stops at the last row.
	expect(windowAround(130, 60, 20)).toEqual({ from: 0, to: 120 });
});

test("a window kept for a hit is found among the rows by its ids, so it stays where it is as the turn grows", () => {
	const rows = Array.from({ length: 300 }, (_, i) => ({ id: `r${i}` }));
	expect(pinnedRange(rows, { from: "r60", to: "r179" })).toEqual({ start: 60, end: 180 });
	expect(pinnedRange(rows, { from: "r60", to: null })).toEqual({ start: 60, end: 300 });
	// More rows are added at the end: the window did not move.
	const grown = [...rows, ...Array.from({ length: 50 }, (_, i) => ({ id: `n${i}` }))];
	expect(pinnedRange(grown, { from: "r60", to: "r179" })).toEqual({ start: 60, end: 180 });
	// Its first row is gone (another branch): no window.
	expect(pinnedRange(rows, { from: "gone", to: null })).toBeNull();
	// Its last row is gone: it reaches the end.
	expect(pinnedRange(rows, { from: "r60", to: "gone" })).toEqual({ start: 60, end: 300 });
});

test("a turn that has not changed is the same object when the transcript is split again after an entry is added", () => {
	const rows = conversation(5);
	const before = split(rows);
	const more = [...rows, ...step(5, "r4")];
	const after = shareSegments(before, split(more));
	// The turn gained a step: it is a new turn. Its prompt is what it was.
	expect(after[1]).not.toBe(before[1]);
	expect(after[0]).toBe(before[0]);

	// An entry added after a prompt that ends another turn leaves the turns before as they were.
	const twoTurns = [...rows, user("u2", "r4"), ...step(9, "u2")];
	const first = split(twoTurns);
	const grown = shareSegments(first, split([...twoTurns, ...step(10, "r9")]));
	expect(grown[0]).toBe(first[0]);
	expect(grown[1]).toBe(first[1]);
	expect(grown[2]).toBe(first[2]);
	expect(grown[3]).not.toBe(first[3]);
});

test("an entry that is a new object (rewritten by omp) makes its turn a new one", () => {
	const rows = conversation(3);
	const before = split(rows);
	const rewritten = rows.map((e) => (e.id === "r1" ? { ...e } : e));
	const after = shareSegments(before, split(rewritten));
	expect(after[1]).not.toBe(before[1]);
});

const call = (id: string): AgentMessage => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "bash", arguments: {} }],
});
const result = (id: string): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	content: [{ type: "text", text: "ok" }],
});
const exec = (id: string, done = false): ToolExec => ({
	toolCallId: id,
	toolName: "bash",
	args: {},
	done,
	startedAt: 0,
});
const actions = {};

test("a row is not drawn again because another tool moved, but is when its own did", () => {
	const message = call("c1");
	const props = {
		entry: null,
		message,
		actions,
		toolResults: new Map([["c0", result("c0")]]),
		tools: { c0: exec("c0") },
	};
	// Another tool starts, streams and ends; another result is saved: new maps, the same facts about `c1`.
	const elsewhere = {
		...props,
		toolResults: new Map([...props.toolResults, ["c9", result("c9")]]),
		tools: { ...props.tools, c9: exec("c9", true) },
	};
	expect(sameRow(props, elsewhere)).toBe(true);
	// Its own tool starts running.
	const started = { ...props, tools: { ...props.tools, c1: exec("c1") } };
	expect(sameRow(props, started)).toBe(false);
	// Its own tool's output streams (a new record), then ends, then the result is saved.
	const streamed = { ...started, tools: { ...started.tools, c1: { ...exec("c1"), partial: "x" } } };
	expect(sameRow(started, streamed)).toBe(false);
	const saved = { ...streamed, toolResults: new Map([...streamed.toolResults, ["c1", result("c1")]]) };
	expect(sameRow(streamed, saved)).toBe(false);
	// A row of another message, or with other actions, is another row.
	expect(sameRow(props, { ...props, message: call("c1") })).toBe(false);
	expect(sameRow(props, { ...props, actions: {} })).toBe(false);
});

test("a turn is drawn again when one of its own tool calls changed, not for another turn's", () => {
	const rows = conversation(3);
	const [, turn] = split(rows);
	if (turn.kind !== "turn") throw new Error("not a turn");
	const base = {
		turn: turn.turn,
		actions,
		live: false,
		tools: {} as Record<string, ToolExec>,
		toolResults: new Map<string, AgentMessage>(),
	};
	const elsewhere = { ...base, toolResults: new Map([["other", result("other")]]), tools: { other: exec("other") } };
	expect(sameTurn(base, elsewhere)).toBe(true);
	const mine = { ...base, tools: { call1: exec("call1") } };
	expect(sameTurn(base, mine)).toBe(false);
	expect(sameTurn(base, { ...base, live: true })).toBe(false);
	// The live turn gets its streaming messages as `tail`, a new element for every render: it is drawn for each.
	expect(sameTurn({ ...base, tail: null }, { ...base, tail: null })).toBe(true);
});

test("a process remembers the tools it is running and the last few it finished, not every one it ever ran", () => {
	let s = initialLive({
		liveId: "L1",
		pid: 1,
		cwd: "/",
		sessionFile: null,
		sessionId: null,
		args: [],
		startedAt: 0,
		streaming: false,
		exited: false,
		subscribers: 1,
		pausedAt: null,
		mode: "full",
	});
	// A goal run: thousands of tools, each with output; one is still running at the end.
	for (let i = 0; i < 3000; i++) {
		s = applyFrame(s, { type: "tool_execution_start", toolCallId: `t${i}`, toolName: "bash", args: {} });
		s = applyFrame(s, {
			type: "tool_execution_end",
			toolCallId: `t${i}`,
			toolName: "bash",
			result: { text: "x".repeat(1000) },
		});
	}
	s = applyFrame(s, { type: "tool_execution_start", toolCallId: "running", toolName: "bash", args: {} });
	const ids = Object.keys(s.tools);
	expect(ids.length).toBeLessThanOrEqual(51);
	expect(ids).toContain("running");
	expect(ids).toContain("t2999");
	expect(ids).not.toContain("t0");
	// A tool that is still running is kept however long it has run.
	for (let i = 0; i < 200; i++) {
		s = applyFrame(s, { type: "tool_execution_start", toolCallId: `n${i}`, toolName: "bash", args: {} });
		s = applyFrame(s, { type: "tool_execution_end", toolCallId: `n${i}`, toolName: "bash", result: {} });
	}
	expect(s.tools.running).toBeDefined();
	expect(s.tools.running.done).toBe(false);
});
