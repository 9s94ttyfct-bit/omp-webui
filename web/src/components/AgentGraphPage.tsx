import type { SessionSummary } from "@shared/protocol.ts";
import { ChevronsDownUp, ChevronsUpDown, Maximize, Megaphone, Network, X, ZoomIn, ZoomOut } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import "../i18n/later.ts";
import { t, useT } from "../i18n/index.ts";
import {
	type AgentGraph,
	agentGraph,
	callsFor,
	fileStartedAt,
	filterIds,
	findRows,
	focusRect,
	type GraphEdge,
	type GraphFilter,
	type GraphNode,
	type GraphSummary,
	type GraphTotals,
	graphTotals,
	isStalled,
	MAIN,
	MESSAGE_BULGE,
	NO_FILTER,
	NODE_W,
	type Rect,
} from "../lib/agent-graph.ts";
import { fmtElapsed } from "../lib/clock.ts";
import { fmtClock, fmtCost, fmtTokens } from "../lib/format.ts";
import { useMediaQuery, useNarrowerThan } from "../lib/media.ts";
import { useNow } from "../lib/now.ts";
import { serverOffsetMs } from "../lib/server-clock.ts";
import { type AgentRow, ENDED, elapsedMs, isOver, rowContext, rowTotals } from "../lib/subagents.ts";
import { useAgentRows } from "../store/agents.ts";
import { useApp } from "../store/app.ts";
import type { LiveState } from "../store/live.ts";
import { GraphControls } from "./AgentGraphControls.tsx";
import { Minimap } from "./AgentGraphMinimap.tsx";
import { AgentDetail, StatusIcon, statusLabel } from "./Agents.tsx";
import { ContextPercent } from "./ContextPercent.tsx";
import type { LiveDot } from "./SessionItem.tsx";
import { liveDotsOf } from "./Sidebar.tsx";
import { argSummary } from "./ToolCard.tsx";
import { Badge, cx, Empty, IconButton } from "./ui.tsx";

/**
 * The agent graph (#719): the conversations whose omp process runs, at the left; the chosen one's agents as a graph,
 * with who started whom, the subagents one `task` call started together, and the messages agents wrote to each other;
 * a subagent's live view beside the graph when it is clicked. The page listens to the chosen conversation's process as
 * the chat view does to the one it shows (`viewedFile` in the store), and to no other.
 *
 * A conversation of hundreds of subagents (#736) is kept readable: a finished batch is one card that opens in place,
 * the toolbar filters by status and start and searches by name, a graph zoomed out draws compact cards, siblings can be
 * laid out in a grid, and a focus view follows what runs, with a minimap for the rest.
 */

const ZOOM_STEP = 1.25;
/** Far enough out for a graph of hundreds of compact cards to be seen whole. */
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 2;
/** A graph is not drawn larger than its own size to fit, nor smaller than this. */
const FIT_MIN = 0.15;
/** Below this zoom a card is a compact one (a dot and a name): full cards would be too small to read. */
const COMPACT_BELOW = 0.6;
/**
 * The compact card's text size, in the graph's own pixels: large enough to be 11px on screen at the zoom where compact
 * cards begin, so that the names of an overview can still be read. It is not a step of the type scale, which is a size
 * on screen at a zoom of 1.
 */
const COMPACT_FONT = Math.ceil(11 / COMPACT_BELOW);
/** The two switches are kept on this device (they are how this person likes to look at a graph, not a setting of omp's). */
const GRID_KEY = "ompw.agentGraph.grid";
const FOCUS_KEY = "ompw.agentGraph.focus";
/** Narrower than this, the graph's column folds its filters, switches and legend behind one button (a phone). */
const FOLD_BELOW_PX = 640;
/**
 * An open batch's Collapse control is drawn right of its frame at a size on screen that does not change with the zoom
 * (#786): WCAG 2.5.8's 24px, or 44px for a finger where the room before the next column allows it, this far from the frame.
 */
const COLLAPSE_PX = 24;
const COLLAPSE_TOUCH_PX = 44;
const COLLAPSE_GAP_PX = 4;

function readFlag(key: string): boolean {
	try {
		return localStorage.getItem(key) === "on";
	} catch {
		// A browser that refuses storage (some private modes): the switch lasts until the page closes.
		return false;
	}
}

/** A switch kept on this device: its state, and a way to change it that remembers the choice. */
function useStoredFlag(key: string): [boolean, (on: boolean) => void] {
	const [on, setOn] = useState(() => readFlag(key));
	const set = useCallback(
		(next: boolean) => {
			setOn(next);
			try {
				if (next) localStorage.setItem(key, "on");
				else localStorage.removeItem(key);
			} catch {
				// See `readFlag`.
			}
		},
		[key],
	);
	return [on, set];
}

/** The list's order: what is working first, then what waits for someone, then the rest. */
const DOT_ORDER: Record<LiveDot, number> = { running: 0, needsInput: 1, quotaHeld: 2, paused: 3, open: 4 };
const DOT_CLASS: Record<LiveDot, string> = {
	running: "bg-accent animate-pulse",
	needsInput: "bg-warning",
	quotaHeld: "border-2 border-warning",
	paused: "bg-faint",
	open: "bg-success",
};

type Look = "running" | "stalled" | "done" | "failed" | "ended" | "pending";

