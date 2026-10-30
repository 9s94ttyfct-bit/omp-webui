import { describe, expect, test } from "bun:test";
import type { LiveInfo, OmpFrame } from "../../shared/protocol.ts";
import { useLang } from "../../web/src/i18n/index.ts";
import { fmtClock } from "../../web/src/lib/format.ts";
import type { AgentMessage } from "../../web/src/lib/messages.ts";
import { timerWanted, toolStartedAt, toolTimer, wallTimeMs } from "../../web/src/lib/tool-time.ts";
import { toolTimerOf } from "../../web/src/lib/tool-timer.ts";
import { applyFrame, initialLive, type ToolExec } from "../../web/src/store/live.ts";

/**
 * How long a tool call ran (#657): the figure each card shows, derived from what the page holds of the call. Saved
 * results are checked on the shapes omp writes (`tests/fixtures/delta-frames.jsonl`: a bash result's `details.wallTimeMs`).
 */

const result = (extra: Partial<AgentMessage> = {}): AgentMessage => ({
	role: "toolResult",
	toolCallId: "c1",
	toolName: "bash",
	content: [{ type: "text", text: "ok" }],
	timestamp: 10_000,
	...extra,
});

const exec = (extra: Partial<ToolExec> = {}): ToolExec => ({
	toolCallId: "c1",
	toolName: "bash",
	args: {},
	done: false,
	startedAt: 1_000,
	...extra,
});

describe("a call that is over", () => {
	test("takes bash's own wall time from its saved result before anything else", () => {
		const saved = result({ details: { wallTimeNoticeEmitted: false, timeoutSeconds: 300, wallTimeMs: 36.82 } });
		// The page's own measure (5 s) and the saved timestamps (8 s) both disagree: omp's figure wins.
		const seen = exec({ done: true, startedAt: 1_000, endedAt: 6_000 });
		expect(toolTimer({ result: saved, exec: seen, calledAt: 2_000 })).toEqual({ state: "done", ms: 36.82 });
	});

	test("takes it from the end frame's result while the saved result has not arrived", () => {
		const ended = exec({ done: true, endedAt: 9_000, result: { content: [], details: { wallTimeMs: 1234 } } });
		expect(toolTimer({ exec: ended })).toEqual({ state: "done", ms: 1234 });
	});

	test("measures a call the page watched from its start to its end", () => {
		const ended = exec({ done: true, startedAt: 1_000, endedAt: 3_500 });
		expect(toolTimer({ exec: ended })).toEqual({ state: "done", ms: 2_500 });
		// With the saved result too (no wall time in it, as a `read`'s): the page's measure is the finer one.
		expect(toolTimer({ result: result(), exec: ended, calledAt: 2_000 })).toEqual({ state: "done", ms: 2_500 });
	});

	test("reads a conversation from its file as the result's timestamp less when the assistant message ended", () => {
		expect(toolTimer({ result: result({ timestamp: 10_000 }), calledAt: 7_250 })).toEqual({ state: "done", ms: 2_750 });
		// A result that says no more than a tool's output (a `bash` with no `wallTimeMs`) is no different.
		expect(toolTimer({ result: result({ details: { exitCode: 1 } }), calledAt: 7_250 })).toEqual({
			state: "done",
			ms: 2_750,
		});
	});

	test("does not trust a start the page did not see", () => {
		// It heard the call only when it ended: `startedAt` is that moment, and the page's measure is 0 ms, which is not a run time.
		const heardLate = exec({ done: true, late: true, startedAt: 5_000, endedAt: 5_000 });
		expect(toolTimer({ exec: heardLate })).toBeNull();
		expect(toolTimer({ result: result({ timestamp: 10_000 }), exec: heardLate, calledAt: 6_000 })).toEqual({
			state: "done",
			ms: 4_000,
		});
	});

	test("says nothing when no figure is known, and never makes one up", () => {
		expect(toolTimer({ result: result({ timestamp: undefined }), calledAt: 1_000 })).toBeNull();
		expect(toolTimer({ result: result(), calledAt: undefined })).toBeNull();
		// A result written before the message ended is a clock that disagrees with itself, not a negative time.
		expect(toolTimer({ result: result({ timestamp: 500 }), calledAt: 1_000 })).toBeNull();
		expect(toolTimer({ exec: exec({ done: true, startedAt: 9_000, endedAt: 8_000 }) })).toBeNull();
	});

	test("ignores a wall time that is not a duration", () => {
		for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "12", null, undefined]) {
			expect(wallTimeMs({ wallTimeMs: bad })).toBeUndefined();
		}
		expect(wallTimeMs(undefined)).toBeUndefined();
		expect(wallTimeMs("wallTimeMs")).toBeUndefined();
		expect(wallTimeMs({ wallTimeMs: 0 })).toBe(0);
		// And then falls to the next figure.
		const saved = result({ details: { wallTimeMs: -5 }, timestamp: 4_000 });
		expect(toolTimer({ result: saved, calledAt: 3_000 })).toEqual({ state: "done", ms: 1_000 });
	});
});

