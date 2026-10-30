import { describe, expect, test } from "bun:test";
import {
	type AgentGraph,
	ALL,
	agentGraph,
	agentIndex,
	callsFor,
	fileStartedAt,
	filterIds,
	findRows,
	focusRect,
	GRID_COLS,
	type GraphBatch,
	type GraphItem,
	type GraphNode,
	graphTotals,
	isStalled,
	MAIN,
	MINIMAP_H,
	MINIMAP_W,
	messageTarget,
	minimapSize,
	NODE_H,
	NODE_H_COMPACT,
	NODE_W,
	outcomeOf,
	recipient,
	STALL_MS,
	summaryId,
} from "../../web/src/lib/agent-graph.ts";
import { type AgentRow, ENDED } from "../../web/src/lib/subagents.ts";
import type { SubagentState, ToolExec } from "../../web/src/store/live.ts";

/**
 * The agent graph (#719, #736): where each agent is drawn, which subagents are framed as one `task` call's batch, which
 * messages become edges, and how the graph is made smaller when a conversation has hundreds of subagents: finished
 * batches as one card, filters, a grid of siblings, compact cards. Built from rows here, not from frames: this is about
 * the graph.
 */

const NOW = 1_000_000;

type RowOptions = {
	status?: string;
	batch?: string;
	startedAt?: number;
	finishedAt?: number;
	live?: Partial<SubagentState>;
};

function row(id: string, o: RowOptions = {}) {
	const parts = id.split(".");
	const status = o.status ?? "running";
	const live: SubagentState = {
		id,
		status,
		updatedAt: NOW,
		...(o.batch ? { parentToolCallId: o.batch } : {}),
		...o.live,
	};
	return {
		id,
		name: parts.at(-1) as string,
		depth: parts.length - 1,
		status,
		running: status === "running",
		live,
		startedAt: o.startedAt ?? 0,
		...(o.finishedAt === undefined ? {} : { finishedAt: o.finishedAt }),
	} satisfies AgentRow;
}

function write(id: string, path: string): ToolExec {
	return { toolCallId: id, toolName: "write", args: { path, content: "hi" }, done: true, startedAt: 0 };
}

const tools = (...list: ToolExec[]) => Object.fromEntries(list.map((t) => [t.toolCallId, t]));

function nodeOf(g: AgentGraph, id: string): GraphNode {
	const n = g.nodes.find((x) => x.id === id);
	if (!n) throw new Error(`no node ${id}`);
	return n;
}