/** How a node is drawn: its status, unless it has been silent too long while running. */
function lookOf(node: GraphNode, mainWorking: boolean, now: number, paused: boolean): Look {
	const row = node.row;
	if (!row) return mainWorking ? "running" : "ended";
	if (isStalled(row, now, paused)) return "stalled";
	if (row.running) return "running";
	if (row.status === "completed" || row.status === "done") return "done";
	if (row.status === ENDED) return "ended";
	if (isOver(row.status)) return "failed";
	return "pending";
}

const LOOK_CLASS: Record<Look, string> = {
	running: "border-accent shadow-[0_0_0_3px] shadow-accent/15",
	stalled: "border-dashed border-warning",
	done: "border-success/50",
	failed: "border-danger/60",
	ended: "border-border",
	pending: "border-border border-dashed",
};

/** The dot of a compact card, by how its agent is drawn. */
const LOOK_DOT: Record<Look, string> = {
	running: "bg-accent",
	stalled: "bg-warning",
	done: "bg-success",
	failed: "bg-danger",
	ended: "bg-faint",
	pending: "bg-faint",
};

/** The mark of an agent in the minimap, by how it is drawn. */
const MAP_FILL: Record<Look, string> = {
	running: "fill-accent",
	stalled: "fill-warning",
	done: "fill-success",
	failed: "fill-danger",
	ended: "fill-faint",
	pending: "fill-faint",
};

const EDGE_CLASS: Record<GraphEdge["kind"], string> = {
	spawn: "stroke-faint",
	message: "stroke-accent",
};

export default function AgentGraphPage() {
	const t = useT();
	const view = useApp((s) => s.view);
	const setView = useApp((s) => s.setView);
	const file = view.kind === "agents" ? view.file : undefined;
	const dots = useApp(useShallow((s) => liveDotsOf(s.lives)));
	const sessions = useApp((s) => s.sessions);
	const byFile = useMemo(() => new Map(sessions.map((s) => [s.file, s])), [sessions]);
	const listed = useMemo(() => {
		const files = Object.keys(dots);
		// A conversation named in the address is listed whether or not it still runs: its graph is what was asked for.
		if (file && !files.includes(file)) files.push(file);
		return files.sort(
			(a, b) =>
				(DOT_ORDER[dots[a] as LiveDot] ?? 9) - (DOT_ORDER[dots[b] as LiveDot] ?? 9) ||
				nameOf(a, byFile).localeCompare(nameOf(b, byFile)),
		);
	}, [dots, file, byFile]);
	// No conversation chosen: the first one working is (the address says which from then on, so Back and a reload keep it).
	// An address may name the file by another path to it (a symlinked folder): the list's own path is the one used.
	useEffect(() => {
		if (view.kind !== "agents") return;
		if (!view.file) {
			if (listed[0]) setView({ kind: "agents", file: listed[0] }, { replace: true });
			return;
		}
		if (byFile.has(view.file)) return;
		const base = baseName(view.file);
		const same = sessions.find((s) => baseName(s.file) === base);
		if (same) setView({ kind: "agents", file: same.file }, { replace: true });
	}, [view, listed, setView, byFile, sessions]);

	return (
		<div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden" data-testid="agents-page">
			<div className="border-b border-border px-4 pt-4 pb-3 md:px-6">
				<h1 className="flex items-center gap-3 text-xl font-semibold">
					<Network className="shrink-0 text-accent" /> {t("pages.agentsTitle")}
				</h1>
				<p className="mt-1 max-w-prose text-xs text-muted">{t("pages.agentsIntro")}</p>
			</div>
			{listed.length ? (
				<div className="flex min-h-0 flex-1 flex-col md:flex-row">
					<nav
						aria-label={t("pages.agentsListLabel")}
						className="flex max-h-40 shrink-0 flex-col overflow-y-auto border-b border-border p-2 md:max-h-none md:w-60 md:border-r md:border-b-0"
						data-testid="agents-list"
					>
						{listed.map((f) => {
							const dot = dots[f];
							return (
								<button
									key={f}
									type="button"
									aria-current={f === file ? "page" : undefined}
									data-testid="agents-conversation"
									data-file={f}
									onClick={() => setView({ kind: "agents", file: f })}
									className={cx(
										"flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm",
										f === file ? "bg-hover text-fg" : "text-muted hover:bg-hover/70 hover:text-fg",
									)}
								>
									<span
										className={cx("h-2 w-2 shrink-0 rounded-full", dot ? DOT_CLASS[dot] : "border border-faint")}
										aria-hidden
									/>
									<span className="min-w-0 flex-1 truncate">{nameOf(f, byFile)}</span>
								</button>
							);
						})}
					</nav>
					{file ? <Conversation key={file} file={file} title={nameOf(file, byFile)} /> : null}
				</div>
			) : (
				// Nothing to list: the page's own area says so, where the graph would be, not in a list column of its own.
				<div className="flex min-h-0 flex-1 items-center justify-center p-6" data-testid="agents-none">
					<Empty icon={<Network size={28} className="text-accent" />} title={t("pages.agentsNoneTitle")}>
						{t("pages.agentsNoneRunning")}
					</Empty>
				</div>
			)}
		</div>
	);
}

const baseName = (file: string): string => file.split("/").pop() ?? file;

/**
 * A conversation by its title, or what was first said in it; one with neither (omp has not written a message yet) is "Untitled"
 * with the time it began, which tells two of them apart where the id in its file's name does not.
 */
function nameOf(file: string, byFile: Map<string, SessionSummary>): string {
	const s = byFile.get(file);
	const named = s?.title || s?.preview;
	if (named) return named;
	const began = (s ? Date.parse(s.createdAt) : Number.NaN) || fileStartedAt(file);
	return began ? t("pages.agentsUntitled", { time: fmtClock(began) }) : t("shell.sessionUntitled");
}

