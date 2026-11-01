import { describe, expect, test } from "bun:test";
import { ANIMATION_INTENSITIES, isValidPref, PREF } from "../../shared/prefs.ts";
import type { AgentGraph, GraphEdge, GraphNode, GraphSummary } from "../../web/src/lib/agent-graph.ts";
import { MESSAGE_BULGE, NODE_W } from "../../web/src/lib/agent-graph.ts";
import { edgeCurve, MAX_PULSES, marksOf, pointAt, pointsAlong, pulsesBetween } from "../../web/src/lib/graph-pulses.ts";
import {
	burstPieces,
	celebrationFor,
	endedWell,
	intensityOf,
	MOTION,
	motionLevel,
	type TurnMark,
} from "../../web/src/lib/live-motion.ts";
import type { AgentMessage } from "../../web/src/lib/messages.ts";
import type { AgentRow } from "../../web/src/lib/subagents.ts";
import type { OverlayMessage } from "../../web/src/store/live.ts";

/**
 * Live animations (v0.15.0): which ones run (off by default, the intensity chosen, none under reduced motion), when a turn
 * or a goal is worth a burst, and what moves along the agent graph's lines. The page's side is `tests/e2e/live-motion.spec.ts`.
 */

describe("the preference", () => {
	test("is off unless turned on, at normal unless another intensity was chosen", () => {
		expect(motionLevel(null, null, false)).toBeNull();
		expect(motionLevel("off", "lively", false)).toBeNull();
		expect(motionLevel("on", null, false)).toBe("normal");
		expect(motionLevel("on", "subtle", false)).toBe("subtle");
		expect(motionLevel("on", "lively", false)).toBe("lively");
		// A value from another version, or written by hand, is the default.
		expect(motionLevel("on", "wild", false)).toBe("normal");
		expect(motionLevel("yes", "lively", false)).toBeNull();
		expect(intensityOf("")).toBe("normal");
	});

	test("the system's reduced motion turns them off whatever was chosen", () => {
		for (const level of [null, ...ANIMATION_INTENSITIES]) expect(motionLevel("on", level, true)).toBeNull();
	});

	test("the server takes the values the page writes, and nothing else", () => {
		for (const v of ["on", "off"]) expect(isValidPref(PREF.animations, v)).toBe(true);
		for (const v of ANIMATION_INTENSITIES) expect(isValidPref(PREF.animationIntensity, v)).toBe(true);
		for (const v of ["", "true", "ON"]) expect(isValidPref(PREF.animations, v)).toBe(false);
		for (const v of ["", "max", "Subtle"]) expect(isValidPref(PREF.animationIntensity, v)).toBe(false);
	});

	test("each intensity moves more than the one before it", () => {
		const [subtle, normal, lively] = ANIMATION_INTENSITIES.map((l) => MOTION[l]);
		for (const [a, b] of [
			[subtle, normal],
			[normal, lively],
		]) {
			expect(b.particles).toBeGreaterThan(a.particles);
			expect(b.particleMs).toBeLessThan(a.particleMs);
			expect(b.burst).toBeGreaterThan(a.burst);
			expect(b.burstPx).toBeGreaterThan(a.burstPx);
		}
	});
});

const reply = (stopReason: string): AgentMessage => ({ role: "assistant", content: [], stopReason }) as AgentMessage;
const overlay = (m: AgentMessage): OverlayMessage => ({ messageId: "m", message: m, ended: true }) as OverlayMessage;
const ended = (m: AgentMessage, extra: Partial<Parameters<typeof endedWell>[0]> = {}) => ({
	overlay: [overlay(m)],
	entries: [],
	lastError: null,
	exited: null,
	retry: null,
	...extra,
});

