import type { ToolExec } from "../store/live.ts";
import { type AgentRow, ENDED, isOver, parentId, rowTotals } from "./subagents.ts";

/**
 * The agent graph of one conversation (#719): the main agent and its subagents laid out left to right by who started
 * whom, the subagents one `task` call started framed as a batch, and the messages agents wrote to each other. Pure, so
 * the layout and the edges can be tested without a page.
 *
 * A conversation may hold hundreds of subagents (#736), so the graph can be made smaller: a batch whose subagents all
 * finished is one summary card, a filter keeps what matters (and who started it), siblings can be laid out in a grid,
 * and cards can shrink to a name and a dot.
 */

/** The main agent's node: no subagent has an empty id. */
export const MAIN = "";
export const NODE_W = 232;
export const NODE_H = 96;
/** A compact card, what a card shrinks to in an overview: a status dot and the name. */
export const NODE_H_COMPACT = 28;
const COL_GAP = 72;
/**
 * How far apart cards and the frames around batches sit, by card size. `row`, between two cards of a column, is more than
 * two frames' reach (batches of two parents that end up next to each other do not touch); `batch` is added between two
 * batches of one parent. Compact cards pack closer, so that more of a graph fits the window.
 */
const SPACING = {
	full: { node: NODE_H, row: 18, batch: 22, frame: 8 },
	compact: { node: NODE_H_COMPACT, row: 10, batch: 12, frame: 4 },
} as const;
const PAD = 24;
/** How far right of its column a message between two agents of that column curves (siblings writing to each other). */
export const MESSAGE_BULGE = 48;
/** A running subagent that has sent no frame for this long is drawn as stalled (as omp-console does). */
export const STALL_MS = 120_000;
/** Most columns of a grid of siblings, and the gap between two of its columns. */
export const GRID_COLS = 5;
const GRID_GAP = 32;
const HOUR_MS = 3_600_000;

export interface GraphNode {
	id: string;
	/** Null for the main agent. */
	row: AgentRow | null;
	x: number;
	y: number;
}

/** Subagents started by one `task` call, framed together. */
export interface GraphBatch {
	/** The `task` call's id. */
	id: string;
	ids: string[];
	x: number;
	y: number;
	w: number;
	h: number;
	/** Every subagent of it, and every one they started, has finished without failing: it may be drawn as one card. */
	collapsible: boolean;
	/**
	 * The free width right of the frame, up to the next column's cards: where its Collapse control is drawn. Infinite in the
	 * last column, where the canvas grows to hold it.
	 */
	room: number;
}

/**
 * A finished batch drawn as one card in place of its subagents (and those they started). Edges that ended at one of them
 * end at the card (`id`).
 */
export interface GraphSummary {
	/** The card's node id, as an edge names it (`summaryId`). */
	id: string;
	/** The `task` call's id. */
	batch: string;
	/** The subagents the call started. */
	ids: string[];
	/** Every agent the card stands for: those and the ones they started. */
	count: number;
	done: number;
	/** Over, and it is not known how: this page saw them run and omp stopped listing them (`ENDED`). */
	ended: number;
	tokens: number;
	cost: number;
	/** The first start and the last end among them, on this browser's clock; absent when no frame or transcript said. */
	startedAt?: number;
	endedAt?: number;
	x: number;
	y: number;
}

export interface GraphEdge {
	from: string;
	to: string;
	kind: "spawn" | "message";
	/** How many messages went this way; for a spawn, how many subagents it started (more than one at a summary card). */
	count: number;
}

export interface GraphTotals {
	running: number;
	total: number;
	stalled: number;
	tokens: number;
	cost: number;
}

/** What the graph draws that can be pressed: an agent's card, a finished batch's card, a batch's frame (its Collapse). */
export type GraphItem =
	| { kind: "node"; node: GraphNode }
	| { kind: "summary"; card: GraphSummary }
	| { kind: "batch"; batch: GraphBatch };