/** One conversation's graph, and the live view of the subagent chosen in it. */
function Conversation({ file, title }: { file: string; title: string }) {
	const t = useT();
	const setView = useApp((s) => s.setView);
	const live = useApp((s) => Object.values(s.lives).find((l) => !l.info.exited && l.info.sessionFile === file));
	const summary = useApp((s) => s.sessions.find((x) => x.file === file));
	const rows = useAgentRows(file, live);
	const mainWorking = Boolean(live?.streaming || live?.info.continuing);
	const [filter, setFilter] = useState<GraphFilter>(NO_FILTER);
	const [query, setQuery] = useState("");
	/** The finished batches (`task` call ids) the person opened: this conversation's, kept in memory only. */
	const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
	const [grid, setGrid] = useStoredFlag(GRID_KEY);
	const [focus, setFocus] = useStoredFlag(FOCUS_KEY);
	/** Counts up each time a switch asks the view to frame what runs again (Focus turned on, Grid changed in focus). */
	const [reframe, setReframe] = useState(0);
	/** Which match of the search the graph is at, and how often it was asked to go to one. */
	const [at, setAt] = useState(0);
	const [reveal, setReveal] = useState(0);
	// "Last hour" is read against the clock: it keeps time, slowly, while nothing else moves.
	const now = useNow(mainWorking || rows.some((r) => r.running) ? 1000 : filter.time === "all" ? null : 60_000);
	const paused = Boolean(live?.info.pausedAt);
	// A time filter is read against the clock, but what it keeps is a new graph only when it keeps other subagents: the
	// layout is not built again each second.
	const kept = useMemo(() => filterIds(rows, filter, now), [rows, filter, now]);
	const keptKey = kept ? [...kept].join("\n") : null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `keptKey` says which subagents these are
	const keep = useMemo(() => kept, [keptKey]);
	const found = useMemo(() => findRows(rows, keep, query), [rows, keep, query]);
	// A match in a card opens it, whether or not the person did: until the search is over, it cannot be closed.
	const forced = useMemo(() => callsFor(rows, found), [rows, found]);
	const open = useMemo(() => new Set([...opened, ...forced]), [opened, forced]);
	const closable = useMemo(() => new Set([...opened].filter((call) => !forced.has(call))), [opened, forced]);
	const foundSet = useMemo(() => new Set(found), [found]);
	const build = useCallback(
		(compact: boolean) => agentGraph(rows, live?.tools, { open, keep, compact, grid }),
		[rows, live?.tools, open, keep, grid],
	);
	const totals = useMemo(() => graphTotals(rows, now, paused), [rows, now, paused]);
	const main = mainLines(t, title, live, summary, mainWorking, now);
	const [chosen, setChosen] = useState<string | null>(null);
	const row = chosen ? rows.find((r) => r.id === chosen) : undefined;
	const here = found.length ? at % found.length : 0;
	const [column, setColumn] = useState<HTMLElement | null>(null);
	// Beside an open subagent, or on a narrow screen, the strip over the graph would take most of the column's height.
	const folded = useNarrowerThan(column, FOLD_BELOW_PX) || row !== undefined;

	return (
		<div className="flex min-h-0 min-w-0 flex-1">
			<section
				ref={setColumn}
				className="flex min-h-0 min-w-0 flex-1 flex-col"
				aria-label={t("pages.agentsGraphLabel", { title })}
				data-testid="agents-column"
			>
				<Summary totals={totals}>
					<GraphControls
						filter={filter}
						onFilter={setFilter}
						query={query}
						onQuery={(q) => {
							setQuery(q);
							setAt(0);
							setReveal((n) => n + 1);
						}}
						found={found.length}
						at={here}
						onStep={(by) => {
							if (!found.length) return;
							setAt((here + by + found.length) % found.length);
							setReveal((n) => n + 1);
						}}
						grid={grid}
						onGrid={(on) => {
							setGrid(on);
							// The cards are laid out anew: where the person had put the view is no longer where anything is.
							if (focus) setReframe((n) => n + 1);
						}}
						focus={focus}
						folded={folded}
						onFocus={(on) => {
							setFocus(on);
							if (on) setReframe((n) => n + 1);
						}}
					/>
				</Summary>
				<Canvas
					build={build}
					now={now}
					paused={paused}
					main={main}
					mainWorking={mainWorking}
					chosen={chosen}
					onChoose={(id) =>
						id === MAIN ? setView({ kind: "chat", file, liveId: null }) : setChosen(id === chosen ? null : id)
					}
					found={foundSet}
					current={found[here] ?? null}
					reveal={reveal}
					focus={focus}
					reframe={reframe}
					closable={closable}
					onOpen={(call) => setOpened((s) => new Set(s).add(call))}
					onClose={(call) =>
						setOpened((s) => {
							const next = new Set(s);
							next.delete(call);
							return next;
						})
					}
				/>
				{rows.length === 0 ? (
					<p className="px-4 pb-3 text-xs text-muted" data-testid="agents-no-subagents">
						{t("pages.agentsNoSubagents")}
					</p>
				) : keep?.size === 0 ? (
					<p className="px-4 pb-3 text-xs text-muted" data-testid="agents-filter-empty">
						{t("pages.agentsFilterEmpty")}
					</p>
				) : null}
			</section>
			{row ? (
				<aside
					className="flex min-h-0 w-[min(440px,50%)] shrink-0 flex-col border-l border-border"
					data-testid="agents-detail"
				>
					<AgentDetail
						key={row.id}
						row={row}
						rows={rows}
						live={live}
						onOpenAgent={setChosen}
						header={
							<div className="flex items-center gap-2 border-b border-border px-3 py-2">
								<StatusIcon status={row.status} />
								<span className="min-w-0 truncate text-sm font-semibold">{row.id}</span>
								{row.agent ? <Badge>{row.agent}</Badge> : null}
								<IconButton
									label={t("pages.agentsCloseDetail")}
									size="sm"
									className="ml-auto"
									onClick={() => setChosen(null)}
									data-testid="agents-detail-close"
								>
									<X size={15} />
								</IconButton>
							</div>
						}
					/>
				</aside>
			) : null}
		</div>
	);
}