describe("a turn that ended well", () => {
	test("ends with a reply that stopped by itself", () => {
		expect(endedWell(ended(reply("stop")))).toBe(true);
		for (const r of ["error", "aborted", "toolUse", "length"]) expect(endedWell(ended(reply(r))), r).toBe(false);
		expect(endedWell({ overlay: [], entries: [], lastError: null, exited: null, retry: null })).toBe(false);
	});

	test("not when omp reported an error, exited, or retries", () => {
		expect(endedWell(ended(reply("stop"), { lastError: "boom" }))).toBe(false);
		expect(endedWell(ended(reply("stop"), { exited: { code: 1 } as never }))).toBe(false);
		expect(endedWell(ended(reply("stop"), { retry: { phase: "failed", attempt: 3 } }))).toBe(false);
	});
});

describe("what is celebrated", () => {
	const mark = (m: Partial<TurnMark> = {}): TurnMark => ({
		streaming: false,
		continuing: false,
		goalId: null,
		goalStatus: null,
		well: false,
		...m,
	});

	test("a turn the page saw end well", () => {
		expect(celebrationFor(mark({ streaming: true }), mark({ well: true }))).toBe("turn");
		// Ended badly, or not ended.
		expect(celebrationFor(mark({ streaming: true }), mark({ well: false }))).toBeNull();
		expect(celebrationFor(mark({ streaming: true }), mark({ streaming: true, well: true }))).toBeNull();
		// Over before the page looked: not news.
		expect(celebrationFor(null, mark({ well: true }))).toBeNull();
		expect(celebrationFor(mark({ well: true }), mark({ well: true }))).toBeNull();
	});

	test("not a turn of a goal run that goes on; the goal when it is completed", () => {
		const active = { goalId: "g1", goalStatus: "active" };
		expect(
			celebrationFor(mark({ streaming: true, ...active }), mark({ continuing: true, well: true, ...active })),
		).toBe(null);
		expect(celebrationFor(mark(active), mark({ goalId: "g1", goalStatus: "complete" }))).toBe("goal");
		expect(celebrationFor(mark(active), mark({ goalId: "g1", goalStatus: "dropped" }))).toBeNull();
		// Another goal, already complete when it arrived: not this page's news.
		expect(celebrationFor(mark(active), mark({ goalId: "g2", goalStatus: "complete" }))).toBeNull();
		expect(
			celebrationFor(mark({ goalId: "g1", goalStatus: "complete" }), mark({ goalId: "g1", goalStatus: "complete" })),
		).toBeNull();
	});

	test("a burst is a fan over the top half, the same every time", () => {
		const pieces = burstPieces(14, 56);
		expect(pieces).toHaveLength(14);
		expect(burstPieces(14, 56)).toEqual(pieces);
		for (const p of pieces) {
			expect(p.dy).toBeLessThan(0);
			expect(Math.hypot(p.dx, p.dy)).toBeLessThanOrEqual(56 * 1.1);
		}
		expect(pieces[0].dx).toBeLessThan(0);
		expect(pieces.at(-1)?.dx).toBeGreaterThan(0);
		expect(new Set(pieces.map((p) => p.colour))).toEqual(new Set([0, 1, 2]));
	});
});

const row = (id: string, status: string): AgentRow => ({
	id,
	name: id.split(".").at(-1) ?? id,
	depth: id.split(".").length - 1,
	status,
	running: status === "running",
});
const node = (id: string, status: string | null, x = 0, y = 0): GraphNode => ({
	id,
	row: status === null ? null : row(id, status),
	x,
	y,
});
const edge = (kind: GraphEdge["kind"], from: string, to: string, count = 1): GraphEdge => ({ kind, from, to, count });
const graph = (nodes: GraphNode[], edges: GraphEdge[], summaries: GraphSummary[] = []) =>
	({ nodes, edges, summaries }) as Pick<AgentGraph, "nodes" | "edges" | "summaries">;

