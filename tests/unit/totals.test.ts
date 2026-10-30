import { describe, expect, test } from "bun:test";
import type { SessionEntry, SubagentFile, UsageTotals } from "../../shared/protocol.ts";
import { agentRows } from "../../web/src/lib/subagents.ts";
import { advisorUsageOf, conversationTotals, sumEntries } from "../../web/src/lib/totals.ts";
import type { SubagentState } from "../../web/src/store/live.ts";

/** A conversation's header total: its own requests plus its subagents', with each side's share. */

const usage = (n: number): UsageTotals => ({
	input: n,
	output: 2 * n,
	cacheRead: 100 * n,
	cacheWrite: 3 * n,
	totalTokens: 106 * n,
	cost: n / 1000,
	requests: 1,
});
const file = (id: string, n: number, activeMs = 0): SubagentFile => ({
	id,
	file: `/s/${id}.jsonl`,
	size: 1,
	modifiedAt: 1000,
	startedAt: 0,
	usage: usage(n),
	providers: [],
	activeMs,
});
const live = (id: string, status: string, extra: Partial<SubagentState> = {}): SubagentState => ({
	id,
	status,
	updatedAt: 1,
	...extra,
});

const main = { input: 10, output: 20, cacheRead: 1000, cacheWrite: 30, cost: 0.01 };

describe("entries", () => {
	const message = (id: string, role: string, u?: Record<string, unknown>): SessionEntry => ({
		type: "message",
		id,
		parentId: null,
		timestamp: "t",
		message: { role, usage: u },
	});

	test("are summed over assistant messages and `model_usage` records", () => {
		const entries: SessionEntry[] = [
			message("u1", "user"),
			message("a1", "assistant", { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } }),
			message("a2", "assistant", { input: 10, cost: { total: 0.25 } }),
			{ type: "model_usage", id: "m1", parentId: null, timestamp: "t", usage: { output: 7, cost: { total: 0.125 } } },
			message("a3", "assistant"),
		];
		expect(sumEntries(entries)).toEqual({ input: 11, output: 9, cacheRead: 3, cacheWrite: 4, cost: 0.875 });
	});

	test("are zero when empty", () => {
		expect(sumEntries([])).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
	});
});

describe("totals", () => {
	test("add the subagents' transcripts to the conversation's own and keep each side's share", () => {
		const t = conversationTotals(main, agentRows([file("A", 2), file("A.B", 1)], undefined));
		expect(t.main).toEqual({ tokens: 1060, cost: 0.01 });
		expect(t.subagents).toMatchObject({ tokens: 318, count: 2, running: 0 });
		expect(t.subagents.cost).toBeCloseTo(0.003, 9);
		expect(t.total.tokens).toBe(1060 + 318);
		expect(t.total.cost).toBeCloseTo(0.013, 9);
		expect(t.usage).toMatchObject({ input: 13, output: 26, cacheRead: 1300, cacheWrite: 39, pending: 0 });
		expect(t.usage.cost).toBeCloseTo(0.013, 9);
		expect(t.mainUsage).toEqual(main);
		expect(t.usage.split).toEqual({ main: t.main, subagents: t.subagents, advisor: t.advisor });
	});

	test("add up how long every subagent worked, nested ones included (#692)", () => {
		const rows = agentRows([file("A", 2, 60_000), file("A.B", 1, 15_000)], { C: live("C", "running") });
		expect(conversationTotals(main, rows).subagentActiveMs).toBe(75_000);
	});

	test("are the conversation's alone, without a split, when it has no subagents", () => {
		const t = conversationTotals(main, []);
		expect(t.subagents).toEqual({ tokens: 0, cost: 0, count: 0, running: 0 });
		expect(t.total).toEqual(t.main);
		expect(t.usage).toEqual({ ...main, pending: 0, split: null });
	});

	test("count a running subagent from its frames while it has no transcript yet", () => {
		const t = conversationTotals(
			main,
			agentRows(undefined, { A: live("A", "running", { progress: { id: "A", tokens: 4000, cost: 0.25 } }) }),
		);
		expect(t.subagents).toEqual({ tokens: 4000, cost: 0.25, count: 1, running: 1 });
		expect(t.total.tokens).toBe(1060 + 4000);
		expect(t.total.cost).toBeCloseTo(0.26, 9);
		expect(t.usage.pending).toBe(4000);
		expect(t.usage.input).toBe(main.input);
	});

	test("count a subagent once when both its transcript and its frames are known", () => {
		const rows = agentRows([file("A", 1), file("B", 1)], {
			A: live("A", "running", { progress: { id: "A", tokens: 6, cost: 0.001 } }),
			B: live("B", "completed", { progress: { id: "B", tokens: 6, cost: 0.001 } }),
		});
		const t = conversationTotals(main, rows);
		expect(t.subagents.count).toBe(2);
		expect(t.subagents.running).toBe(1);
		expect(t.subagents.tokens).toBe(212);
		expect(t.subagents.cost).toBeCloseTo(0.002, 9);
	});
});

