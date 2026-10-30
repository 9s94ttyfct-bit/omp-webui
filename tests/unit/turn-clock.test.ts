import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OmpFrame, SessionEntry } from "../../shared/protocol.ts";
import { clockFrame, type TurnClock } from "../../web/src/store/turn-clock.ts";

/**
 * What the page notes as a turn's frames arrive (its own clock): when the turn began, and when the request in flight
 * started and sent its first token. omp reports a request's timing only once it ends, so these are what a stats line
 * can show while it streams. The frames are a recorded run (tests/fixtures/delta-frames.jsonl).
 */

const recorded: OmpFrame[] = readFileSync(join(import.meta.dir, "../fixtures/delta-frames.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l));
const t0 = Date.UTC(2026, 0, 5, 10, 0, 0);
/** A conversation whose one earlier turn took 90 s. */
const history = [
	{
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: new Date(t0).toISOString(),
		message: { role: "user", content: "go", attribution: "user", timestamp: t0 },
	},
	{
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: new Date(t0 + 90_000).toISOString(),
		message: { role: "assistant", content: [] },
	},
] as SessionEntry[];

describe("a turn begins and ends", () => {
	test("`agent_start` starts a clock and remembers how long the agent had worked before", () => {
		expect(clockFrame(null, { type: "agent_start" }, 5000, history)).toEqual({
			startedAt: 5000,
			activeBefore: 90_000,
		});
		expect(clockFrame(null, { type: "agent_start" }, 5000, [])?.activeBefore).toBe(0);
	});

	test("the end of the turn stops the clock; a turn the agent carries on with keeps it", () => {
		const running: TurnClock = { startedAt: 5000, activeBefore: 0 };
		expect(clockFrame(running, { type: "agent_end" }, 9000, [])).toBeNull();
		expect(clockFrame(running, { type: "agent_end", isTerminal: true }, 9000, [])).toBeNull();
		expect(clockFrame(running, { type: "session_settled" }, 9000, [])).toBeNull();

		const between = clockFrame(running, { type: "agent_end", isTerminal: false }, 9000, []);
		expect(between).toMatchObject({ startedAt: 5000 });
		// The next run is the same turn: it keeps its start (and does not count the first run twice).
		expect(clockFrame(between, { type: "agent_start" }, 9500, history)).toMatchObject({
			startedAt: 5000,
			activeBefore: 0,
		});
	});

	test("a clock left over from a turn whose end was never seen does not outlive the next turn's start", () => {
		const stale: TurnClock = { startedAt: 1000, activeBefore: 7 };
		expect(clockFrame(stale, { type: "agent_start" }, 50_000, history)).toEqual({
			startedAt: 50_000,
			activeBefore: 90_000,
		});
	});

	test("a page that opened mid-turn has no clock to add request marks to", () => {
		const frame = { type: "message_start", messageId: "m", message: { role: "assistant" } };
		expect(clockFrame(null, frame, 100, [])).toBeNull();
		expect(
			clockFrame(
				null,
				{ type: "message_update", messageId: "m", assistantMessageEvent: { type: "text_delta" } },
				100,
				[],
			),
		).toBeNull();
	});
});

describe("the request in flight", () => {
	const running: TurnClock = { startedAt: 1000, activeBefore: 0 };
	const start = (id: string, role = "assistant") => ({ type: "message_start", messageId: id, message: { role } });
	const token = (id: string, type = "text_delta") => ({
		type: "message_update",
		messageId: id,
		assistantMessageEvent: { type, contentIndex: 0, delta: "x" },
	});

	test("starts with the assistant's message, not the user's", () => {
		expect(clockFrame(running, start("m1", "user"), 1100, [])).toEqual(running);
		expect(clockFrame(running, start("m2"), 1200, [])?.step).toEqual({ messageId: "m2", startedAt: 1200 });
	});

	test("its first token is the first content event, noted once", () => {
		const begun = clockFrame(running, start("m2"), 1200, []);
		const first = clockFrame(begun, token("m2", "thinking_start"), 1900, []);
		expect(first?.step).toEqual({ messageId: "m2", startedAt: 1200, firstTokenAt: 1900 });
		expect(clockFrame(first, token("m2"), 2500, [])?.step?.firstTokenAt).toBe(1900);
	});

	test("a frame of another message, or one that carries no content, is not its first token", () => {
		const begun = clockFrame(running, start("m2"), 1200, []);
		expect(clockFrame(begun, token("other"), 1300, [])?.step?.firstTokenAt).toBeUndefined();
		expect(clockFrame(begun, token("m2", "message_info"), 1300, [])?.step?.firstTokenAt).toBeUndefined();
	});

	test("ends with the message: its own figures come from omp then", () => {
		const begun = clockFrame(running, start("m2"), 1200, []);
		expect(clockFrame(begun, { type: "message_end", messageId: "m2" }, 3000, [])?.step).toBeUndefined();
		// Another message ending leaves the one in flight alone.
		expect(clockFrame(begun, { type: "message_end", messageId: "m1" }, 3000, [])?.step?.messageId).toBe("m2");
	});

	test("a frame that is none of these changes nothing", () => {
		expect(clockFrame(running, { type: "tool_execution_start", toolCallId: "t" }, 2000, [])).toBe(running);
	});
});

describe("a recorded run", () => {
	test("marks each request's start and first token on arrival, frame by frame", () => {
		let clock = clockFrame(null, { type: "agent_start" }, 0, []);
		const marks: Record<string, { startedAt: number; firstTokenAt?: number } | undefined> = {};
		recorded.forEach((f, i) => {
			clock = clockFrame(clock, f, 1000 + i * 10, []);
			if (f.type === "message_update" && clock?.step) marks[clock.step.messageId] = clock.step;
		});
		// msg-2 starts at frame 2 and its first delta is frame 3; msg-4 likewise.
		const firsts = recorded.flatMap((f, i) =>
			f.type === "message_update" ? [{ id: f.messageId, at: 1000 + i * 10 }] : [],
		);
		for (const id of ["msg-2", "msg-4"]) {
			const first = firsts.find((x) => x.id === id);
			expect(marks[id]?.firstTokenAt, id).toBe(first?.at);
			expect(marks[id]?.startedAt, id).toBeLessThan(first?.at ?? 0);
		}
		// Every request ended: nothing is in flight, and the turn is still running (no `agent_end` came).
		expect(clock?.step).toBeUndefined();
		expect(clock?.startedAt).toBe(0);
	});
});