/** The totals over the graph, and the strip that narrows and arranges it. */
function Summary({ totals, children }: { totals: GraphTotals; children?: ReactNode }) {
	const t = useT();
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2 text-xs text-muted">
			<span className="sr-only">{t("pages.agentsTotals")}</span>
			<span data-testid="agents-totals" className="flex flex-wrap gap-x-3 tabular-nums">
				<span className={totals.running ? "text-accent" : undefined}>
					{t("pages.agentsRunningCount", { n: totals.running })}
				</span>
				<span>
					{totals.total === 1 ? t("pages.agentsTotalCountOne") : t("pages.agentsTotalCount", { n: totals.total })}
				</span>
				{totals.stalled ? (
					<span className="text-warning">{t("pages.agentsStalledCount", { n: totals.stalled })}</span>
				) : null}
				<span>{t("pages.agentsTokens", { n: fmtTokens(totals.tokens) })}</span>
				<span>{fmtCost(totals.cost)}</span>
			</span>
			{children}
		</div>
	);
}

/** A point on a cubic curve at its middle: where a count is written. */
const mid = (a: number, b: number, c: number, d: number) => (a + 3 * b + 3 * c + d) / 8;

/** Where a card is: what an edge needs of it. */
interface Spot {
	x: number;
	y: number;
}

/**
 * The line of an edge: from the right side of the agent on the left to the left side of the one on the right, or
 * around the right side of one column when both are in it (a message between siblings). `h` is the height of a card.
 */
function edgePath(from: Spot, to: Spot, kind: GraphEdge["kind"], h: number): { d: string; x: number; y: number } {
	// A message between a parent and its child would lie on the line that says who started whom: it runs a little lower.
	const shift = kind === "message" ? Math.min(14, h / 4) : 0;
	const y1 = from.y + h / 2 + shift;
	const y2 = to.y + h / 2 + shift;
	let x1: number;
	let x2: number;
	let c1: number;
	let c2: number;
	if (to.x > from.x) {
		x1 = from.x + NODE_W;
		x2 = to.x;
		c1 = x1 + (x2 - x1) / 2;
		c2 = x2 - (x2 - x1) / 2;
	} else if (to.x < from.x) {
		x1 = from.x;
		x2 = to.x + NODE_W;
		c1 = x1 - (x1 - x2) / 2;
		c2 = x2 + (x1 - x2) / 2;
	} else {
		x1 = from.x + NODE_W;
		x2 = to.x + NODE_W;
		c1 = x1 + MESSAGE_BULGE;
		c2 = x2 + MESSAGE_BULGE;
	}
	return { d: `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`, x: mid(x1, c1, c2, x2), y: mid(y1, y1, y2, y2) };
}

/** What the canvas fits into its window: the whole graph, or in focus mode the part of it that is running. */
const frameOf = (graph: AgentGraph, focus: boolean): Rect =>
	focus ? focusRect(graph) : { x: 0, y: 0, w: graph.width, h: graph.height };

/** The zoom at which `frame` fills a window of `size` (at most 1), and not less than `FIT_MIN`. */
const fitIn = (size: { w: number; h: number }, frame: Rect): number =>
	size.w && size.h ? Math.max(FIT_MIN, Math.min(size.w / frame.w, size.h / frame.h, 1)) : 1;