describe("a call that is running", () => {
	test("counts from when the page saw it start", () => {
		expect(toolTimer({ exec: exec({ startedAt: 1_234 }) })).toEqual({ state: "running", since: 1_234 });
	});

	test("counts a call the page did not see start from the end of the message that made it, on this page's clock", () => {
		// omp's times are the server's; the server's clock reads 30 s ahead of this page's.
		const late = exec({ late: true, startedAt: 99_000 });
		expect(toolTimer({ exec: late, calledAt: 50_000, offsetMs: 30_000 })).toEqual({ state: "running", since: 20_000 });
		// Without that time nothing is known of when it began.
		expect(toolTimer({ exec: late })).toBeNull();
	});

	test("a call that has not started, or was never answered, has no timer", () => {
		expect(toolTimer({})).toBeNull();
		expect(toolTimer({ calledAt: 1_000 })).toBeNull();
	});
});

describe("which calls are timed", () => {
	test("all, only shell commands, or none", () => {
		expect(timerWanted("all", "read")).toBe(true);
		expect(timerWanted("all", "bash")).toBe(true);
		expect(timerWanted("shell", "bash")).toBe(true);
		expect(timerWanted("shell", "read")).toBe(false);
		expect(timerWanted("shell", "constructor")).toBe(false);
		expect(timerWanted("off", "bash")).toBe(false);
	});

	test("an unset or unknown stored value is all", () => {
		expect(toolTimerOf(null)).toBe("all");
		expect(toolTimerOf("")).toBe("all");
		expect(toolTimerOf("sometimes")).toBe("all");
		expect(toolTimerOf("shell")).toBe("shell");
		expect(toolTimerOf("off")).toBe("off");
	});
});

describe("what the page records as a tool runs", () => {
	const info: LiveInfo = {
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
	};
	const fold = (frames: OmpFrame[]) => frames.reduce(applyFrame, initialLive(info));

	test("a call seen from its start has an end time when it ends", () => {
		const before = Date.now();
		const live = fold([
			{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} },
			{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [] } },
		]);
		const tool = live.tools.c1;
		expect(tool.done).toBe(true);
		expect(tool.late).toBeUndefined();
		expect(tool.startedAt).toBeGreaterThanOrEqual(before);
		expect(tool.endedAt).toBeGreaterThanOrEqual(tool.startedAt);
	});

	test("a call whose start the page missed is marked, whether it first hears of it from its output or its end", () => {
		const byOutput = fold([{ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: {} }]);
		expect(byOutput.tools.c1.late).toBe(true);
		const byEnd = fold([{ type: "tool_execution_end", toolCallId: "c2", toolName: "bash", result: {} }]);
		expect(byEnd.tools.c2.late).toBe(true);
		expect(byEnd.tools.c2.endedAt).toBeDefined();
	});
});

describe("the clock time a call started (#691)", () => {
	test("is the page's own sight of its start, when it saw one", () => {
		expect(toolStartedAt({ exec: exec({ startedAt: 5_000 }), calledAt: 4_000, offsetMs: 300 })).toBe(5_000);
	});

	test("is the end of the message that made the call, on the page's clock, for a saved or late-seen call", () => {
		expect(toolStartedAt({ calledAt: 4_000, offsetMs: 300 })).toBe(3_700);
		expect(toolStartedAt({ exec: exec({ late: true }), calledAt: 4_000, offsetMs: 300 })).toBe(3_700);
	});

	test("is not known for a call still being written", () => {
		expect(toolStartedAt({})).toBeUndefined();
	});

	test("shows the time alone today and the date before it on another day", () => {
		const now = new Date(2026, 9, 27, 18, 0, 0).getTime();
		expect(fmtClock(new Date(2026, 9, 27, 14, 32, 7).getTime(), now)).toBe("14:32:07");
		expect(fmtClock(new Date(2026, 9, 26, 9, 5, 0).getTime(), now)).toBe("Oct 26 09:05:00");
		expect(fmtClock(new Date(2025, 0, 2, 23, 59, 59).getTime(), now)).toBe("Jan 2, 2025 23:59:59");
	});

	test("in Chinese the date is written the Chinese way, the time the same", () => {
		const now = new Date(2026, 9, 27, 18, 0, 0).getTime();
		useLang.setState({ lang: "zh-CN" });
		try {
			expect(fmtClock(new Date(2026, 9, 27, 14, 32, 7).getTime(), now)).toBe("14:32:07");
			expect(fmtClock(new Date(2026, 9, 26, 9, 5, 0).getTime(), now)).toBe("10月26日 09:05:00");
		} finally {
			useLang.setState({ lang: "en" });
		}
	});
});