describe("totals with an advisor", () => {
	// What the session list says its advisors spent: omp keeps it in `__advisor.jsonl`, in no frame and no transcript.
	const advisor = advisorUsageOf(usage(5));

	test("add the advisor's requests to the conversation's own and its subagents', and keep its share apart", () => {
		const t = conversationTotals(main, agentRows([file("A", 2)], undefined), advisor);
		expect(t.main).toEqual({ tokens: 1060, cost: 0.01 });
		expect(t.subagents).toMatchObject({ tokens: 212, count: 1 });
		expect(t.advisor).toEqual({ tokens: 530, cost: 0.005, requests: 1 });
		expect(t.total.tokens).toBe(1060 + 212 + 530);
		expect(t.total.cost).toBeCloseTo(0.017, 9);
		expect(t.usage).toMatchObject({
			input: 10 + 2 + 5,
			output: 20 + 4 + 10,
			cacheRead: 1000 + 200 + 500,
			cacheWrite: 30 + 6 + 15,
		});
		expect(t.usage.cost).toBeCloseTo(0.017, 9);
		expect(t.usage.split).toEqual({ main: t.main, subagents: t.subagents, advisor: t.advisor });
		expect(t.advisorUsage).toEqual({ input: 5, output: 10, cacheRead: 500, cacheWrite: 15, cost: 0.005 });
	});

	test("make a conversation with an advisor and no subagents a split one", () => {
		const t = conversationTotals(main, [], advisor);
		expect(t.subagents).toEqual({ tokens: 0, cost: 0, count: 0, running: 0 });
		expect(t.total.cost).toBeCloseTo(0.015, 9);
		expect(t.usage.split).toEqual({ main: t.main, subagents: t.subagents, advisor: t.advisor });
	});

	test("change nothing for a conversation without one", () => {
		const t = conversationTotals(main, [], advisorUsageOf(undefined));
		expect(t.advisor).toEqual({ tokens: 0, cost: 0, requests: 0 });
		expect(t.usage).toEqual({ ...main, pending: 0, split: null });
		expect(conversationTotals(main, [])).toEqual(t);
	});

	test("go on counting while the conversation runs: its frames move the main share, the list moves the advisor's", () => {
		const rows = agentRows(undefined, undefined);
		const at = (own: typeof main, listed: UsageTotals | undefined) =>
			conversationTotals(own, rows, advisorUsageOf(listed));
		// A request arrives in a frame: only the conversation's own share grows.
		const grown = { ...main, input: main.input + 3, cost: main.cost + 0.002 };
		expect(at(grown, usage(5)).total.cost).toBeCloseTo(0.012 + 0.005, 9);
		// The advisor's file is read again and the list says so: the advisor's share grows by what it spent, once.
		const before = at(grown, usage(5));
		const after = at(grown, { ...usage(5), input: 5 + 8, cost: 0.005 + 0.008, requests: 2 });
		expect(after.advisor.requests).toBe(2);
		expect(after.total.cost).toBeCloseTo(before.total.cost + 0.008, 9);
		expect(after.usage.input).toBe(before.usage.input + 8);
		expect(after.main).toEqual(before.main);
	});

	test("read a list entry without advisor figures, or with ones that are no numbers, as nothing spent", () => {
		expect(advisorUsageOf(undefined)).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			requests: 0,
		});
		const odd = {
			input: "a",
			output: null,
			cacheRead: {},
			cacheWrite: [],
			cost: Number.NaN,
			requests: "2",
		} as unknown as UsageTotals;
		expect(advisorUsageOf(odd)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 });
	});
});