export interface AgentGraph {
	nodes: GraphNode[];
	summaries: GraphSummary[];
	/**
	 * The cards and the frames of `nodes`, `summaries` and `batches` in the order they are drawn from top to bottom: an agent
	 * before its subagents, a frame before the subagents in it. The order Tab goes through them.
	 */
	items: GraphItem[];
	batches: GraphBatch[];
	edges: GraphEdge[];
	/**
	 * The messages each drawn agent or card wrote to every agent (`agent://all`), by its id: one mark on the sender, not an
	 * edge to each of hundreds of subagents.
	 */
	broadcasts: ReadonlyMap<string, number>;
	width: number;
	height: number;
	/** The height of a card in this layout: `NODE_H`, or `NODE_H_COMPACT` in a compact one. */
	nodeH: number;
}

export type StatusFilter = "all" | "running" | "failed";
export type TimeFilter = "all" | "hour" | "today";
export interface GraphFilter {
	status: StatusFilter;
	time: TimeFilter;
}
export const NO_FILTER: GraphFilter = { status: "all", time: "all" };

/** How the graph is drawn: what it leaves out and how close it packs what it keeps. */
export interface GraphView {
	/** The `task` calls whose finished subagents are drawn one by one; every other finished batch is one card. */
	open?: ReadonlySet<string>;
	/** The subagents to draw (`filterIds`, which includes their ancestors); null: all. The main agent is always drawn. */
	keep?: ReadonlySet<string> | null;
	/** Cards of `NODE_H_COMPACT` instead of `NODE_H`. */
	compact?: boolean;
	/** The subagents of one agent without subagents of their own side by side, `GRID_COLS` to a row, not one below another. */
	grid?: boolean;
}

/** The node id of the card that stands for the finished batch of the `task` call `call`. */
export const summaryId = (call: string): string => `batch:${call}`;

/** How a subagent's run stands: not over, completed, over without anyone knowing how, or failed or stopped (omp's words). */
export type Outcome = "running" | "done" | "ended" | "failed";

export function outcomeOf(row: AgentRow): Outcome {
	if (row.running) return "running";
	if (row.status === "completed" || row.status === "done") return "done";
	if (row.status === ENDED) return "ended";
	return isOver(row.status) ? "failed" : "running";
}

/**
 * A running subagent that has said nothing for `STALL_MS`. One that waits for a retry (a usage limit is hours) is waiting,
 * not stalled, and nothing moves in a paused conversation.
 */
export function isStalled(row: AgentRow, now: number, paused: boolean): boolean {
	if (!row.running || paused || !row.live || row.live.retry) return false;
	return now - row.live.updatedAt > STALL_MS;
}