describe("what moves along the agent graph's lines", () => {
	const before = graph([node("", null), node("Lead", "running")], [edge("spawn", "", "Lead")]);

	test("nothing for the first graph drawn, nor for one that did not change", () => {
		expect(pulsesBetween(null, before)).toEqual([]);
		expect(pulsesBetween(marksOf(before), before)).toEqual([]);
	});

	test("an assignment down a new spawn line, and a message along its line, each time one more is written", () => {
		const after = graph(
			[node("", null), node("Lead", "running"), node("Helper", "running")],
			[edge("spawn", "", "Lead"), edge("spawn", "", "Helper"), edge("message", "Lead", "Helper")],
		);
		expect(pulsesBetween(marksOf(before), after)).toEqual([
			{ edge: edge("spawn", "", "Helper"), reverse: false, kind: "spawn" },
			{ edge: edge("message", "Lead", "Helper"), reverse: false, kind: "message" },
		]);
		const more = graph(after.nodes, [...after.edges.slice(0, 2), edge("message", "Lead", "Helper", 2)]);
		expect(pulsesBetween(marksOf(after), more)).toEqual([
			{ edge: edge("message", "Lead", "Helper", 2), reverse: false, kind: "message" },
		]);
	});

	test("a result back up the spawn line when a subagent finishes well, and none when it fails", () => {
		const done = graph([node("", null), node("Lead", "completed")], before.edges);
		expect(pulsesBetween(marksOf(before), done)).toEqual([
			{ edge: edge("spawn", "", "Lead"), reverse: true, kind: "result" },
		]);
		const failed = graph([node("", null), node("Lead", "failed")], before.edges);
		expect(pulsesBetween(marksOf(before), failed)).toEqual([]);
		// Already over: no second result.
		expect(pulsesBetween(marksOf(done), done)).toEqual([]);
	});

	test("a batch that finished as a card sends one result from the card", () => {
		const running = graph(
			[node("", null), node("A", "running"), node("B", "running")],
			[edge("spawn", "", "A"), edge("spawn", "", "B")],
		);
		const card = { id: "summary:call_1", ids: ["A", "B"] } as GraphSummary;
		const folded = graph([node("", null)], [edge("spawn", "", "summary:call_1", 2)], [card]);
		const pulses = pulsesBetween(marksOf(running), folded);
		expect(pulses.filter((p) => p.kind === "result")).toEqual([
			{ edge: edge("spawn", "", "summary:call_1", 2), reverse: true, kind: "result" },
		]);
	});

	test("a change of hundreds of agents sends a handful of pulses", () => {
		const many = Array.from({ length: 300 }, (_, i) => `S${i}`);
		const after = graph(
			[node("", null), ...many.map((id) => node(id, "running"))],
			many.map((id) => edge("spawn", "", id)),
		);
		expect(pulsesBetween(marksOf(graph([node("", null)], [])), after)).toHaveLength(MAX_PULSES);
	});

	test("a particle runs on the line the edge is drawn with, from either end", () => {
		const h = 96;
		const right = edgeCurve({ x: 0, y: 0 }, { x: 400, y: 200 }, "spawn", h);
		expect(right[0]).toEqual({ x: NODE_W, y: h / 2 });
		expect(right[3]).toEqual({ x: 400, y: 200 + h / 2 });
		// A message runs a little lower than the spawn line of the same two agents.
		expect(edgeCurve({ x: 0, y: 0 }, { x: 400, y: 200 }, "message", h)[0].y).toBe(h / 2 + 14);
		// Two agents of one column: around its right side.
		const siblings = edgeCurve({ x: 300, y: 0 }, { x: 300, y: 200 }, "message", h);
		expect(siblings[1].x).toBe(300 + NODE_W + MESSAGE_BULGE);
		const points = pointsAlong(right, 16);
		expect(points).toHaveLength(17);
		expect(points[0]).toEqual(pointAt(right, 0));
		expect(points[16]).toEqual(right[3]);
		const back = pointsAlong(right, 16, true);
		expect(back[0]).toEqual(right[3]);
		expect(back[16]).toEqual(right[0]);
	});
});
