import { describe, expect, test } from "bun:test";
import type { OmpFrame, SessionEntry, SubagentFile, UsageTotals } from "../../shared/protocol.ts";
import { contextLevel } from "../../web/src/lib/context-usage.ts";
import { startedByMainAgent } from "../../web/src/lib/subagent-continue.ts";
import {
	type AgentRow,
	agentRows,
	childRows,
	elapsedMs,
	isRunning,
	jobRows,
	parentId,
	rowContext,
	rowSpend,
	subagentsForToolCall,
	toolCallArguments,
} from "../../web/src/lib/subagents.ts";
import type { SubagentState } from "../../web/src/store/live.ts";
import { applySubagentFrame, mergeSnapshot } from "../../web/src/store/subagents-live.ts";

/** The subagent lists: running ones first (the newest start first), the finished ones in the order they always had. */

const NOW = 1_000_000;

const usage = (n: number): UsageTotals => ({
	input: n,
	output: 2 * n,
	cacheRead: 100 * n,
	cacheWrite: 3 * n,
	totalTokens: 106 * n,
	cost: n / 1000,
	requests: 1,
});

const file = (id: string, modifiedAt: number, n = 1, startedAt = modifiedAt - 10_000): SubagentFile => ({
	id,
	file: `/s/${id}.jsonl`,
	size: 10,
	modifiedAt,
	startedAt,
	usage: usage(n),
	providers: [],
	activeMs: 0,
});

