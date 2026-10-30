import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OmpFrame, SessionEntry } from "../../shared/protocol.ts";
import type { AgentMessage } from "../../web/src/lib/messages.ts";
import { activeMs, savedTurn, stepStats, turnStats, withUnsaved } from "../../web/src/lib/turn-stats.ts";
import type { OverlayMessage } from "../../web/src/store/live.ts";

/**
 * The per-turn stats line: what omp records on an assistant message (usage, `timestamp`, `completedAt`,
 * `duration`, `ttft`), added up over the requests of one agent turn. The messages below are the two requests
 * of a recorded run (a bash tool step, then the answer): see tests/fixtures/delta-frames.jsonl.
 */

const frames: OmpFrame[] = readFileSync(join(import.meta.dir, "../fixtures/delta-frames.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l));
const recorded = frames
	.filter((f) => f.type === "message_end" && (f.message as AgentMessage).role === "assistant")
	.map((f) => f.message as AgentMessage);
const [toolStep, answerStep] = recorded;

const entry = (id: string, parentId: string | null, message: Record<string, unknown>, timestamp: string) =>
	({ type: "message", id, parentId, timestamp, message }) as unknown as SessionEntry;
const iso = (ms: number) => new Date(ms).toISOString();

describe("one request", () => {
	test("its figures are what omp recorded on the message", () => {
		const s = stepStats(toolStep);
		expect(s).not.toBeNull();
		// Tokens by kind, as omp recorded them (the TUI's "in" adds the cache writes to the input).
		expect(s?.input).toBe(4);
		expect(s?.cacheWrite).toBe(367);
		expect(s?.output).toBe(78);
		expect(s?.cacheRead).toBe(12020);
		expect(s?.startedAt).toBe(1792183743711);
		expect(s?.finishedAt).toBe(1792183745762);
		expect(s?.durationMs).toBeCloseTo(2028.125, 2);
		expect(s?.ttftMs).toBeCloseTo(1361.871, 2);
		expect(s?.tokensPerSecond).toBeCloseTo((78 / 2028.125) * 1000, 1);
		expect(s?.cost).toBeCloseTo(0.000233, 9);
		expect(s?.model).toBe("claude-haiku-5-5");
	});

	test("a message with no usage has no figures", () => {
		expect(stepStats({ role: "assistant", content: [] })).toBeNull();
	});

	test("without `completedAt` the finish time is the saved entry's timestamp", () => {
		const { completedAt: _drop, ...older } = toolStep;
		expect(stepStats(older, iso(1792183745000))?.finishedAt).toBe(1792183745000);
		expect(stepStats(older)?.finishedAt).toBeUndefined();
	});

	test("figures omp did not record are absent, not zero", () => {
		const s = stepStats({
			role: "assistant",
			content: [],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } },
		});
		expect(s).toMatchObject({ input: 10, output: 5, cacheRead: 0, cost: 0.1 });
		expect(s?.startedAt).toBeUndefined();
		expect(s?.finishedAt).toBeUndefined();
		expect(s?.durationMs).toBeUndefined();
		expect(s?.ttftMs).toBeUndefined();
		expect(s?.tokensPerSecond).toBeUndefined();
	});

	test("a request of 100 ms or less, or with no output, has no speed", () => {
		const base = { role: "assistant", content: [], timestamp: 1000, completedAt: 1080 };
		const usage = (output: number) => ({ input: 1, output, cacheRead: 0, cacheWrite: 0 });
		expect(stepStats({ ...base, usage: usage(40), duration: 100 })?.tokensPerSecond).toBeUndefined();
		expect(stepStats({ ...base, usage: usage(0), duration: 2000 })?.tokensPerSecond).toBeUndefined();
		expect(stepStats({ ...base, usage: usage(40), duration: 101 })?.tokensPerSecond).toBeCloseTo(396, 0);
	});
});