function Canvas({
	build,
	now,
	paused,
	main,
	mainWorking,
	chosen,
	onChoose,
	found,
	current,
	reveal,
	focus,
	reframe,
	closable,
	onOpen,
	onClose,
}: {
	/** The graph as full cards or as compact ones: the canvas draws the compact one when it is zoomed out. */
	build: (compact: boolean) => AgentGraph;
	now: number;
	/** The conversation is paused: nothing it runs is drawn as stalled. */
	paused: boolean;
	/** The main agent's card below its name (see `mainLines`). */
	main: string[];
	mainWorking: boolean;
	chosen: string | null;
	onChoose: (id: string) => void;
	/** The subagents the search found (drawn with a ring), and the one it is at. */
	found: ReadonlySet<string>;
	current: string | null;
	/** Counts up each time the search asks to go to `current`. */
	reveal: number;
	/** The view frames the main agent and what runs, and has a minimap. */
	focus: boolean;
	/** Counts up each time the switches ask the view to frame again (see `refit`). */
	reframe: number;
	/** The finished batches the person opened, which can be closed again. */
	closable: ReadonlySet<string>;
	onOpen: (call: string) => void;
	onClose: (call: string) => void;
}) {
	const t = useT();
	const box = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 0, h: 0 });
	/** The zoom the person chose with the buttons: the graph keeps it instead of fitting itself again as it grows. */
	const [picked, setPicked] = useState<number | null>(null);
	/** Counts up each time Fit is pressed. */
	const [fits, setFits] = useState(0);
	/** The person moved the view (scrolled, used the minimap, searched): a focus view stops framing until Fit is pressed. */
	const panned = useRef(false);
	/** Where the view was last put by code, so that a scroll anywhere else is known to be the person's. */
	const placed = useRef({ left: 0, top: 0 });
	/** The middle of the view as a share of the graph, kept in the middle when the zoom (and with it the layout) changes. */
	const middle = useRef<{ fx: number; fy: number } | null>(null);
	const agentName = (id: string) => (id === MAIN ? t("pages.agentsMain") : id);

	// A graph that fits at a zoom where full cards would be unreadable is drawn with compact ones, which are shorter and so
	// fit larger; below `COMPACT_BELOW` is where compact cards are used, and the fit never goes above it with them.
	const full = useMemo(() => build(false), [build]);
	const fullFit = useMemo(() => fitIn(size, frameOf(full, focus)), [size, full, focus]);
	const compact = picked === null ? fullFit < COMPACT_BELOW : picked < COMPACT_BELOW;
	const small = useMemo(() => (compact ? build(true) : null), [build, compact]);
	const graph = small ?? full;
	const frame = useMemo(() => frameOf(graph, focus), [graph, focus]);
	const fit = fitIn(size, frame);
	const scale = picked ?? (compact ? Math.min(fit, COMPACT_BELOW - 0.01) : fit);
	const spots = useMemo(
		() => new Map<string, Spot>([...graph.nodes, ...graph.summaries].map((n) => [n.id, n])),
		[graph],
	);
	const fills = useMemo(() => {
		const m = new Map<string, string>();
		for (const n of graph.nodes) m.set(n.id, MAP_FILL[lookOf(n, mainWorking, now, paused)]);
		for (const s of graph.summaries) m.set(s.id, "fill-success/50");
		return m;
	}, [graph, mainWorking, now, paused]);
	const touch = useMediaQuery("(pointer: coarse)");
	/** The size on screen of each open batch's Collapse control (`COLLAPSE_PX`). */
	const collapse = useMemo(() => {
		const m = new Map<string, number>();
		for (const b of graph.batches) {
			if (!b.collapsible || !closable.has(b.id)) continue;
			const room = b.room * scale - COLLAPSE_GAP_PX;
			m.set(b.id, touch ? Math.max(COLLAPSE_PX, Math.min(COLLAPSE_TOUCH_PX, room)) : COLLAPSE_PX);
		}
		return m;
	}, [graph, closable, scale, touch]);
	// The scrolled area holds the controls drawn right of the last column, or below the graph, at this zoom.
	let width = graph.width * scale;
	let height = graph.height * scale;
	for (const b of graph.batches) {
		const px = collapse.get(b.id);
		if (px === undefined) continue;
		width = Math.max(width, (b.x + b.w) * scale + COLLAPSE_GAP_PX + px);
		height = Math.max(height, b.y * scale + px);
	}

	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		const measure = () =>
			setSize((s) =>
				s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight },
			);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const scrollTo = useCallback((left: number, top: number) => {
		const el = box.current;
		if (!el) return;
		el.scrollLeft = left;
		el.scrollTop = top;
		placed.current = { left: el.scrollLeft, top: el.scrollTop };
	}, []);
	/** A scroll that is not where code put the view is the person's. */
	const onScroll = () => {
		const el = box.current;
		if (el && (Math.abs(el.scrollLeft - placed.current.left) > 1 || Math.abs(el.scrollTop - placed.current.top) > 1))
			panned.current = true;
	};
	const pan = useCallback(
		(left: number, top: number) => {
			panned.current = true;
			scrollTo(left, top);
		},
		[scrollTo],
	);
	/** Fit: the view frames again at the zoom that fits, as if the person had not moved or zoomed it. */
	const refit = useCallback(() => {
		panned.current = false;
		setPicked(null);
		setFits((n) => n + 1);
	}, []);
	// A switch that changes what the view is of does the same: Focus turned on, or Grid changed while in focus. Where the
	// person put the view, and the zoom they chose, belong to the view that was there before it.
	useLayoutEffect(() => {
		if (reframe) refit();
	}, [reframe, refit]);
	// A focus view puts what runs in the window when it is first shown and whenever that, the zoom or the window change,
	// until the person has moved the view or zoomed (Fit, or a switch above, starts it again).
	// biome-ignore lint/correctness/useExhaustiveDependencies: `fits` is a press of Fit: frame again.
	useLayoutEffect(() => {
		if (focus && picked === null && !panned.current) scrollTo(frame.x * scale, frame.y * scale);
	}, [focus, picked, scale, frame.x, frame.y, size.w, size.h, fits, scrollTo]);
	// The zoom keeps the middle of what is on screen in the middle.
	useLayoutEffect(() => {
		const el = box.current;
		const anchor = middle.current;
		if (!el || !anchor) return;
		middle.current = null;
		scrollTo(
			anchor.fx * graph.width * scale - el.clientWidth / 2,
			anchor.fy * graph.height * scale - el.clientHeight / 2,
		);
	}, [scale, graph, scrollTo]);
	// The search goes to its match: it is in the middle of the window (after the frame above: the search has the last word).
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a new request goes (not a new second, or a new frame).
	useLayoutEffect(() => {
		const el = box.current;
		const spot = current ? spots.get(current) : undefined;
		if (!el || !spot) return;
		pan((spot.x + NODE_W / 2) * scale - el.clientWidth / 2, (spot.y + graph.nodeH / 2) * scale - el.clientHeight / 2);
	}, [reveal]);
	// The card or the control that was pressed is gone once a batch opens or closes: keyboard focus goes to what took its
	// place (the first subagent of the batch it opened, the card it closed into).
	const [landing, setLanding] = useState<{ call: string; to: "members" | "card" } | null>(null);
	useLayoutEffect(() => {
		if (!landing) return;
		setLanding(null);
		const first = graph.batches.find((b) => b.id === landing.call)?.ids[0] ?? "";
		const target =
			landing.to === "card"
				? `[data-testid="agent-summary"][data-batch="${CSS.escape(landing.call)}"]`
				: `[data-agent-id="${CSS.escape(first)}"]`;
		box.current?.querySelector<HTMLElement>(target)?.focus();
	}, [landing, graph]);
	const zoom = (by: number) => {
		const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale * by));
		// At the end of the range nothing changes, so there is no new scale to put the middle back for.
		if (next === scale) return;
		const el = box.current;
		if (el) {
			middle.current = {
				fx: (el.scrollLeft + el.clientWidth / 2) / (graph.width * scale),
				fy: (el.scrollTop + el.clientHeight / 2) / (graph.height * scale),
			};
		}
		setPicked(next);
	};

	return (
		<div className="relative flex min-h-0 flex-1">
			<div
				ref={box}
				onScroll={onScroll}
				className="min-h-0 min-w-0 flex-1 overflow-auto"
				data-testid="agents-canvas"
				data-scale={scale}
				data-compact={compact}
			>
				<div style={{ width, height }}>
					<div
						className="relative origin-top-left"
						style={{ width: graph.width, height: graph.height, transform: `scale(${scale})` }}
					>
						<svg width={graph.width} height={graph.height} className="absolute inset-0" aria-hidden>
							<defs>
								<marker
									id="agents-arrow"
									viewBox="0 0 8 8"
									refX="7"
									refY="4"
									markerWidth="7"
									markerHeight="7"
									orient="auto"
								>
									<path d="M0,0 L8,4 L0,8 z" className="fill-accent" />
								</marker>
							</defs>
							{graph.batches.map((b) => (
								<rect
									key={b.id}
									x={b.x}
									y={b.y}
									width={b.w}
									height={b.h}
									rx={14}
									className="fill-none stroke-faint"
									strokeDasharray="5 4"
									data-testid="agents-batch"
								>
									<title>{t("pages.agentsBatch", { n: b.ids.length })}</title>
								</rect>
							))}
							{graph.edges.map((e) => {
								const from = spots.get(e.from);
								const to = spots.get(e.to);
								if (!from || !to) return null;
								const { d, x, y } = edgePath(from, to, e.kind, graph.nodeH);
								return (
									<g
										key={`${e.kind}:${e.from}:${e.to}`}
										data-testid={`agents-edge-${e.kind}`}
										data-from={e.from}
										data-to={e.to}
									>
										<path
											d={d}
											className={cx("fill-none", EDGE_CLASS[e.kind])}
											strokeWidth={1.5}
											strokeDasharray={e.kind === "message" ? "5 4" : undefined}
											markerEnd={e.kind === "message" ? "url(#agents-arrow)" : undefined}
										>
											{e.kind === "message" ? (
												<title>
													{t(e.count === 1 ? "pages.agentsMessagesOne" : "pages.agentsMessages", {
														n: e.count,
														from: agentName(e.from),
														to: agentName(e.to),
													})}
												</title>
											) : null}
										</path>
										{e.kind === "message" && e.count > 1 ? (
											<text x={x} y={y - 4} textAnchor="middle" className="fill-accent text-xs">
												{e.count}
											</text>
										) : null}
									</g>
								);
							})}
						</svg>
						{/* One list in the order the graph is drawn (`items`): Tab goes from an agent to its subagents, and reaches
						    a frame's Collapse and a batch's card where they are, not after every card of the graph. */}
						{graph.items.map((item) => {
							if (item.kind === "node") {
								const n = item.node;
								return (
									<Node
										key={`node:${n.id}`}
										node={n}
										now={now}
										main={main}
										look={lookOf(n, mainWorking, now, paused)}
										chosen={chosen === n.id}
										onChoose={onChoose}
										compact={compact}
										h={graph.nodeH}
										matched={found.has(n.id)}
										current={current === n.id}
										told={graph.broadcasts.get(n.id) ?? 0}
									/>
								);
							}
							if (item.kind === "summary") {
								const s = item.card;
								return (
									<SummaryCard
										key={s.id}
										card={s}
										compact={compact}
										h={graph.nodeH}
										told={graph.broadcasts.get(s.id) ?? 0}
										onOpen={(call) => {
											onOpen(call);
											setLanding({ call, to: "members" });
										}}
									/>
								);
							}
							const b = item.batch;
							const px = collapse.get(b.id);
							if (px === undefined) return null;
							// Above the cards (it is in the list before its batch's first one, which would be drawn over it), and the
							// same size on screen whatever the zoom: the scale the graph is drawn at is undone for it.
							return (
								<button
									key={`frame:${b.id}`}
									type="button"
									aria-label={t("pages.agentsCollapse", { n: b.ids.length })}
									data-testid="agents-collapse"
									data-batch={b.id}
									onClick={() => {
										onClose(b.id);
										setLanding({ call: b.id, to: "card" });
									}}
									className="absolute z-10 flex origin-top-left items-center justify-center rounded-md border border-border bg-surface text-muted hover:bg-hover hover:text-fg"
									style={{
										left: b.x + b.w + COLLAPSE_GAP_PX / scale,
										top: b.y,
										width: px,
										height: px,
										transform: `scale(${1 / scale})`,
									}}
								>
									<ChevronsDownUp size={px < COLLAPSE_TOUCH_PX ? 14 : 20} aria-hidden />
								</button>
							);
						})}
					</div>
				</div>
			</div>
			{focus ? <Minimap graph={graph} scale={scale} box={box} fills={fills} onPan={pan} /> : null}
			<div className="absolute right-3 bottom-3 flex flex-col gap-1 rounded-lg border border-border bg-surface p-1 shadow-sm">
				<IconButton
					label={t("pages.agentsZoomIn")}
					size="sm"
					onClick={() => zoom(ZOOM_STEP)}
					data-testid="agents-zoom-in"
				>
					<ZoomIn size={15} />
				</IconButton>
				<IconButton
					label={t("pages.agentsZoomOut")}
					size="sm"
					onClick={() => zoom(1 / ZOOM_STEP)}
					data-testid="agents-zoom-out"
				>
					<ZoomOut size={15} />
				</IconButton>
				<IconButton label={t("pages.agentsFit")} size="sm" onClick={refit} data-testid="agents-fit">
					<Maximize size={15} />
				</IconButton>
			</div>
		</div>
	);
}

