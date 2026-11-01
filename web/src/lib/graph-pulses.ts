import { isOverStatus } from "@shared/subagent-status.ts";
import { type AgentGraph, type GraphEdge, MESSAGE_BULGE, NODE_W } from "./agent-graph.ts";

/**
 * What moves along the agent graph's lines while live animations are on (v0.15.0, `lib/live-motion.ts`): a pulse each time
 * an agent starts another (its assignment goes down the spawn line), writes to another (along the message's line) or
 * finishes well (its result goes back up the spawn line to whoever started it). Found by comparing the graph as it was
 * drawn with the graph as it is now, so a pulse is something this page saw happen; pure, so it is tested without a page.
 */

/** Where a card is: what an edge needs of it. */
export interface Spot {
	x: number;
	y: number;
}

/** A cubic curve: its start, its two control points, its end. */
export type Curve = readonly [Spot, Spot, Spot, Spot];

/**
 * The line of an edge: from the right side of the agent on the left to the left side of the one on the right, or
 * around the right side of one column when both are in it (a message between siblings). `h` is the height of a card.
 */
export function edgeCurve(from: Spot, to: Spot, kind: GraphEdge["kind"], h: number): Curve {
	// A message between a parent and its child would lie on the line that says who started whom: it runs a little lower.
	const shift = kind === "message" ? Math.min(14, h / 4) : 0;
	const y1 = from.y + h / 2 + shift;
	const y2 = to.y + h / 2 + shift;
	if (to.x > from.x) {
		const x1 = from.x + NODE_W;
		const x2 = to.x;
		const c = (x2 - x1) / 2;
		return [
			{ x: x1, y: y1 },
			{ x: x1 + c, y: y1 },
			{ x: x2 - c, y: y2 },
			{ x: x2, y: y2 },
		];
	}
	if (to.x < from.x) {
		const x1 = from.x;
		const x2 = to.x + NODE_W;
		const c = (x1 - x2) / 2;
		return [
			{ x: x1, y: y1 },
			{ x: x1 - c, y: y1 },
			{ x: x2 + c, y: y2 },
			{ x: x2, y: y2 },
		];
	}
	const x1 = from.x + NODE_W;
	const x2 = to.x + NODE_W;
	return [
		{ x: x1, y: y1 },
		{ x: x1 + MESSAGE_BULGE, y: y1 },
		{ x: x2 + MESSAGE_BULGE, y: y2 },
		{ x: x2, y: y2 },
	];
}

/** The point of a curve at `t` (0 is its start, 1 its end). */
export function pointAt([a, b, c, d]: Curve, t: number): Spot {
	const u = 1 - t;
	const w0 = u * u * u;
	const w1 = 3 * u * u * t;
	const w2 = 3 * u * t * t;
	const w3 = t * t * t;
	return { x: w0 * a.x + w1 * b.x + w2 * c.x + w3 * d.x, y: w0 * a.y + w1 * b.y + w2 * c.y + w3 * d.y };
}

/** `n + 1` points along a curve from its start to its end (or the other way round), evenly in `t`. */
export function pointsAlong(curve: Curve, n: number, reverse = false): Spot[] {
	return Array.from({ length: n + 1 }, (_, i) => pointAt(curve, reverse ? 1 - i / n : i / n));
}

/** One thing that moves: along `edge`, from its `from` to its `to`, or back (a result going up a spawn line). */
export interface Pulse {
	edge: GraphEdge;
	reverse: boolean;
	kind: "spawn" | "message" | "result";
}

/** What of a drawn graph the next one is compared with. */
export interface PulseMarks {
	/** Each edge's count, by `edgeKey`. */
	edges: Map<string, number>;
	/** Each drawn agent's status, by id. */
	status: Map<string, string>;
}

export const edgeKey = (e: Pick<GraphEdge, "kind" | "from" | "to">): string => `${e.kind}:${e.from}:${e.to}`;

/** The most pulses one change of the graph sends: a batch of hundreds that starts at once is not hundreds of particles. */
export const MAX_PULSES = 12;

export function marksOf(graph: Pick<AgentGraph, "edges" | "nodes">): PulseMarks {
	return {
		edges: new Map(graph.edges.map((e) => [edgeKey(e), e.count])),
		status: new Map(graph.nodes.flatMap((n) => (n.row ? [[n.id, n.row.status]] : []))),
	};
}

/** A subagent's run is over and it did not fail: what it hands back is its result. */
const finishedWell = (status: string): boolean => status === "completed" || status === "done";

/**
 * What moved between the graph as it was (`prev`, null for the first one drawn: nothing) and as it is: new or busier spawn
 * and message lines, and agents that finished well since. An agent drawn inside a finished batch's card now sends its
 * result from the card.
 */
export function pulsesBetween(
	prev: PulseMarks | null,
	graph: Pick<AgentGraph, "edges" | "nodes" | "summaries">,
): Pulse[] {
	if (!prev) return [];
	const out: Pulse[] = [];
	for (const e of graph.edges) {
		if ((prev.edges.get(edgeKey(e)) ?? 0) < e.count) out.push({ edge: e, reverse: false, kind: e.kind });
	}
	const now = new Map(graph.nodes.flatMap((n) => (n.row ? [[n.id, n.row.status]] : [])));
	const spawnTo = new Map(graph.edges.filter((e) => e.kind === "spawn").map((e) => [e.to, e]));
	const sent = new Set<string>();
	for (const [id, was] of prev.status) {
		if (isOverStatus(was)) continue;
		const status = now.get(id);
		// Gone from the drawn agents: into a finished batch's card, which stands for it (a batch is a card when all of it
		// finished well), or out of the graph (a filter), which says nothing of how it ended.
		const card = status === undefined ? graph.summaries.find((s) => s.ids.includes(id))?.id : undefined;
		if (status !== undefined ? !finishedWell(status) : card === undefined) continue;
		const from = card ?? id;
		const edge = spawnTo.get(from);
		if (!edge || sent.has(from)) continue;
		sent.add(from);
		out.push({ edge, reverse: true, kind: "result" });
	}
	return out.slice(0, MAX_PULSES);
}
