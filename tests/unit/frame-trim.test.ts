import { expect, test } from "bun:test";
import { dropTrace, trimLines } from "../../server/omp/frame-trim.ts";

/** omp 18.22 repeats a bash script's whole execution trace in every progress frame (#337). */

const trace = Array.from({ length: 50 }, (_, i) => ({ k: "simple", argv: ["echo", `line ${i}`], ns: i }));
const update = (extra: Record<string, unknown> = {}) => ({
	type: "tool_execution_update",
	toolCallId: "call_1",
	partialResult: {
		content: [{ type: "text", text: "line 1\n" }],
		details: { trace, ...extra } as Record<string, unknown>,
	},
});
const line = (frame: unknown) => `${JSON.stringify(frame)}\n`;

test("a progress frame loses its trace and keeps the rest of its details", () => {
	const frame = update({ meta: { truncated: false } });
	expect(dropTrace(frame)).toBe(true);
	expect(frame.partialResult.details).toEqual({ meta: { truncated: false } });
	expect(frame.partialResult.content).toEqual([{ type: "text", text: "line 1\n" }]);
});

test("a frame without a trace, or one that is not a progress frame, is left as it is", () => {
	const plain = { type: "tool_execution_update", partialResult: { details: { progress: [] } } };
	expect(dropTrace(plain)).toBe(false);
	// The finished call keeps its trace: it is in the saved result, once.
	const end = { type: "tool_execution_end", result: { details: { trace } } };
	expect(dropTrace(end)).toBe(false);
	expect((end.result.details as { trace?: unknown }).trace).toBe(trace);
	expect(dropTrace({ type: "tool_execution_update", partialResult: "text" })).toBe(false);
});

test("the relay keeps lines without the trace, the others byte for byte, in order", () => {
	const keep = line({ type: "message_update", delta: "hello" });
	const junk = '{"type":"tool_execution_update","trace":not json}\n';
	const lines = [Buffer.from(keep), Buffer.from(line(update())), Buffer.from(junk), Buffer.from(keep)];
	const out = trimLines(lines).map((b) => b.toString("utf8"));
	const joined = out.join("");
	const rows = joined.split("\n").filter(Boolean);
	expect(rows).toHaveLength(4);
	expect(rows[0]).toBe(keep.trim());
	expect(JSON.parse(rows[1] as string).partialResult.details).toEqual({});
	expect(rows[1]?.length).toBeLessThan(line(update()).length / 10);
	// A line that only looks like one with a trace is passed on whole.
	expect(rows[2]).toBe(junk.trim());
	expect(rows[3]).toBe(keep.trim());
});

test("a batch with nothing to trim is handed back untouched, and a line split between two buffers is still one line", () => {
	const batch = [Buffer.from(line({ type: "message_update", delta: "x" }))];
	expect(trimLines(batch)).toBe(batch);
	const whole = line(update());
	const cut = whole.indexOf("tool_execution_up") + 4;
	const split = trimLines([Buffer.from(whole.slice(0, cut)), Buffer.from(whole.slice(cut))]);
	expect(split.map((b) => b.toString("utf8")).join("")).not.toContain('"trace"');
});