/** One agent's card: who it is, what it is doing, with what model, for how long, and what it has used. */
function Node({
	node,
	now,
	main,
	look,
	chosen,
	onChoose,
	compact,
	h,
	matched,
	current,
	told,
}: {
	node: GraphNode;
	now: number;
	main: string[];
	look: Look;
	chosen: boolean;
	onChoose: (id: string) => void;
	/** A dot and the name only, `h` high. */
	compact: boolean;
	h: number;
	/** The search found it (ringed), and it is the one the search is at (ringed thicker). */
	matched: boolean;
	current: boolean;
	/** How many messages it wrote to every agent (`Broadcasts`). */
	told: number;
}) {
	const t = useT();
	const row = node.row;
	const status =
		look === "stalled"
			? t("pages.agentsStalled")
			: row
				? statusLabel(t, row.status)
				: look === "running"
					? t("pages.agentsMainWorking")
					: t("pages.agentsMainIdle");
	const name = row ? row.name : t("pages.agentsMain");
	const ctx = row ? rowContext(row) : undefined;
	return (
		<button
			type="button"
			data-testid="agent-node"
			data-agent-id={node.id || "main"}
			data-look={look}
			data-match={matched ? (current ? "current" : "match") : undefined}
			aria-pressed={row ? chosen : undefined}
			title={row ? (compact ? `${row.id} · ${status}` : undefined) : t("pages.agentsOpenConversation")}
			onClick={() => onChoose(node.id)}
			className={cx(
				"absolute overflow-hidden border-2 bg-surface text-left hover:bg-hover",
				compact ? "flex items-center gap-2 rounded-lg px-2" : "flex flex-col gap-0.5 rounded-xl px-3 py-2 text-xs",
				LOOK_CLASS[look],
				matched ? (current ? "ring-4 ring-accent" : "ring-2 ring-accent") : chosen && "ring-2 ring-fg/40",
			)}
			style={{ left: node.x, top: node.y, width: NODE_W, height: h }}
		>
			{compact ? (
				<>
					<span className={cx("h-3 w-3 shrink-0 rounded-full", LOOK_DOT[look])} aria-hidden />
					<span
						className="min-w-0 flex-1 truncate font-semibold leading-none text-fg"
						style={{ fontSize: COMPACT_FONT }}
					>
						{name}
					</span>
					<Broadcasts n={told} />
					<span className="sr-only">{status}</span>
				</>
			) : (
				<>
					<span className="flex items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{name}</span>
						<Broadcasts n={told} />
						<span className={cx("shrink-0", look === "stalled" ? "text-warning" : "text-faint")}>{status}</span>
					</span>
					{(row ? rowLines(t, row, now) : main).map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a card's lines are in a fixed order
						<span key={i} className={cx("truncate", i === 0 ? "text-muted" : "text-faint tabular-nums")}>
							{line}
							{/* How full its context is, after its model and time. */}
							{i === 1 && ctx ? (
								<>
									{line ? " · " : null}
									<ContextPercent ctx={ctx} />
								</>
							) : null}
						</span>
					))}
				</>
			)}
		</button>
	);
}