/** The agent a `write` to `path` is for, as written (`agent://Name`, `agent://Parent.Child/…`), or null. */
export function messageTarget(path: unknown): string | null {
	if (typeof path !== "string" || !path.startsWith("agent://")) return null;
	const name = path.slice("agent://".length).split(/[/:?#]/, 1)[0] ?? "";
	return name || null;
}

/** The target of a message to every other agent (`agent://all`). */
export const ALL = "all";

/** The subagents by id and by bare name, made once for every message `recipients` looks up. */
export interface AgentIndex {
	ids: ReadonlySet<string>;
	byName: ReadonlyMap<string, readonly string[]>;
}

export function agentIndex(rows: readonly AgentRow[]): AgentIndex {
	const ids = new Set<string>();
	const byName = new Map<string, string[]>();
	for (const r of rows) {
		ids.add(r.id);
		const named = byName.get(r.name);
		if (named) named.push(r.id);
		else byName.set(r.name, [r.id]);
	}
	return { ids, byName };
}

/**
 * The subagent a message from `sender` to `target` reaches. An agent names another by its id or by its bare name: a
 * name is first the sender's own child's, then its sibling's (the usual case: one of a batch writes to another), then the
 * one subagent of that name; a name two subagents share elsewhere reaches neither. `ALL` is no one subagent: it is drawn
 * as one mark on the sender (`AgentGraph.broadcasts`).
 */
export function recipient(target: string, sender: string, index: AgentIndex): string | null {
	const { ids, byName } = index;
	if (target === ALL) return null;
	if (ids.has(target)) return target;
	if (sender !== MAIN && ids.has(`${sender}.${target}`)) return `${sender}.${target}`;
	const parent = sender === MAIN ? null : parentId(sender);
	if (parent && ids.has(`${parent}.${target}`)) return `${parent}.${target}`;
	const named = byName.get(target);
	return named?.length === 1 ? (named[0] as string) : null;
}

/**
 * The `write agent://…` calls among `tools`, as edges from `sender`, counted per recipient, and the ones to every agent
 * counted in `broadcasts`.
 */
function messages(
	sender: string,
	tools: Record<string, ToolExec> | undefined,
	index: AgentIndex,
	into: Map<string, GraphEdge>,
	broadcasts: Map<string, number>,
): void {
	for (const tool of Object.values(tools ?? {})) {
		if (tool.toolName !== "write") continue;
		const args = tool.args && typeof tool.args === "object" ? (tool.args as Record<string, unknown>) : {};
		const target = messageTarget(args.path);
		if (!target) continue;
		if (target === ALL) {
			broadcasts.set(sender, (broadcasts.get(sender) ?? 0) + 1);
			continue;
		}
		const to = recipient(target, sender, index);
		if (to === null || to === sender) continue;
		const key = `${sender}\u0000${to}`;
		const edge = into.get(key);
		if (edge) edge.count++;
		else into.set(key, { from: sender, to, kind: "message", count: 1 });
	}
}

/** The batch a row belongs to: its `task` call, or its own when the call is not known. */
const batchOf = (r: AgentRow): string => r.live?.parentToolCallId ?? `\u0000${r.id}`;

/** The order of one agent's children: by when they started, then each batch kept together where its first one started. */
function ordered(children: AgentRow[]): AgentRow[] {
	const byStart = [...children].sort(
		(a, b) =>
			(a.startedAt ?? Number.POSITIVE_INFINITY) - (b.startedAt ?? Number.POSITIVE_INFINITY) ||
			(a.live?.index ?? 0) - (b.live?.index ?? 0) ||
			a.id.localeCompare(b.id),
	);
	const groups = new Map<string, AgentRow[]>();
	for (const r of byStart) {
		const g = groups.get(batchOf(r));
		if (g) g.push(r);
		else groups.set(batchOf(r), [r]);
	}
	return [...groups.values()].flat();
}

/** Who started whom: a subagent whose parent is not known (its transcript is gone) hangs from the main agent. */
function family(rows: readonly AgentRow[]): (id: string) => string {
	const ids = new Set(rows.map((r) => r.id));
	return (id) => {
		const p = parentId(id);
		return p !== null && ids.has(p) ? p : MAIN;
	};
}

/** The subagents of each agent (the main agent's under `MAIN`), among those `keep`s. */
function childrenOf(
	rows: readonly AgentRow[],
	parentOf: (id: string) => string,
	keep: ReadonlySet<string> | null,
): Map<string, AgentRow[]> {
	const children = new Map<string, AgentRow[]>();
	for (const r of rows) {
		if (keep && !keep.has(r.id)) continue;
		const p = parentOf(r.id);
		const list = children.get(p);
		if (list) list.push(r);
		else children.set(p, [r]);
	}
	return children;
}

/**
 * The subagents a filter lets through, and who started them (the lines of the graph must still run from the main agent),
 * or null when it lets everything through. A subagent whose start is not known is in no time range.
 */
export function filterIds(rows: readonly AgentRow[], filter: GraphFilter, now: number): Set<string> | null {
	if (filter.status === "all" && filter.time === "all") return null;
	const parentOf = family(rows);
	let since = Number.NEGATIVE_INFINITY;
	if (filter.time === "hour") since = now - HOUR_MS;
	else if (filter.time === "today") since = new Date(now).setHours(0, 0, 0, 0);
	const keep = new Set<string>();
	for (const r of rows) {
		if (filter.status !== "all" && outcomeOf(r) !== filter.status) continue;
		if (since > Number.NEGATIVE_INFINITY && (r.startedAt === undefined || r.startedAt < since)) continue;
		// Up to the first one already kept: its own ancestors were kept with it.
		for (let id = r.id; id !== MAIN && !keep.has(id); id = parentOf(id)) keep.add(id);
	}
	return keep;
}

/** The subagents of `keep` (all, when null) whose id has `query` in it, in the order the graph draws them from top to bottom. */
export function findRows(rows: readonly AgentRow[], keep: ReadonlySet<string> | null, query: string): string[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const children = childrenOf(rows, family(rows), keep);
	const found: string[] = [];
	const walk = (id: string) => {
		for (const r of ordered(children.get(id) ?? [])) {
			if (r.id.toLowerCase().includes(q)) found.push(r.id);
			walk(r.id);
		}
	};
	walk(MAIN);
	return found;
}

/**
 * The `task` calls whose finished batch hides one of `ids`, if it is a card: the call of each of them and of every agent
 * above it (a card hides what its subagents started too). Open these and all of `ids` are drawn.
 */
export function callsFor(rows: readonly AgentRow[], ids: readonly string[]): Set<string> {
	const byId = new Map(rows.map((r) => [r.id, r]));
	const parentOf = family(rows);
	const calls = new Set<string>();
	for (const first of ids) {
		for (let id = first; id !== MAIN; id = parentOf(id)) {
			const call = byId.get(id)?.live?.parentToolCallId;
			if (call) calls.add(call);
		}
	}
	return calls;
}

export function graphTotals(rows: readonly AgentRow[], now: number, paused = false): GraphTotals {
	const totals: GraphTotals = { running: 0, total: rows.length, stalled: 0, tokens: 0, cost: 0 };
	for (const r of rows) {
		if (r.running) totals.running++;
		if (isStalled(r, now, paused)) totals.stalled++;
		const { tokens, cost } = rowTotals(r);
		totals.tokens += tokens;
		totals.cost += cost;
	}
	return totals;
}

/**
 * When a conversation began, from its file's name (omp names it `2026-10-29T06-30-45-917Z_<id>.jsonl`, the time in UTC with
 * dashes where a clock has colons), or null for a name that does not start so. The list names a conversation that has no
 * title yet by this, since its id says nothing to the person.
 */
export function fileStartedAt(file: string): number | null {
	const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:_|\.|$)/.exec(file.split("/").pop() ?? "");
	if (!m) return null;
	const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
	return Number.isNaN(at) ? null : at;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * What a view that follows the activity frames: the main agent and every subagent that is not over, with a margin. The
 * whole graph when nothing runs: there is nothing to follow.
 */
export function focusRect(graph: AgentGraph): Rect {
	const active = graph.nodes.filter((n) => !n.row || n.row.running);
	if (active.length < 2) return { x: 0, y: 0, w: graph.width, h: graph.height };
	const left = Math.max(0, Math.min(...active.map((n) => n.x)) - PAD);
	const top = Math.max(0, Math.min(...active.map((n) => n.y)) - PAD);
	const right = Math.min(graph.width, Math.max(...active.map((n) => n.x)) + NODE_W + PAD);
	const bottom = Math.min(graph.height, Math.max(...active.map((n) => n.y)) + graph.nodeH + PAD);
	return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The drawing area of a minimap that has room, in pixels. */
export const MINIMAP_W = 180;
export const MINIMAP_H = 120;
/** The most of the canvas's width and of its height a minimap and its frame may cover. */
const MINIMAP_SHARE = 0.3;
/** What the minimap's frame adds around its drawing area (a pixel of border and 4 of padding, on each side). */
const MINIMAP_FRAME = 10;
/** The smallest drawing area: below it the marks and the view's outline are not told apart. */
const MINIMAP_MIN_W = 56;

/**
 * The drawing area of the minimap for a canvas of this size: `MINIMAP_W` by `MINIMAP_H`, or on a small canvas (a phone,
 * a graph beside a detail) smaller, in the same proportions, so that the minimap with its frame covers at most
 * `MINIMAP_SHARE` of the canvas's width and of its height and the graph is still to be seen around it.
 */
export function minimapSize(canvas: { w: number; h: number }): { w: number; h: number } {
	const room = (side: number) => side * MINIMAP_SHARE - MINIMAP_FRAME;
	const w = Math.max(MINIMAP_MIN_W, Math.min(MINIMAP_W, room(canvas.w), (room(canvas.h) * MINIMAP_W) / MINIMAP_H));
	return { w, h: (w * MINIMAP_H) / MINIMAP_W };
}

/** A run of one agent's subagents that are laid out together: the subagents of one call, or the ones no call frames. */
interface Unit {
	/** The `task` call, when the run is a batch (two or more subagents of one call). */
	call: string | null;
	rows: AgentRow[];
}

/**
 * The graph of a conversation's subagents. `mainTools` are the main agent's tool calls the page holds (for its messages);
 * a subagent's are in its row. The clock is not an input: the layout does not change from one second to the next, and
 * whether a running subagent is stalled (`isStalled`) is for the page to draw.
 */
export function agentGraph(
	rows: readonly AgentRow[],
	mainTools: Record<string, ToolExec> | undefined,
	view: GraphView = {},
): AgentGraph {
	const { open, keep = null, compact = false, grid = false } = view;
	const { node: nodeH, row: rowGap, batch: batchGap, frame: framePad } = SPACING[compact ? "compact" : "full"];
	const parentOf = family(rows);
	const children = childrenOf(rows, parentOf, keep);

	// A batch is a card while everything in it, and everything those subagents started, is over and none failed.
	const finished = new Map<string, boolean>();
	const settled = (r: AgentRow): boolean => {
		let done = finished.get(r.id);
		if (done === undefined) {
			const outcome = outcomeOf(r);
			done = (outcome === "done" || outcome === "ended") && (children.get(r.id) ?? []).every(settled);
			finished.set(r.id, done);
		}
		return done;
	};

	/** One agent's subagents in runs: each batch is one; in a grid the ones no batch frames are one run, not one each. */
	const unitsOf = (kids: AgentRow[]): Unit[] => {
		const groups: { key: string; rows: AgentRow[] }[] = [];
		for (const r of ordered(kids)) {
			const key = batchOf(r);
			const last = groups.at(-1);
			if (last?.key === key) last.rows.push(r);
			else groups.push({ key, rows: [r] });
		}
		const units: Unit[] = [];
		for (const g of groups) {
			// One subagent of a call is not a batch to point out.
			const call = g.rows.length > 1 ? g.key : null;
			const last = units.at(-1);
			if (grid && call === null && last && last.call === null) last.rows.push(...g.rows);
			else units.push({ call, rows: g.rows });
		}
		return units;
	};

	const nodes: GraphNode[] = [];
	const summaries: GraphSummary[] = [];
	const items: GraphItem[] = [];
	/** The batches drawn in full, for their frames (placed once their subagents are). */
	const framed: { batch: GraphBatch; rows: AgentRow[] }[] = [];
	/** The card that stands for each subagent a card hides. */
	const hiddenBy = new Map<string, string>();
	/** Where each card sits: the column of its depth, and its place in the grid of that column. */
	const seat = new Map<string, { depth: number; sub: number }>();
	/** How many grid columns the widest grid of each depth has. */
	const wide: number[] = [];
	const step = nodeH + rowGap;
	let cursor = PAD;
	let deepest = 0;
	const sit = (id: string, depth: number, sub: number) => {
		seat.set(id, { depth, sub });
		deepest = Math.max(deepest, depth);
		wide[depth] = Math.max(wide[depth] ?? 1, sub + 1);
	};
	const nodeOf = (id: string, row: AgentRow | null): GraphNode => {
		// A parent is pushed before its subagents: the nodes are in the order they are drawn from top to bottom, which is the
		// order Tab goes through them.
		const node: GraphNode = { id, row, x: 0, y: 0 };
		nodes.push(node);
		items.push({ kind: "node", node });
		return node;
	};

	/** The card of a finished batch: how many it stands for, how they ended, what they used and for how long. Its y. */
	const summarize = (call: string, members: AgentRow[], depth: number): number => {
		const hidden: AgentRow[] = [];
		const gather = (r: AgentRow) => {
			hidden.push(r);
			for (const kid of children.get(r.id) ?? []) gather(kid);
		};
		for (const m of members) gather(m);
		const id = summaryId(call);
		const card: GraphSummary = {
			id,
			batch: call,
			ids: members.map((m) => m.id),
			count: hidden.length,
			done: 0,
			ended: 0,
			tokens: 0,
			cost: 0,
			x: 0,
			y: cursor,
		};
		for (const r of hidden) {
			hiddenBy.set(r.id, id);
			if (outcomeOf(r) === "done") card.done++;
			else card.ended++;
			const { tokens, cost } = rowTotals(r);
			card.tokens += tokens;
			card.cost += cost;
			const end = r.finishedAt ?? r.stat?.modifiedAt;
			if (r.startedAt !== undefined) card.startedAt = Math.min(card.startedAt ?? r.startedAt, r.startedAt);
			if (end !== undefined) card.endedAt = Math.max(card.endedAt ?? end, end);
		}
		summaries.push(card);
		items.push({ kind: "summary", card });
		sit(id, depth, 0);
		cursor += step;
		return card.y;
	};

	/** Siblings with nothing below them, `GRID_COLS` to a row: the y of each, in order. */
	const cells = (leaves: AgentRow[], depth: number): number[] => {
		const columns = Math.min(GRID_COLS, leaves.length);
		const ys = leaves.map((leaf, i) => {
			const sub = i % columns;
			if (i > 0 && sub === 0) cursor += step;
			const node = nodeOf(leaf.id, leaf);
			sit(leaf.id, depth, sub);
			node.y = cursor;
			return node.y;
		});
		cursor += step;
		return ys;
	};

	// A tidy tree: leaves take the next free row, a parent sits midway between its first and last child. Each column then
	// only ever moves down, so no two nodes overlap.
	const place = (id: string, row: AgentRow | null, depth: number): number => {
		const node = nodeOf(id, row);
		sit(id, depth, 0);
		const kids = children.get(id) ?? [];
		if (!kids.length) {
			node.y = cursor;
			cursor += step;
			return node.y;
		}
		const ys: number[] = [];
		for (const [i, unit] of unitsOf(kids).entries()) {
			if (i > 0) cursor += batchGap;
			const collapsible = unit.call !== null && unit.rows.every(settled);
			if (unit.call !== null && collapsible && !open?.has(unit.call)) {
				ys.push(summarize(unit.call, unit.rows, depth + 1));
				continue;
			}
			if (unit.call !== null) {
				const ids = unit.rows.map((r) => r.id);
				const batch: GraphBatch = { id: unit.call, ids, x: 0, y: 0, w: 0, h: 0, collapsible, room: 0 };
				framed.push({ batch, rows: unit.rows });
				items.push({ kind: "batch", batch });
			}
			for (let j = 0; j < unit.rows.length; ) {
				// In a grid, the subagents with none of their own that come next side by side.
				const next = grid ? unit.rows.slice(j).findIndex((r) => children.has(r.id)) : 0;
				const run = next < 0 ? unit.rows.length - j : next;
				if (run > 1) {
					ys.push(...cells(unit.rows.slice(j, j + run), depth + 1));
					j += run;
				} else {
					const kid = unit.rows[j] as AgentRow;
					ys.push(place(kid.id, kid, depth + 1));
					j++;
				}
			}
		}
		node.y = ((ys[0] as number) + (ys.at(-1) as number)) / 2;
		return node.y;
	};
	place(MAIN, null, 0);

	// The columns: one of a depth is as wide as its widest grid.
	const columnW = (depth: number) => NODE_W + ((wide[depth] ?? 1) - 1) * (NODE_W + GRID_GAP);
	const left: number[] = [];
	for (let depth = 0, x = PAD; depth <= deepest; depth++) {
		left[depth] = x;
		x += columnW(depth) + COL_GAP;
	}
	const xOf = (id: string): number => {
		const s = seat.get(id) as { depth: number; sub: number };
		return (left[s.depth] as number) + s.sub * (NODE_W + GRID_GAP);
	};
	for (const n of nodes) n.x = xOf(n.id);
	for (const s of summaries) s.x = xOf(s.id);

	const at = new Map(nodes.map((n) => [n.id, n]));
	const batches: GraphBatch[] = framed.map(({ batch, rows: members }) => {
		const placed = members.map((m) => at.get(m.id) as GraphNode);
		const x0 = Math.min(...placed.map((n) => n.x));
		const x1 = Math.max(...placed.map((n) => n.x)) + NODE_W;
		const top = Math.min(...placed.map((n) => n.y));
		const bottom = Math.max(...placed.map((n) => n.y)) + nodeH;
		batch.x = x0 - framePad;
		batch.y = top - framePad;
		batch.w = x1 - x0 + 2 * framePad;
		batch.h = bottom - top + 2 * framePad;
		// The next column is the first that starts right of the frame (the frame's own starts left of it).
		batch.room = (left.find((x) => x > batch.x + batch.w) ?? Number.POSITIVE_INFINITY) - (batch.x + batch.w);
		return batch;
	});

	// A card takes the lines of the subagents it hides: spawns from its parent, messages to and from the rest.
	const edges: GraphEdge[] = [];
	for (const n of nodes) if (n.row) edges.push({ from: parentOf(n.id), to: n.id, kind: "spawn", count: 1 });
	for (const s of summaries) {
		edges.push({ from: parentOf(s.ids[0] as string), to: s.id, kind: "spawn", count: s.ids.length });
	}
	const said = new Map<string, GraphEdge>();
	const told = new Map<string, number>();
	const index = agentIndex(rows);
	messages(MAIN, mainTools, index, said, told);
	for (const r of rows) messages(r.id, r.live?.tools, index, said, told);
	const drawn = (id: string): string | null => (id === MAIN || at.has(id) ? id : (hiddenBy.get(id) ?? null));
	const routed = new Map<string, GraphEdge>();
	for (const e of said.values()) {
		const from = drawn(e.from);
		const to = drawn(e.to);
		// A message between two subagents of one card is inside it; one to a subagent the filter dropped goes nowhere.
		if (from === null || to === null || from === to) continue;
		const key = `${from}\u0000${to}`;
		const edge = routed.get(key);
		if (edge) edge.count += e.count;
		else routed.set(key, { ...e, from, to });
	}
	edges.push(...routed.values());
	// A card counts what the subagents it hides wrote to every agent; a sender the filter dropped is not drawn.
	const broadcasts = new Map<string, number>();
	for (const [sender, count] of told) {
		const from = drawn(sender);
		if (from !== null) broadcasts.set(from, (broadcasts.get(from) ?? 0) + count);
	}

	return {
		nodes,
		summaries,
		items,
		batches,
		edges,
		broadcasts,
		// The last column's messages between siblings curve out to its right: room for them, and for their count.
		width: (left[deepest] as number) + columnW(deepest) + PAD + MESSAGE_BULGE,
		height: Math.max(cursor - rowGap, PAD + nodeH) + PAD,
		nodeH,
	};
}