const live = (id: string, status: string, extra: Partial<SubagentState> = {}): SubagentState => ({
	id,
	status,
	updatedAt: NOW,
	...extra,
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("which subagents are running", () => {
	test("those that have not ended, however omp words it", () => {
		for (const status of ["running", "started", "pending", "unknown"]) expect(isRunning(status)).toBe(true);
		for (const status of ["completed", "done", "failed", "aborted", "error", "cancelled", "ended"])
			expect(isRunning(status)).toBe(false);
	});
});

describe("agent rows", () => {
	test("list the transcripts of a conversation that is not running, oldest modification first, all finished", () => {
		const rows = agentRows([file("B", 2000), file("A", 1000)], undefined);
		expect(ids(rows)).toEqual(["B", "A"]);
		expect(rows.every((r) => !r.running && r.status === "completed")).toBe(true);
	});

	test("put the running ones first, the newest start first, and leave the others in their order", () => {
		const rows = agentRows([file("Old1", 1000), file("Old2", 2000), file("Mid", 3000)], {
			Mid: live("Mid", "running", { startedAt: NOW - 50_000 }),
			New: live("New", "running", { startedAt: NOW - 1000 }),
			Fresh: live("Fresh", "pending", { startedAt: NOW - 20_000 }),
			Done: live("Done", "completed", { startedAt: NOW - 90_000, finishedAt: NOW - 80_000 }),
		});
		expect(ids(rows)).toEqual(["New", "Fresh", "Mid", "Old1", "Old2", "Done"]);
		expect(rows.map((r) => r.running)).toEqual([true, true, true, false, false, false]);
	});

	test("merge a transcript and the live state of the same subagent: the live one says where it stands", () => {
		const [row] = agentRows([file("Scout", 5000, 2)], {
			Scout: live("Scout", "running", { agent: "explore", startedAt: NOW - 3000, sessionFile: "/live/Scout.jsonl" }),
		});
		expect(row).toMatchObject({
			id: "Scout",
			agent: "explore",
			status: "running",
			running: true,
			file: "/live/Scout.jsonl",
			startedAt: NOW - 3000,
		});
		expect(row.stat?.usage.input).toBe(2);
	});

	test("a running subagent whose start is unknown goes after the ones whose start is known", () => {
		const rows = agentRows(undefined, {
			Unknown: live("Unknown", "running"),
			Known: live("Known", "running", { startedAt: NOW - 10 }),
		});
		expect(ids(rows)).toEqual(["Known", "Unknown"]);
	});

	test("nested ids are indented by their depth, named by their last part", () => {
		const rows = agentRows(
			[file("Features", 1000), file("Features.QuotaPill", 2000), file("Features.QuotaPill.Deep", 3000)],
			undefined,
		);
		expect(rows.map((r) => [r.name, r.depth])).toEqual([
			["Features", 0],
			["QuotaPill", 1],
			["Deep", 2],
		]);
	});

	test("have no rows without subagents", () => {
		expect(agentRows(undefined, undefined)).toEqual([]);
		expect(agentRows([], {})).toEqual([]);
	});
});

describe("elapsed time", () => {
	test("of a running subagent grows with the clock", () => {
		const [row] = agentRows(undefined, { A: live("A", "running", { startedAt: NOW - 4000 }) });
		expect(elapsedMs(row, NOW)).toBe(4000);
		expect(elapsedMs(row, NOW + 1000)).toBe(5000);
	});

	test("of a finished one is how long it ran", () => {
		const [viaFrames] = agentRows(undefined, {
			A: live("A", "completed", { startedAt: NOW - 9000, finishedAt: NOW - 3000 }),
		});
		expect(elapsedMs(viaFrames, NOW)).toBe(6000);
		const [reported] = agentRows(undefined, {
			A: live("A", "completed", { startedAt: NOW - 9000, finishedAt: NOW, progress: { id: "A", durationMs: 7000 } }),
		});
		expect(elapsedMs(reported, NOW + 100_000)).toBe(7000);
		const [fromFile] = agentRows([file("A", 20_000, 1, 12_000)], undefined);
		expect(elapsedMs(fromFile, NOW)).toBe(8000);
	});

	test("is unknown without a start", () => {
		const [row] = agentRows(undefined, { A: live("A", "running") });
		expect(elapsedMs(row, NOW)).toBeUndefined();
	});
});

describe("what a row has spent", () => {
	test("is the transcript's usage when nothing is live", () => {
		const [row] = agentRows([file("A", 1000, 3)], undefined);
		expect(rowSpend(row)).toEqual({
			parts: { input: 3, output: 6, cacheRead: 300, cacheWrite: 9, cost: 0.003 },
			pending: 0,
		});
	});

	test("is only what the frames report when there is no transcript yet", () => {
		const [row] = agentRows(undefined, {
			A: live("A", "running", { progress: { id: "A", tokens: 4000, cost: 0.25 } }),
		});
		expect(rowSpend(row)).toEqual({
			parts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.25 },
			pending: 4000,
		});
	});

	test("never falls behind the frames: a transcript read earlier is only a floor", () => {
		const [stale] = agentRows([file("A", 1000, 1)], {
			A: live("A", "running", { progress: { id: "A", tokens: 100, cost: 0.5 } }),
		});
		// The transcript has 1 + 2 + 3 = 6 billed tokens and $0.001; the frames are ahead on both.
		expect(rowSpend(stale).parts.cost).toBe(0.5);
		expect(rowSpend(stale).pending).toBe(94);
		expect(rowSpend(stale).parts.cacheRead).toBe(100);
		const [fresh] = agentRows([file("A", 1000, 40)], {
			A: live("A", "running", { progress: { id: "A", tokens: 100, cost: 0.01 } }),
		});
		// The transcript has caught up (and passed the frames): nothing is added to it.
		expect(rowSpend(fresh).parts.cost).toBe(0.04);
		expect(rowSpend(fresh).pending).toBe(0);
	});
});

describe("how full a subagent's context is", () => {
	const ctxFrame = (id: string, p: Record<string, unknown>): OmpFrame => ({
		type: "subagent_progress",
		payload: { progress: { id, status: "running", ...p } },
	});

	test("is omp's contextTokens of contextWindow from a progress frame, as a percentage", () => {
		const subs = applySubagentFrame({}, ctxFrame("Scout", { contextTokens: 41_000, contextWindow: 100_000 }), NOW);
		const [row] = agentRows(undefined, subs);
		expect(rowContext(row)).toEqual({ tokens: 41_000, contextWindow: 100_000, percent: 41 });
	});

	test("follows the latest frame, and a frame that leaves it out keeps the last one", () => {
		let subs = applySubagentFrame({}, ctxFrame("Scout", { contextTokens: 10_000, contextWindow: 200_000 }), NOW);
		subs = applySubagentFrame(subs, ctxFrame("Scout", { contextTokens: 170_000, contextWindow: 200_000 }), NOW + 1);
		expect(rowContext(agentRows(undefined, subs)[0])?.percent).toBe(85);
		subs = applySubagentFrame(subs, ctxFrame("Scout", { toolCount: 3 }), NOW + 2);
		expect(rowContext(agentRows(undefined, subs)[0])?.percent).toBe(85);
	});

	test("comes from omp's registry (get_subagents) for a tab that attached late, and stays once it has finished", () => {
		const subs = mergeSnapshot(
			{},
			[{ id: "Late", status: "completed", progress: { id: "Late", contextTokens: 50_000, contextWindow: 400_000 } }],
			NOW,
		);
		const [row] = agentRows(undefined, subs);
		expect(row.running).toBe(false);
		expect(rowContext(row)).toEqual({ tokens: 50_000, contextWindow: 400_000, percent: 12.5 });
	});

	test("is unknown, not 0%, without both figures: no frame, only a transcript, nothing measured yet, or junk", () => {
		expect(rowContext(agentRows([file("Disk", 1000)], undefined)[0])).toBeUndefined();
		expect(rowContext(agentRows(undefined, { A: live("A", "running") })[0])).toBeUndefined();
		for (const p of [
			{ contextTokens: 0, contextWindow: 200_000 },
			{ contextTokens: 5000 },
			{ contextWindow: 200_000 },
			{ contextTokens: 5000, contextWindow: 0 },
			{ contextTokens: Number.NaN, contextWindow: 200_000 },
			{ contextTokens: "5000", contextWindow: 200_000 },
		]) {
			const [row] = agentRows(undefined, { A: live("A", "running", { progress: { id: "A", ...(p as object) } }) });
			expect([p, rowContext(row)]).toEqual([p, undefined]);
		}
	});

	test("is coloured as the status line's meter: past 60% a warning, past 80% high", () => {
		expect([0.5, 41, 60, 60.1, 80, 80.1, 100, 120].map(contextLevel)).toEqual([
			"ok",
			"ok",
			"ok",
			"warn",
			"warn",
			"high",
			"high",
			"high",
		]);
	});
});

describe("jobs the agent waits on", () => {
	test("are the running subagents and the finished ones started by the same tool call, running first", () => {
		const rows = jobRows({
			A: live("A", "running", { parentToolCallId: "call_1", startedAt: NOW - 30_000 }),
			B: live("B", "running", { parentToolCallId: "call_1", startedAt: NOW - 10_000 }),
			C: live("C", "completed", { parentToolCallId: "call_1", startedAt: NOW - 40_000, finishedAt: NOW - 20_000 }),
			D: live("D", "completed", { parentToolCallId: "call_1", startedAt: NOW - 40_000, finishedAt: NOW - 5000 }),
			Earlier: live("Earlier", "completed", { parentToolCallId: "call_0", finishedAt: NOW - 100_000 }),
		});
		expect(ids(rows)).toEqual(["B", "A", "D", "C"]);
	});

	test("are none when nothing is running", () => {
		expect(jobRows({ A: live("A", "completed", { parentToolCallId: "call_1" }) })).toEqual([]);
		expect(jobRows(undefined)).toEqual([]);
	});

	test("include running subagents whose tool call is not known", () => {
		expect(ids(jobRows({ A: live("A", "running", { startedAt: 1 }), B: live("B", "completed") }))).toEqual(["A"]);
	});
});

describe("nesting", () => {
	test("a nested subagent's parent is the id without its last part", () => {
		expect(parentId("Features.QuotaPill")).toBe("Features");
		expect(parentId("A.B.C")).toBe("A.B");
		expect(parentId("Top")).toBeNull();
	});

	test("children are the rows one level below a subagent, in list order", () => {
		const rows = agentRows(
			[file("A", 1), file("A.B", 2), file("A.B.C", 3), file("A.D", 4), file("AB", 5), file("Z.A", 6)],
			undefined,
		);
		expect(ids(childRows(rows, "A"))).toEqual(["A.B", "A.D"]);
		expect(ids(childRows(rows, "A.B"))).toEqual(["A.B.C"]);
		expect(childRows(rows, "A.D")).toEqual([]);
	});

	test("a subagent is the main agent's unless the part of its id before the last dot is another subagent", () => {
		const rows = agentRows(
			[file("Features", 1), file("Features.QuotaPill", 2), file("api.v2 audit", 3), file("Top", 4)],
			undefined,
		);
		const started = (id: string) => startedByMainAgent(rows, rows.find((r) => r.id === id) as AgentRow);
		expect(started("Features")).toBe(true);
		expect(started("Top")).toBe(true);
		expect(started("Features.QuotaPill")).toBe(false);
		// A dot in a name made `row()` call this one nested (depth 1), though no subagent `api` is there to have started it.
		expect(started("api.v2 audit")).toBe(true);
	});
});

describe("the subagents of a task card", () => {
	const args = {
		tasks: [
			{ id: "Alpha", assignment: "a" },
			{ id: "Beta", assignment: "b" },
		],
	};

	test("are those that report the tool call that started them", () => {
		const rows = agentRows(undefined, {
			Alpha: live("Alpha", "running", { parentToolCallId: "call_1" }),
			Beta: live("Beta", "completed", { parentToolCallId: "call_1" }),
			Other: live("Other", "running", { parentToolCallId: "call_2" }),
		});
		expect(ids(subagentsForToolCall(rows, "call_1", undefined))).toEqual(["Alpha", "Beta"]);
		expect(ids(subagentsForToolCall(rows, "call_2", args))).toEqual(["Other"]);
	});

	test("else those the call named, when the process is gone and only transcripts are left", () => {
		const rows = agentRows([file("Alpha", 1), file("Beta", 2), file("Gamma", 3)], undefined);
		expect(ids(subagentsForToolCall(rows, "call_1", args))).toEqual(["Alpha", "Beta"]);
	});

	test("find the subagents of a call as omp writes it today: `name` and `task`, a shared `context`, or one named spawn", () => {
		const rows = agentRows([file("Alpha", 1), file("Beta", 2), file("Solo", 3), file("Gamma", 4)], undefined);
		const batch = {
			context: "Why",
			tasks: [
				{ name: "Alpha", task: "a" },
				{ name: "Beta", task: "b" },
			],
		};
		expect(ids(subagentsForToolCall(rows, "call_1", batch))).toEqual(["Alpha", "Beta"]);
		expect(ids(subagentsForToolCall(rows, "call_2", { name: "Solo", task: "s" }))).toEqual(["Solo"]);
	});

	test("in a subagent's own transcript, the call's names are under that subagent's id", () => {
		const rows = agentRows([file("Alpha", 1), file("Alpha.Beta", 2), file("Beta", 3)], undefined);
		expect(ids(subagentsForToolCall(rows, "call_1", args, "Alpha"))).toEqual(["Alpha.Beta"]);
	});

	test("match a name omp numbered because it was taken, only when the plain name is not there", () => {
		const numbered = agentRows([file("Alpha-2", 2)], undefined);
		expect(ids(subagentsForToolCall(numbered, "call_1", { tasks: [{ id: "Alpha" }] }))).toEqual(["Alpha-2"]);
		const both = agentRows([file("Alpha", 1), file("Alpha-2", 2)], undefined);
		expect(ids(subagentsForToolCall(both, "call_1", { tasks: [{ id: "Alpha" }] }))).toEqual(["Alpha"]);
	});

	test("are none for a call that names nothing the conversation has", () => {
		const rows = agentRows([file("Gamma", 3)], undefined);
		expect(subagentsForToolCall(rows, "call_1", args)).toEqual([]);
		expect(subagentsForToolCall(rows, "call_1", undefined)).toEqual([]);
		expect(subagentsForToolCall(rows, "call_1", { tasks: "nope" })).toEqual([]);
	});
});

describe("a tool call's arguments", () => {
	const turn = (id: string, content: unknown[]): SessionEntry => ({
		type: "message",
		id,
		parentId: null,
		timestamp: "t",
		message: { role: "assistant", content },
	});
	const entries = [
		turn("a1", [
			{ type: "text", text: "hi" },
			{ type: "toolCall", id: "call_1", name: "task", arguments: { n: 1 } },
		]),
		turn("a2", [{ type: "toolCall", id: "call_2", name: "bash", arguments: { n: 2 } }]),
		{ type: "compaction", id: "c1", parentId: null, timestamp: "t" },
	];

	test("are found by the id of the call, wherever it sits in the transcript", () => {
		expect(toolCallArguments(entries, "call_1")).toEqual({ n: 1 });
		expect(toolCallArguments(entries, "call_2")).toEqual({ n: 2 });
	});

	test("are undefined for a call the transcript does not have", () => {
		expect(toolCallArguments(entries, "call_9")).toBeUndefined();
		expect(toolCallArguments([], "call_1")).toBeUndefined();
	});
});

describe("the order while subagents run (#640)", () => {
	const lifecycle = (id: string, status = "started"): OmpFrame => ({
		type: "subagent_lifecycle",
		payload: { id, status },
	});
	/** A progress frame of `id`: it arrives at `at` and says how long the subagent has run. */
	const progress = (id: string, durationMs: number): OmpFrame => ({
		type: "subagent_progress",
		payload: { progress: { id, status: "running", durationMs } },
	});
	const step = (s: Record<string, SubagentState>, frames: [OmpFrame, number][]): Record<string, SubagentState> =>
		frames.reduce((acc, [f, now]) => applySubagentFrame(acc, f, now), s);

	/**
	 * A round of progress for every subagent, as omp actually sends them: each frame arrives at a moment of its own and
	 * its `durationMs` is that moment minus the true start, off by the milliseconds of omp's own rounding. The order those
	 * implied starts would sort into therefore alternates; a list ordered by them would move on every round.
	 */
	const rounds: { at: number; jitter: Record<string, number> }[] = [
		{ at: 2000, jitter: { Alpha: 10, Beta: -5, Gamma: -8 } },
		{ at: 4000, jitter: { Alpha: -8, Beta: 3, Gamma: 9 } },
		{ at: 6000, jitter: { Alpha: 6, Beta: -9, Gamma: -7 } },
		{ at: 9000, jitter: { Alpha: -6, Beta: 8, Gamma: 10 } },
	];

	/** The Agents list after each round of progress, for subagents that started at `starts`. */
	const ordersWhileRunning = (starts: Record<string, number>, names: string[]): string[][] => {
		let s = names.reduce<Record<string, SubagentState>>(
			(acc, id) => applySubagentFrame(acc, lifecycle(id), starts[id] as number),
			{},
		);
		const orders: string[][] = [];
		for (const { at, jitter } of rounds) {
			s = step(
				s,
				names.map((id, i): [OmpFrame, number] => {
					const arrived = at + i;
					return [progress(id, arrived - (starts[id] as number) + (jitter[id] as number)), arrived];
				}),
			);
			orders.push(ids(agentRows(undefined, s)));
		}
		return orders;
	};

	/**
	 * The order a list would have if each progress frame re-derived the start (`arrival - durationMs`), as this page used
	 * to: the one that moves. What the test proves the list no longer does.
	 */
	const impliedOrders = (starts: Record<string, number>, names: string[]): string[][] =>
		rounds.map(({ at, jitter }) => {
			const implied = names.map((id, i) => ({
				id,
				at: at + i - (starts[id] as number) + (jitter[id] as number),
			}));
			implied.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			return implied.map((r) => r.id);
		});

	test("progress updates do not move a row: the start is fixed the first time omp reports it", () => {
		const starts = { Alpha: 1000, Beta: 1002 };
		const names = ["Alpha", "Beta"];
		const orders = ordersWhileRunning(starts, names);
		expect(orders).toHaveLength(rounds.length);
		// The first frame of each decided the order; every later round draws the same two rows the same way, though the
		// elapsed times they report imply one order and then the other.
		for (const order of orders) expect(order).toEqual(orders[0] as string[]);
		const implied = impliedOrders(starts, names).map((o) => o.join(","));
		expect(new Set(implied).size).toBeGreaterThan(1);
	});

	test("each update of a batch of three keeps the rows where they are", () => {
		const names = ["Gamma", "Alpha", "Beta"];
		const starts = { Gamma: 1000, Alpha: 1002, Beta: 1004 };
		const orders = ordersWhileRunning(starts, names);
		expect(orders).toHaveLength(rounds.length);
		for (const order of orders) expect(order).toEqual(orders[0] as string[]);
		// No row lost or doubled by the updates.
		expect([...(orders[3] as string[])].sort()).toEqual(["Alpha", "Beta", "Gamma"]);
		// The re-derived order would have moved: that is the bug this test is for.
		expect(new Set(impliedOrders(starts, names).map((o) => o.join(","))).size).toBeGreaterThan(1);
	});

	test("rows that report the same start are ordered by id, whichever frame came first", () => {
		const rows = agentRows(undefined, {
			Zulu: live("Zulu", "running", { startedAt: NOW - 5000 }),
			Alpha: live("Alpha", "running", { startedAt: NOW - 5000 }),
			Mid: live("Mid", "running", { startedAt: NOW - 5000 }),
		});
		expect(ids(rows)).toEqual(["Alpha", "Mid", "Zulu"]);
		// omp's registry says the same start for all three, in another order: the list is the same.
		const listed = ["Zulu", "Alpha", "Mid"].map((id) => ({
			id,
			status: "running",
			progress: { id, status: "running", durationMs: 5000 },
		}));
		expect(ids(agentRows(undefined, mergeSnapshot({}, listed, NOW)))).toEqual(["Alpha", "Mid", "Zulu"]);
	});

	test("a registry poll keeps the order it had, though each poll reports another elapsed time", () => {
		const listed = (durationMs: number) => [
			{ id: "Alpha", status: "running", progress: { id: "Alpha", status: "running", durationMs } },
			{ id: "Beta", status: "running", progress: { id: "Beta", status: "running", durationMs: durationMs - 4 } },
		];
		const polls: [number, number][] = [
			[NOW, 10_000],
			[NOW + 2000, 12_003],
			[NOW + 5000, 14_995],
		];
		const orders: string[][] = [];
		let s: Record<string, SubagentState> = {};
		for (const [now, durationMs] of polls) {
			s = mergeSnapshot(s, listed(durationMs), now);
			orders.push(ids(agentRows(undefined, s)));
		}
		// Alpha reads 4 ms older every time omp is asked; that is not a reason to move it.
		for (const order of orders) expect(order).toEqual(["Beta", "Alpha"]);
	});

	test("a subagent that runs again is anchored to its new start", () => {
		let s = step({}, [
			[lifecycle("Scout"), 1000],
			[progress("Scout", 500), 1500],
		]);
		expect(s.Scout.startedAt).toBe(1000);
		s = applySubagentFrame(s, lifecycle("Scout", "completed"), 9000);
		s = applySubagentFrame(s, lifecycle("Scout"), 20_000);
		expect(s.Scout).toMatchObject({ status: "running", startedAt: 20_000 });
		s = applySubagentFrame(s, progress("Scout", 400), 20_400);
		expect(s.Scout.startedAt).toBe(20_000);
	});
});