/**
 * The messages an agent (or the agents of a card) wrote to every agent, `agent://all`: one mark on the sender's card. An
 * edge to each of hundreds of subagents would hide the graph, and cost as much to draw.
 */
function Broadcasts({ n }: { n: number }) {
	const t = useT();
	if (!n) return null;
	const label = t(n === 1 ? "pages.agentsBroadcastsOne" : "pages.agentsBroadcasts", { n });
	return (
		<span
			data-testid="agents-broadcast"
			data-count={n}
			title={label}
			className="inline-flex shrink-0 items-center gap-0.5 text-xs text-accent tabular-nums"
		>
			<Megaphone size={12} aria-hidden />
			<span aria-hidden>{n}</span>
			<span className="sr-only">{label}</span>
		</span>
	);
}

/**
 * The card of a finished batch: how many subagents it stands for, how they ended, what they used and how long it took.
 * Pressing it draws them one by one.
 */
function SummaryCard({
	card,
	compact,
	h,
	told,
	onOpen,
}: {
	card: GraphSummary;
	compact: boolean;
	h: number;
	/** How many messages the agents it stands for wrote to every agent (`Broadcasts`). */
	told: number;
	onOpen: (call: string) => void;
}) {
	const t = useT();
	const count = t("pages.agentsTotalCount", { n: card.count });
	const nested = card.count - card.ids.length;
	const ended = [
		t("pages.agentsSummaryDone", { n: card.done }),
		card.ended ? t("pages.agentsSummaryEnded", { n: card.ended }) : "",
		nested ? t("pages.agentsSummaryNested", { n: nested }) : "",
	].filter(Boolean);
	const spent = [
		card.tokens ? t("pages.agentsTokens", { n: fmtTokens(card.tokens) }) : "",
		card.cost ? fmtCost(card.cost) : "",
	].filter(Boolean);
	const took =
		card.startedAt !== undefined && card.endedAt !== undefined ? fmtElapsed(card.endedAt - card.startedAt) : "";
	return (
		<button
			type="button"
			data-testid="agent-summary"
			data-batch={card.batch}
			data-agents={card.count}
			aria-expanded={false}
			title={t("pages.agentsSummaryExpand")}
			onClick={() => onOpen(card.batch)}
			className={cx(
				"absolute overflow-hidden border-2 border-success/50 bg-surface text-left shadow-[3px_3px_0_0] shadow-success/20 hover:bg-hover",
				compact ? "flex items-center gap-2 rounded-lg px-2" : "flex flex-col gap-0.5 rounded-xl px-3 py-2 text-xs",
			)}
			style={{ left: card.x, top: card.y, width: NODE_W, height: h }}
		>
			{compact ? (
				<>
					<span className="h-3 w-3 shrink-0 rounded-full bg-success" aria-hidden />
					<span
						className="min-w-0 flex-1 truncate font-semibold leading-none text-fg"
						style={{ fontSize: COMPACT_FONT }}
					>
						{count}
					</span>
					<Broadcasts n={told} />
				</>
			) : (
				<>
					<span className="flex items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{count}</span>
						<Broadcasts n={told} />
						<ChevronsUpDown size={14} className="shrink-0 text-faint" aria-hidden />
					</span>
					<span className="truncate text-muted">{ended.join(" · ")}</span>
					<span className="truncate text-faint tabular-nums">{spent.join(" · ")}</span>
					<span className="truncate text-faint tabular-nums">{took}</span>
				</>
			)}
		</button>
	);
}