describe("one turn", () => {
	const steps = recorded.map((m) => stepStats(m)).filter((s) => s !== null);

	test("a turn of a single request reports that request's figures", () => {
		const one = steps[0] ? turnStats([steps[0]]) : null;
		expect(one).toMatchObject({ requests: 1, input: 4, cacheWrite: 367, output: 78, cacheRead: 12020 });
		expect(one?.finishedAt).toBe(1792183745762);
		expect(one?.elapsedMs).toBe(1792183745762 - 1792183743711);
		expect(one?.ttftMs).toBeCloseTo(1361.871, 2);
		expect(one?.tokensPerSecond).toBeCloseTo((78 / 2028.125) * 1000, 1);
	});

	test("requests add up; the turn started with the first and ended with the last", () => {
		expect(recorded).toHaveLength(2);
		const t = turnStats(steps);
		expect(t).not.toBeNull();
		expect(t?.requests).toBe(2);
		expect(t?.input).toBe(4 + 2);
		expect(t?.cacheWrite).toBe(367 + 91);
		expect(t?.output).toBe(78 + 40);
		expect(t?.cacheRead).toBe(12020 + 12387);
		expect(t?.cost).toBeCloseTo(0.000233 + 0.00016227, 9);
		expect(t?.models).toEqual(["claude-haiku-5-5"]);
		expect(t?.finishedAt).toBe(answerStep.completedAt);
		expect(t?.elapsedMs).toBe((answerStep.completedAt as number) - (toolStep.timestamp as number));
		// The turn's time to first token is the first request's: how long until the model began answering.
		expect(t?.ttftMs).toBeCloseTo(toolStep.ttft as number, 6);
		// Speed is all the output over all the time the model spent writing it.
		const spent = (toolStep.duration as number) + (answerStep.duration as number);
		expect(t?.tokensPerSecond).toBeCloseTo(((78 + 40) / spent) * 1000, 6);
		expect(t?.steps).toHaveLength(2);
	});

	test("a request too short to time does not drag the speed", () => {
		const fast = stepStats({
			role: "assistant",
			content: [],
			usage: { input: 1, output: 500, cacheRead: 0, cacheWrite: 0 },
			timestamp: 10,
			completedAt: 60,
			duration: 50,
		});
		const t = turnStats([...(fast ? [fast] : []), ...steps]);
		const spent = (toolStep.duration as number) + (answerStep.duration as number);
		expect(t?.tokensPerSecond).toBeCloseTo(((78 + 40) / spent) * 1000, 6);
		expect(t?.output).toBe(78 + 40 + 500);
	});

	test("the turn lasted as long as the clocks say; when they disagree, it has no duration", () => {
		const reversed = stepStats({
			role: "assistant",
			content: [],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			timestamp: 5000,
			completedAt: 4000,
		});
		expect(turnStats(reversed ? [reversed] : [])?.elapsedMs).toBeUndefined();
		expect(turnStats([])).toBeNull();
	});

	test("the models of a turn are listed once each, in order", () => {
		const mk = (model: string) =>
			stepStats({ role: "assistant", content: [], model, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
		const list = [mk("a"), mk("b"), mk("a")].filter((s) => s !== null);
		expect(turnStats(list)?.models).toEqual(["a", "b"]);
	});
});

describe("the turn in flight", () => {
	const user = (id: string, parentId: string | null, ts: number, extra: Record<string, unknown> = {}) =>
		entry(id, parentId, { role: "user", content: "go", attribution: "user", timestamp: ts, ...extra }, iso(ts));
	const assistant = (id: string, parentId: string, m: AgentMessage) =>
		entry(id, parentId, m as unknown as Record<string, unknown>, iso(m.completedAt ?? m.timestamp ?? 0));
	const msg = (over: Partial<AgentMessage>): AgentMessage => ({
		...toolStep,
		...over,
	});

	test("it is every request since the last prompt on the branch the process is on", () => {
		const earlier = msg({ timestamp: 1000, completedAt: 1500 });
		const entries = [
			user("u0", null, 900),
			assistant("a0", "u0", earlier),
			user("u1", "a0", 1792183743681),
			assistant("a1", "u1", toolStep),
			entry("r1", "a1", { role: "toolResult", toolCallId: "t", toolName: "bash", content: [] }, iso(1792183745803)),
			// A branch abandoned earlier hangs off the same prompt.
			assistant("x1", "u1", msg({ timestamp: 1792183740000, completedAt: 1792183741000 })),
		];
		const turn = savedTurn(entries, "r1");
		expect(turn.steps).toHaveLength(1);
		expect(turn.steps[0].finishedAt).toBe(toolStep.completedAt);
		expect(turn.promptAt).toBe(1792183743681);
	});

	test("a request that has ended but is not saved yet counts; one still streaming, or already saved, does not", () => {
		const entries = [user("u1", null, 1792183743681), assistant("a1", "u1", toolStep)];
		const { steps: saved, promptAt } = savedTurn(entries, "a1");
		const overlay: OverlayMessage[] = [
			// Already in the entries: the same request, not a second one.
			{ messageId: "m2", message: toolStep, ended: true },
			{ messageId: "m3", message: answerStep, ended: true },
			{ messageId: "m4", message: msg({ timestamp: 1792183760000 }), ended: false },
		];
		expect(withUnsaved(saved, overlay, promptAt).map((s) => s.finishedAt)).toEqual([
			toolStep.completedAt,
			answerStep.completedAt,
		]);
		// With nothing to add, the saved list itself comes back: whatever memoized on it need not run again.
		expect(withUnsaved(saved, [overlay[0], overlay[2]], promptAt)).toBe(saved);
	});

	test("a request from before the prompt is an earlier turn's, not this one's", () => {
		const earlier: OverlayMessage = {
			messageId: "m1",
			message: msg({ timestamp: 1792183000000, completedAt: 1792183001000 }),
			ended: true,
		};
		const unsaved: OverlayMessage = { messageId: "m3", message: answerStep, ended: true };
		expect(withUnsaved([], [earlier, unsaved], 1792183743681).map((s) => s.finishedAt)).toEqual([
			answerStep.completedAt,
		]);
		// Before the prompt is saved there is no bound to apply.
		expect(withUnsaved([], [earlier], undefined)).toHaveLength(1);
	});

	test("with no leaf given it follows the last entry; a conversation with no prompt has no start", () => {
		const entries = [assistant("a1", "x", toolStep)];
		expect(savedTurn(entries, null).steps).toHaveLength(1);
		expect(savedTurn(entries, null).promptAt).toBeUndefined();
		expect(savedTurn([], null)).toEqual({ steps: [], promptAt: undefined });
	});

	test("an agent's own reminder to itself does not start a new turn", () => {
		const entries = [
			user("u1", null, 1792183743681),
			assistant("a1", "u1", toolStep),
			user("n1", "a1", 1792183745900, { attribution: "agent" }),
			assistant("a2", "n1", answerStep),
		];
		expect(savedTurn(entries, "a2").steps).toHaveLength(2);
	});
});

describe("time the agent has worked", () => {
	const t0 = Date.UTC(2026, 0, 5, 10, 0, 0);
	const user = (id: string, ts: number, extra: Record<string, unknown> = {}) =>
		entry(id, null, { role: "user", content: "go", attribution: "user", timestamp: ts, ...extra }, iso(ts));
	const reply = (id: string, ts: number) => entry(id, null, { role: "assistant", content: [] }, iso(ts));

	test("is the span from each prompt to the last thing its turn wrote, idle time between turns left out", () => {
		const entries = [
			user("u1", t0),
			reply("a1", t0 + 20_000),
			reply("a2", t0 + 60_000),
			user("u2", t0 + 3_600_000),
			reply("a3", t0 + 3_600_000 + 30_000),
		];
		expect(activeMs(entries)).toBe(90_000);
		expect(activeMs([])).toBe(0);
	});

	test("an agent's own reminder keeps the turn going; a command the user ran does not extend it", () => {
		const entries = [
			user("u1", t0),
			reply("a1", t0 + 10_000),
			user("n1", t0 + 12_000, { attribution: "agent" }),
			reply("a2", t0 + 20_000),
			entry("b1", null, { role: "bashExecution", command: "sleep 600" }, iso(t0 + 620_000)),
		];
		expect(activeMs(entries)).toBe(20_000);
	});
});