describe("layout", () => {
	test("a child is right of its parent; a parent sits between its first and last child; nothing overlaps", () => {
		const rows = [row("A", { batch: "t1" }), row("B", { batch: "t1" }), row("A.X"), row("A.Y")];
		const g = agentGraph(rows, undefined);
		const at = (id: string) => nodeOf(g, id);
		expect(at("A").x).toBeGreaterThan(at(MAIN).x);
		expect(at("A.X").x).toBeGreaterThan(at("A").x);
		expect(at("A").y).toBe((at("A.X").y + at("A.Y").y) / 2);
		for (const a of g.nodes)
			for (const b of g.nodes) {
				if (a === b || a.x !== b.x) continue;
				expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(NODE_H);
			}
		for (const n of g.nodes) {
			expect(n.x + NODE_W).toBeLessThanOrEqual(g.width);
			expect(n.y + NODE_H).toBeLessThanOrEqual(g.height);
		}
	});

	test("a subagent whose parent is not known hangs from the main agent", () => {
		const g = agentGraph([row("Gone.Child")], undefined);
		expect(g.edges).toEqual([{ from: MAIN, to: "Gone.Child", kind: "spawn", count: 1 }]);
	});

	test("a batch frames exactly the subagents of one task call, and is kept together in the column", () => {
		const rows = [
			row("A", { batch: "t1", startedAt: 1 }),
			row("C", { batch: "t2", startedAt: 2 }),
			row("B", { batch: "t1", startedAt: 3 }),
			row("Solo", { batch: "t3", startedAt: 4 }),
		];
		const g = agentGraph(rows, undefined);
		expect(g.batches.map((b) => [b.id, b.ids])).toEqual([["t1", ["A", "B"]]]);
		const y = (id: string) => nodeOf(g, id).y;
		// B started after C but belongs with A.
		expect(y("A")).toBeLessThan(y("B"));
		expect(y("B")).toBeLessThan(y("C"));
		const frame = g.batches[0] as GraphBatch;
		expect(y("C")).toBeGreaterThan(frame.y + frame.h);
	});

	test("a frame knows the room right of it, up to the next column's cards; in the last column it has no end", () => {
		const rows = [
			row("A", { batch: "t1", startedAt: 1 }),
			row("B", { batch: "t1", startedAt: 2 }),
			row("A.Kid", { batch: "t2", startedAt: 3 }),
			row("A.Mate", { batch: "t2", startedAt: 4 }),
		];
		const g = agentGraph(rows, undefined);
		const frame = (id: string) => g.batches.find((b) => b.id === id) as GraphBatch;
		const t1 = frame("t1");
		expect(t1.room).toBeGreaterThan(0);
		expect(t1.room).toBe(nodeOf(g, "A.Kid").x - (t1.x + t1.w));
		expect(frame("t2").room).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("messages", () => {
	test("the target of a write is the agent named in the path", () => {
		expect(messageTarget("agent://Alpha")).toBe("Alpha");
		expect(messageTarget("agent://Parent.Child/notes")).toBe("Parent.Child");
		expect(messageTarget("/tmp/agent://x")).toBeNull();
		expect(messageTarget(undefined)).toBeNull();
	});

	test("a bare name is the sender's child, then its sibling, then the one subagent of that name", () => {
		const index = agentIndex([row("P"), row("P.Kid"), row("P.Mate"), row("Q"), row("Q.Kid"), row("Q.Only")]);
		expect(recipient("Kid", "P", index)).toBe("P.Kid");
		expect(recipient("Kid", "P.Mate", index)).toBe("P.Kid");
		expect(recipient("Only", "P.Mate", index)).toBe("Q.Only");
		// Two `Kid`s and the main agent is the sibling of neither: no edge rather than a wrong one.
		expect(recipient("Kid", MAIN, index)).toBeNull();
		expect(recipient("Q.Kid", "P", index)).toBe("Q.Kid");
		// Every agent is not one of them: it is a mark on the sender.
		expect(recipient(ALL, "P", index)).toBeNull();
	});

	test("a message to every agent is one mark on its sender, or on the card that hides it, and no edge", () => {
		const all = (id: string) => write(id, "agent://all");
		const rows = [
			row("A", { live: { tools: tools(all("a1"), all("a2")) } }),
			row("B"),
			finished("F0", "t1", { live: { tools: tools(all("f0")) } }),
			finished("F1", "t1", { live: { tools: tools(all("f1")) } }),
		];
		const g = agentGraph(rows, tools(all("m1")));
		expect(g.edges.filter((e) => e.kind === "message")).toEqual([]);
		expect([...g.broadcasts]).toEqual([
			[MAIN, 1],
			["A", 2],
			[summaryId("t1"), 2],
		]);
		// A sender the filter dropped is not drawn, nor its mark.
		const kept = agentGraph(rows, tools(all("m1")), { keep: new Set(["B"]) });
		expect([...kept.broadcasts]).toEqual([[MAIN, 1]]);
	});

	test("writes become message edges, counted per pair, from the main agent and from subagents", () => {
		const rows = [row("A", { live: { tools: tools(write("w1", "agent://B"), write("w2", "agent://B")) } }), row("B")];
		const g = agentGraph(rows, tools(write("m1", "agent://A"), write("m2", "/tmp/file")));
		const said = g.edges.filter((e) => e.kind === "message");
		expect(said).toEqual([
			{ from: MAIN, to: "A", kind: "message", count: 1 },
			{ from: "A", to: "B", kind: "message", count: 2 },
		]);
	});
});

describe("stalled and totals", () => {
	test("stalled only while running, not waiting for a retry, not paused, after two minutes of silence", () => {
		const quiet = row("A", { live: { updatedAt: NOW - STALL_MS - 1 } });
		expect(isStalled(quiet, NOW, false)).toBe(true);
		expect(isStalled(row("A", { live: { updatedAt: NOW - STALL_MS + 1 } }), NOW, false)).toBe(false);
		expect(isStalled(quiet, NOW, true)).toBe(false);
		expect(isStalled(row("A", { status: "completed", live: { updatedAt: 0 } }), NOW, false)).toBe(false);
		const waiting = row("A", {
			live: {
				updatedAt: 0,
				retry: {
					phase: "waiting",
					attempt: 1,
					maxAttempts: 3,
					delayMs: 1000,
					startedAt: 0,
					usageLimit: true,
					resumed: false,
				},
			},
		});
		expect(isStalled(waiting, NOW, false)).toBe(false);
	});

	test("totals count running, all, stalled, tokens and cost", () => {
		const rows = [
			row("A", { live: { updatedAt: 0, progress: { id: "A", tokens: 100, cost: 0.5 } } }),
			row("B", { status: "completed", live: { progress: { id: "B", tokens: 50, cost: 0.25 } } }),
		];
		expect(graphTotals(rows, NOW)).toEqual({
			running: 1,
			total: 2,
			stalled: 1,
			tokens: 150,
			cost: 0.75,
		});
	});
});

/** A subagent of the task call `call` whose run is over. */
const finished = (id: string, call: string, o: RowOptions = {}) => row(id, { status: "completed", batch: call, ...o });
/** `n` finished subagents of one call: `F0`… */
const batchOf = (n: number, call = "t1", o: RowOptions = {}) =>
	Array.from({ length: n }, (_, i) => finished(`F${i}`, call, { startedAt: 100 + i, ...o }));

const overlap = (a: GraphNode, b: GraphNode, h: number) =>
	a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + h && b.y < a.y + h;

describe("outcome", () => {
	test("running until over; then completed, ended without a word of how, or failed", () => {
		expect(outcomeOf(row("A"))).toBe("running");
		// Between runs (omp's `idle`) is not over.
		expect(outcomeOf(row("A", { status: "idle" }))).toBe("running");
		expect(outcomeOf(row("A", { status: "completed" }))).toBe("done");
		expect(outcomeOf(row("A", { status: "done" }))).toBe("done");
		expect(outcomeOf(row("A", { status: ENDED }))).toBe("ended");
		for (const status of ["failed", "error", "aborted", "cancelled"])
			expect(outcomeOf(row("A", { status }))).toBe("failed");
	});
});

describe("finished batches", () => {
	test("a batch that finished is one card in place of its subagents, and the graph is shorter", () => {
		const rows = batchOf(6);
		const g = agentGraph(rows, undefined);
		const opened = agentGraph(rows, undefined, { open: new Set(["t1"]) });
		expect(g.nodes.map((n) => n.id)).toEqual([MAIN]);
		expect(g.batches).toEqual([]);
		expect(g.summaries.map((s) => [s.id, s.batch, s.ids, s.count])).toEqual([
			[summaryId("t1"), "t1", rows.map((r) => r.id), 6],
		]);
		const card = g.summaries[0] as AgentGraph["summaries"][number];
		// Right of its parent, level with it (the parent sits midway between its subagents, here one card).
		expect(card.x).toBeGreaterThan(nodeOf(g, MAIN).x);
		expect(card.y).toBe(nodeOf(g, MAIN).y);
		expect(g.height).toBeLessThan(opened.height);
		// Opened, the subagents are drawn one by one, in a frame that can be closed again.
		expect(opened.summaries).toEqual([]);
		expect(opened.nodes).toHaveLength(7);
		expect(opened.batches.map((b) => [b.id, b.collapsible])).toEqual([["t1", true]]);
	});

	test("cards, batch cards and frames are listed in the order they are drawn, top to bottom (the order Tab goes)", () => {
		const rows = [
			row("Solo", { startedAt: 1 }),
			...batchOf(2, "t1"),
			finished("G0", "t2", { startedAt: 200 }),
			finished("G1", "t2", { startedAt: 201 }),
			row("Last", { startedAt: 300 }),
		];
		const g = agentGraph(rows, undefined, { open: new Set(["t2"]) });
		const name = (item: GraphItem) =>
			item.kind === "node" ? item.node.id : item.kind === "summary" ? item.card.id : `frame ${item.batch.id}`;
		expect(g.items.map(name)).toEqual([MAIN, "Solo", summaryId("t1"), "frame t2", "G0", "G1", "Last"]);
		// Below the main agent (midway between its subagents), each one is lower on the page than the one before it.
		const tops = g.items
			.slice(1)
			.map((item) => (item.kind === "node" ? item.node.y : item.kind === "summary" ? item.card.y : item.batch.y));
		expect(tops).toEqual([...tops].sort((a, b) => a - b));
	});

	test("the card counts those hidden (the ones they started too), how they ended, what they used and how long it took", () => {
		const spent = (id: string, tokens: number, cost: number) => ({ progress: { id, tokens, cost } });
		const rows = [
			finished("A", "t1", { startedAt: 1_000, finishedAt: 5_000, live: spent("A", 100, 0.5) }),
			row("B", { status: ENDED, batch: "t1", startedAt: 2_000, finishedAt: 9_000, live: spent("B", 50, 0.25) }),
			finished("A.Kid", "t2", { startedAt: 1_500, finishedAt: 4_000, live: spent("A.Kid", 10, 0.01) }),
		];
		const [card] = agentGraph(rows, undefined).summaries;
		expect(card).toMatchObject({
			ids: ["A", "B"],
			count: 3,
			done: 2,
			ended: 1,
			tokens: 160,
			startedAt: 1_000,
			endedAt: 9_000,
		});
		expect(card?.cost).toBeCloseTo(0.76);
	});

	test("a batch stays open while a subagent in it goes on, waits, failed, or has one below it that does", () => {
		const calls = (extra: AgentRow[]) => agentGraph([...batchOf(3), ...extra], undefined);
		const cases: [string, AgentRow[]][] = [
			["running", [row("F3", { batch: "t1" })]],
			["waiting between runs", [row("F3", { batch: "t1", status: "idle" })]],
			["failed", [row("F3", { batch: "t1", status: "failed" })]],
			["stopped", [row("F3", { batch: "t1", status: "cancelled" })]],
			["a running one below a finished one", [row("F0.Kid")]],
			["a failed one below a finished one", [row("F0.Kid", { status: "error" })]],
		];
		for (const [name, extra] of cases) {
			const g = calls(extra);
			expect(g.summaries, name).toEqual([]);
			expect(
				g.batches.map((b) => [b.id, b.collapsible]),
				name,
			).toEqual([["t1", false]]);
			// The one that failed is on the page, not inside a card.
			expect(g.nodes.length, name).toBeGreaterThanOrEqual(5);
		}
	});

	test("a call's one subagent is no batch and is never a card", () => {
		const g = agentGraph([finished("F0", "t1")], undefined);
		expect(g.summaries).toEqual([]);
		expect(g.nodes.map((n) => n.id)).toEqual([MAIN, "F0"]);
	});

	test("the lines of the subagents a card hides end at the card, once, with their counts added", () => {
		const card = summaryId("t1");
		const rows = [
			row("Lead", { live: { tools: tools(write("w1", "agent://F1"), write("w2", "agent://F2")) } }),
			finished("F0", "t1"),
			finished("F1", "t1", { live: { tools: tools(write("a", "agent://Lead"), write("b", "agent://F2")) } }),
			finished("F2", "t1"),
		];
		const g = agentGraph(rows, tools(write("m1", "agent://F0")));
		expect(g.edges.filter((e) => e.kind === "spawn")).toEqual([
			{ from: MAIN, to: "Lead", kind: "spawn", count: 1 },
			{ from: MAIN, to: card, kind: "spawn", count: 3 },
		]);
		// F1 writing to F2 is inside the card: no line. Lead writing to two of them is one line, counted twice.
		expect(g.edges.filter((e) => e.kind === "message")).toEqual([
			{ from: MAIN, to: card, kind: "message", count: 1 },
			{ from: "Lead", to: card, kind: "message", count: 2 },
			{ from: card, to: "Lead", kind: "message", count: 1 },
		]);
		// Opened, the lines are the subagents' own again.
		const opened = agentGraph(rows, undefined, { open: new Set(["t1"]) });
		expect(opened.edges.filter((e) => e.kind === "message").map((e) => `${e.from}>${e.to}`)).toEqual([
			"Lead>F1",
			"Lead>F2",
			"F1>Lead",
			"F1>F2",
		]);
	});
});

describe("filters", () => {
	const rows = [
		finished("P", "t0"),
		row("P.Bad", { status: "failed" }),
		row("P.Fine", { status: "completed" }),
		row("Q", { status: "completed" }),
		row("R", { status: "failed" }),
	];

	test("no filter lets everything through", () => {
		expect(filterIds(rows, { status: "all", time: "all" }, NOW)).toBeNull();
	});

	test("a filter keeps what matches and who started it, and the graph draws just those", () => {
		const keep = filterIds(rows, { status: "failed", time: "all" }, NOW);
		expect([...(keep as Set<string>)].sort()).toEqual(["P", "P.Bad", "R"]);
		const g = agentGraph(rows, undefined, { keep });
		expect(g.nodes.map((n) => n.id)).toEqual([MAIN, "P", "P.Bad", "R"]);
		expect(g.edges).toEqual([
			{ from: MAIN, to: "P", kind: "spawn", count: 1 },
			{ from: "P", to: "P.Bad", kind: "spawn", count: 1 },
			{ from: MAIN, to: "R", kind: "spawn", count: 1 },
		]);
		expect(g.height).toBeLessThan(agentGraph(rows, undefined).height);
	});

	test("running keeps what has not ended, between runs too", () => {
		const some = [
			row("A"),
			row("B", { status: "idle" }),
			row("C", { status: "completed" }),
			row("A.Done", { status: "completed" }),
		];
		expect([...(filterIds(some, { status: "running", time: "all" }, NOW) as Set<string>)].sort()).toEqual(["A", "B"]);
	});

	test("a time filter goes by when the subagent started; one whose start is unknown is in none", () => {
		const T = new Date(2026, 5, 15, 14, 0, 0).getTime();
		const at = (id: string, startedAt: number | undefined) => ({ ...row(id), startedAt });
		const timed = [
			at("Recent", T - 30 * 60_000),
			at("Earlier", T - 3 * 3_600_000),
			at("Yesterday", new Date(2026, 5, 14, 23, 0, 0).getTime()),
			at("Unknown", undefined),
		];
		const ids = (time: "hour" | "today") => [...(filterIds(timed, { status: "all", time }, T) as Set<string>)].sort();
		expect(ids("hour")).toEqual(["Recent"]);
		expect(ids("today")).toEqual(["Earlier", "Recent"]);
	});

	test("a batch the filter leaves nothing of is gone, card and frame", () => {
		const mixed = [...batchOf(3), row("Bad", { status: "failed" })];
		const g = agentGraph(mixed, undefined, {
			keep: filterIds(mixed, { status: "failed", time: "all" }, NOW),
		});
		expect(g.nodes.map((n) => n.id)).toEqual([MAIN, "Bad"]);
		expect(g.summaries).toEqual([]);
		expect(g.batches).toEqual([]);
	});

	test("messages to a subagent the filter dropped are not drawn", () => {
		const talk = [row("A", { status: "failed", live: { tools: tools(write("w", "agent://B")) } }), row("B")];
		const g = agentGraph(talk, undefined, {
			keep: filterIds(talk, { status: "failed", time: "all" }, NOW),
		});
		expect(g.edges.filter((e) => e.kind === "message")).toEqual([]);
	});
});

describe("search", () => {
	const rows = [
		finished("Alpha", "t1", { startedAt: 1 }),
		finished("Beta", "t1", { startedAt: 2 }),
		finished("Beta.Kid", "t2", { startedAt: 3 }),
		row("Gamma", { startedAt: 4 }),
	];

	test("finds subagents by any part of their id, whatever the case, in the order the graph draws them", () => {
		expect(findRows(rows, null, "BETA")).toEqual(["Beta", "Beta.Kid"]);
		expect(findRows(rows, null, "   ")).toEqual([]);
		expect(findRows(rows, new Set(["Alpha", "Gamma"]), "a")).toEqual(["Alpha", "Gamma"]);
	});

	test("a match inside a card opens the batch that holds it, and those of the agents above it", () => {
		expect(agentGraph(rows, undefined).nodes.map((n) => n.id)).not.toContain("Beta.Kid");
		const open = callsFor(rows, ["Beta.Kid"]);
		expect([...open].sort()).toEqual(["t1", "t2"]);
		expect(agentGraph(rows, undefined, { open }).nodes.map((n) => n.id)).toContain("Beta.Kid");
	});
});

describe("grid", () => {
	const siblings = (n: number, batch?: string) =>
		Array.from({ length: n }, (_, i) => row(`S${String(i).padStart(2, "0")}`, { batch, startedAt: i }));

	test("the subagents of one call are side by side, at most GRID_COLS to a row, and do not overlap", () => {
		const rows = siblings(12, "t1");
		const column = agentGraph(rows, undefined);
		const g = agentGraph(rows, undefined, { grid: true });
		const kids = g.nodes.filter((n) => n.row);
		expect(new Set(kids.map((n) => n.x)).size).toBe(GRID_COLS);
		expect(new Set(kids.map((n) => n.y)).size).toBe(Math.ceil(12 / GRID_COLS));
		expect(g.height).toBeLessThan(column.height);
		expect(g.width).toBeGreaterThan(column.width);
		for (const a of g.nodes) for (const b of g.nodes) if (a !== b) expect(overlap(a, b, g.nodeH)).toBe(false);
		for (const n of g.nodes) {
			expect(n.x + NODE_W).toBeLessThanOrEqual(g.width);
			expect(n.y + g.nodeH).toBeLessThanOrEqual(g.height);
		}
		// The frame holds them all, the parent is level with the middle of them, and every one is still started by it.
		const frame = g.batches[0] as GraphBatch;
		for (const n of kids) {
			expect(n.x).toBeGreaterThanOrEqual(frame.x);
			expect(n.x + NODE_W).toBeLessThanOrEqual(frame.x + frame.w);
			expect(n.y).toBeGreaterThanOrEqual(frame.y);
			expect(n.y + g.nodeH).toBeLessThanOrEqual(frame.y + frame.h);
		}
		const ys = kids.map((n) => n.y);
		expect(nodeOf(g, MAIN).y).toBe((Math.min(...ys) + Math.max(...ys)) / 2);
		expect(g.edges.filter((e) => e.kind === "spawn" && e.from === MAIN)).toHaveLength(12);
	});

	test("a few siblings take as many columns as there are, and ones no call started are one grid too", () => {
		expect(new Set(agentGraph(siblings(3, "t1"), undefined, { grid: true }).nodes.map((n) => n.x)).size).toBe(4);
		const loose = agentGraph(siblings(7), undefined, { grid: true });
		expect(new Set(loose.nodes.filter((n) => n.row).map((n) => n.x)).size).toBe(GRID_COLS);
		expect(loose.height).toBeLessThan(agentGraph(siblings(7), undefined).height);
	});

	test("a subagent with some of its own keeps its place in the column, and what it started is right of the grid", () => {
		const rows = [...siblings(5, "t1"), row("S04.Kid")];
		const g = agentGraph(rows, undefined, { grid: true });
		const cells = ["S00", "S01", "S02", "S03"].map((id) => nodeOf(g, id));
		expect(new Set(cells.map((n) => n.x)).size).toBe(4);
		expect(nodeOf(g, "S04").x).toBe(Math.min(...cells.map((n) => n.x)));
		expect(nodeOf(g, "S04.Kid").x).toBeGreaterThanOrEqual(Math.max(...cells.map((n) => n.x)) + NODE_W);
		for (const a of g.nodes) for (const b of g.nodes) if (a !== b) expect(overlap(a, b, g.nodeH)).toBe(false);
	});

	test("a grid of finished batches is still one card each", () => {
		const rows = [...batchOf(4, "t1"), ...batchOf(4, "t2").map((r) => ({ ...r, id: `G${r.id}`, name: `G${r.name}` }))];
		const g = agentGraph(rows, undefined, { grid: true });
		expect(g.summaries.map((s) => s.batch)).toEqual(["t1", "t2"]);
	});
});

describe("compact", () => {
	test("cards are as high as a compact card, so the graph is shorter and the rows are closer", () => {
		const rows = [row("A", { batch: "t1" }), row("B", { batch: "t1" }), row("C")];
		const full = agentGraph(rows, undefined);
		const small = agentGraph(rows, undefined, { compact: true });
		expect(full.nodeH).toBe(NODE_H);
		expect(small.nodeH).toBe(NODE_H_COMPACT);
		expect(small.height).toBeLessThan(full.height);
		const apart = (g: AgentGraph) => nodeOf(g, "B").y - nodeOf(g, "A").y;
		// Rows are closer by more than the cards are shorter: the gaps between them are tighter too.
		expect(apart(small)).toBeGreaterThan(NODE_H_COMPACT);
		expect(apart(full) - apart(small)).toBeGreaterThan(NODE_H - NODE_H_COMPACT);
		for (const a of small.nodes)
			for (const b of small.nodes) if (a !== b) expect(overlap(a, b, NODE_H_COMPACT)).toBe(false);
		for (const n of small.nodes) expect(n.y + NODE_H_COMPACT).toBeLessThanOrEqual(small.height);
		const frame = small.batches[0] as GraphBatch;
		const reach = nodeOf(small, "A").y - frame.y;
		expect(reach).toBeGreaterThan(0);
		expect(frame.h).toBe(apart(small) + NODE_H_COMPACT + 2 * reach);
	});

	test("the frames of batches of two agents next to each other in a column do not touch, full or compact", () => {
		const rows = [
			row("P1"),
			row("P2"),
			row("P1.A", { batch: "t1" }),
			row("P1.B", { batch: "t1" }),
			row("P2.A", { batch: "t2" }),
			row("P2.B", { batch: "t2" }),
		];
		for (const compact of [false, true]) {
			const g = agentGraph(rows, undefined, { compact });
			const [one, two] = g.batches as [GraphBatch, GraphBatch];
			expect(two.y, `compact ${compact}`).toBeGreaterThan(one.y + one.h);
		}
	});
});

describe("focus", () => {
	test("frames the main agent and what is not over, and the whole graph when nothing runs", () => {
		const rows = [finished("F0", "a"), finished("F1", "b"), row("F1.Live"), finished("F2", "c")];
		const g = agentGraph(rows, undefined);
		const rect = focusRect(g);
		const box = (id: string) => nodeOf(g, id);
		for (const id of [MAIN, "F1.Live"]) {
			expect(rect.x).toBeLessThanOrEqual(box(id).x);
			expect(rect.y).toBeLessThanOrEqual(box(id).y);
			expect(rect.x + rect.w).toBeGreaterThanOrEqual(box(id).x + NODE_W);
			expect(rect.y + rect.h).toBeGreaterThanOrEqual(box(id).y + NODE_H);
		}
		expect(rect.h).toBeLessThan(g.height);
		expect(box("F0").y + NODE_H).toBeLessThanOrEqual(rect.y);
		const idle = agentGraph([finished("F0", "a"), finished("F1", "b")], undefined);
		expect(focusRect(idle)).toEqual({ x: 0, y: 0, w: idle.width, h: idle.height });
	});
});

describe("minimap size", () => {
	/** The minimap with its padding and border (5 pixels of each side). */
	const framed = (s: { w: number; h: number }) => ({ w: s.w + 10, h: s.h + 10 });

	test("is 180 by 120 where the canvas has room for it", () => {
		expect(minimapSize({ w: 1000, h: 600 })).toEqual({ w: MINIMAP_W, h: MINIMAP_H });
		expect(minimapSize({ w: 1920, h: 1000 })).toEqual({ w: MINIMAP_W, h: MINIMAP_H });
	});

	test("covers at most a third of a small canvas, in the same proportions (a phone: about 390 by 270)", () => {
		const s = minimapSize({ w: 390, h: 270 });
		expect(s.w / s.h).toBeCloseTo(MINIMAP_W / MINIMAP_H, 5);
		expect(framed(s).w).toBeLessThanOrEqual(390 * 0.3 + 1e-9);
		expect(framed(s).h).toBeLessThanOrEqual(270 * 0.3 + 1e-9);
		expect(s.w).toBeLessThan(MINIMAP_W);
		// It is the height that limits it here: the canvas is wide.
		expect(framed(s).h).toBeCloseTo(270 * 0.3, 5);
	});

	test("is limited by the narrower side, and never gets to be a speck", () => {
		const tall = minimapSize({ w: 240, h: 900 });
		expect(framed(tall).w).toBeCloseTo(240 * 0.3, 5);
		const speck = minimapSize({ w: 60, h: 40 });
		expect(speck.w).toBeGreaterThanOrEqual(40);
		expect(minimapSize({ w: 0, h: 0 }).w).toBe(speck.w);
	});
});

describe("a conversation's start", () => {
	test("is read from the file's name, in UTC, however long the path in front of it is", () => {
		const at = Date.UTC(2026, 9, 29, 6, 30, 45, 917);
		expect(fileStartedAt("2026-10-29T06-30-45-917Z_01a1b2c3.jsonl")).toBe(at);
		expect(fileStartedAt("/Users/dev/.omp/agent/sessions/--proj--/2026-10-29T06-30-45-917Z_01a1b2c3.jsonl")).toBe(at);
	});

	test("is nothing for a name that does not start with a time, or a time that is not one", () => {
		expect(fileStartedAt("/tmp/notes.jsonl")).toBeNull();
		expect(fileStartedAt("2026-13-45T25-61-61-000Z_x.jsonl")).toBeNull();
	});
});