type Translate = ReturnType<typeof useT>;

/** A subagent's card below its name: what it is doing, its model and time, and what it has used. */
function rowLines(t: Translate, row: AgentRow, now: number): string[] {
	const p = row.live?.progress;
	const doing =
		row.running && p?.currentTool
			? `${p.currentTool}${p.currentToolArgs ? `: ${p.currentToolArgs}` : ""}`
			: p?.lastIntent || row.live?.description || "";
	const elapsed = elapsedMs(row, now);
	const { tokens, cost } = rowTotals(row);
	const model = p?.resolvedModel ? p.resolvedModel.slice(p.resolvedModel.lastIndexOf("/") + 1) : "";
	return [
		[row.agent, doing].filter(Boolean).join(" · "),
		[model, elapsed === undefined ? "" : fmtElapsed(elapsed)].filter(Boolean).join(" · "),
		[
			tokens ? t("pages.agentsTokens", { n: fmtTokens(tokens) }) : "",
			cost ? fmtCost(cost) : "",
			p?.toolCount ? (p.toolCount === 1 ? t("pages.agentsToolsOne") : t("pages.agentsTools", { n: p.toolCount })) : "",
		]
			.filter(Boolean)
			.join(" · "),
	];
}

/**
 * The main agent's card below its name: the tool it is running (else the conversation's name), its model and how long
 * the turn has run, and what its own requests used: the conversation's figures less its subagents' and advisors' (the
 * session list's, which the server reads from the whole transcript; the page may hold only its end).
 */
function mainLines(
	t: Translate,
	title: string,
	live: LiveState | undefined,
	summary: SessionSummary | undefined,
	working: boolean,
	now: number,
): string[] {
	const tool = Object.values(live?.tools ?? {}).find((x) => !x.done);
	const doing = tool ? `${tool.toolName}: ${tool.intent || argSummary(tool.args)}` : title;
	// omp stamps the turn's start on the server's clock.
	const began = working && live?.info.turnStartedAt ? live.info.turnStartedAt - serverOffsetMs() : undefined;
	const model = live?.state?.model?.id ?? "";
	const own = summary ? ownUsage(summary) : null;
	return [
		doing,
		[model, began === undefined ? "" : fmtElapsed(Math.max(0, now - began))].filter(Boolean).join(" · "),
		own
			? [own.tokens ? t("pages.agentsTokens", { n: fmtTokens(own.tokens) }) : "", own.cost ? fmtCost(own.cost) : ""]
					.filter(Boolean)
					.join(" · ")
			: "",
	];
}

/** A conversation's own requests: what it spent in all, less what its subagents and advisors did. */
function ownUsage(s: SessionSummary): { tokens: number; cost: number } {
	const tokens = (u: SessionSummary["usage"]) => u.input + u.output + u.cacheRead + u.cacheWrite;
	return {
		tokens: Math.max(0, tokens(s.usage) - tokens(s.subagentUsage) - tokens(s.advisorUsage)),
		cost: Math.max(0, s.usage.cost - s.subagentUsage.cost - s.advisorUsage.cost),
	};
}
