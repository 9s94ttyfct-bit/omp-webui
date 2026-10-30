import type { GraphFilter, StatusFilter, TimeFilter } from "@shared/graph-filter.ts";
import { ChevronDown, Focus, LayoutGrid, Search, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { cx } from "./ui.tsx";

/**
 * What narrows and arranges the agent graph (#736), in the row of its totals: which subagents to show (by status and by
 * when they started), a search that finds one in a graph of hundreds, the two switches that change how the graph
 * is drawn (siblings in a grid, a view that follows what is running, with a minimap), and what its colours and lines mean.
 * Where the graph has little room (a phone, or beside an open subagent), all but the search fold behind one Filters
 * button, which counts the filters that are on: the graph, not its toolbar, gets the height.
 */

interface SegmentsProps<T extends string> {
	label: string;
	testId: string;
	value: T;
	options: [T, string][];
	onPick: (value: T) => void;
}

/**
 * A few choices side by side, one pressed (as the usage page's range). The words before them say what they choose. In
 * less room than the words and the choices need together (the graph beside an open detail on a phone), the choices
 * drop under the words, still side by side, instead of running out of the strip.
 */
function Segments<T extends string>({ label, testId, value, options, onPick }: SegmentsProps<T>) {
	return (
		<fieldset
			aria-label={label}
			data-testid={testId}
			className="m-0 flex max-w-full min-w-0 flex-wrap items-center rounded-lg border border-border bg-surface p-0.5 text-xs"
		>
			<span className="px-1.5 text-muted" aria-hidden>
				{label}
			</span>
			<span className="flex">
				{options.map(([v, text]) => (
					<button
						key={v}
						type="button"
						aria-pressed={v === value}
						data-testid={`${testId}-${v}`}
						onClick={() => onPick(v)}
						className={cx(
							"rounded-md px-2 py-1 whitespace-nowrap",
							v === value ? "bg-accent-soft font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg",
						)}
					>
						{text}
					</button>
				))}
			</span>
		</fieldset>
	);
}

/** A switch that is a button: pressed when on. */
function Toggle({
	on,
	testId,
	icon,
	onToggle,
	children,
}: {
	on: boolean;
	testId: string;
	icon: ReactNode;
	onToggle: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={on}
			data-testid={testId}
			onClick={onToggle}
			className={cx(
				"inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs whitespace-nowrap",
				on
					? "border-accent bg-accent-soft font-medium text-fg"
					: "border-border bg-surface text-muted hover:bg-hover hover:text-fg",
			)}
		>
			{icon}
			{children}
		</button>
	);
}

/** What the graph's colours and lines mean: at the end of the strip, or on a line of its own in the folded panel. */
function Legend({ className = "ml-auto" }: { className?: string }) {
	const t = useT();
	const looks: [string, string][] = [
		["border-accent", t("pages.agentsLegendRunning")],
		["border-dashed border-warning", t("pages.agentsLegendStalled")],
		["border-success/50", t("pages.agentsLegendDone")],
		["border-danger/60", t("pages.agentsLegendFailed")],
	];
	return (
		<ul
			className={cx("flex flex-wrap items-center gap-x-3 gap-y-1", className)}
			aria-label={t("pages.agentsLegend")}
			data-testid="agents-legend"
		>
			{looks.map(([look, label]) => (
				<li key={label} className="flex items-center gap-1.5">
					<span className={cx("h-3 w-4 rounded border-2 bg-surface", look)} aria-hidden />
					{label}
				</li>
			))}
			<li className="flex items-center gap-1.5">
				<svg width="18" height="6" aria-hidden>
					<line x1="0" y1="3" x2="18" y2="3" className="stroke-faint" strokeWidth="1.5" />
				</svg>
				{t("pages.agentsLegendSpawn")}
			</li>
			<li className="flex items-center gap-1.5">
				<svg width="18" height="6" aria-hidden>
					<line x1="0" y1="3" x2="18" y2="3" className="stroke-accent" strokeWidth="1.5" strokeDasharray="4 3" />
				</svg>
				{t("pages.agentsLegendMessage")}
			</li>
			<li className="flex items-center gap-1.5">
				<span className="h-3 w-4 rounded border border-dashed border-faint" aria-hidden />
				{t("pages.agentsLegendBatch")}
			</li>
		</ul>
	);
}

export function GraphControls({
	filter,
	onFilter,
	query,
	onQuery,
	found,
	at,
	onStep,
	grid,
	onGrid,
	focus,
	onFocus,
	folded,
}: {
	filter: GraphFilter;
	onFilter: (filter: GraphFilter) => void;
	query: string;
	onQuery: (query: string) => void;
	/** How many subagents the search finds, and which of them the graph is at (from 0). */
	found: number;
	at: number;
	/** Go to the next match (1) or the one before (-1). */
	onStep: (by: 1 | -1) => void;
	grid: boolean;
	onGrid: (on: boolean) => void;
	focus: boolean;
	onFocus: (on: boolean) => void;
	/** Little room for the graph: the filters, the switches and the legend fold behind the Filters button. */
	folded: boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const panelId = useId();
	const status: [StatusFilter, string][] = [
		["all", t("pages.agentsFilterAll")],
		["running", t("pages.agentsFilterRunning")],
		["failed", t("pages.agentsFilterFailed")],
	];
	const time: [TimeFilter, string][] = [
		["all", t("pages.agentsFilterAll")],
		["hour", t("pages.agentsFilterHour")],
		["today", t("pages.agentsFilterToday")],
	];
	let count = "";
	if (query.trim()) count = found ? t("pages.agentsSearchCount", { n: at + 1, m: found }) : t("pages.agentsSearchNone");
	const on = (filter.status !== "all" ? 1 : 0) + (filter.time !== "all" ? 1 : 0);

	const filters = (
		<>
			<Segments
				label={t("pages.agentsFilterStatus")}
				testId="agents-filter-status"
				value={filter.status}
				options={status}
				onPick={(s) => onFilter({ ...filter, status: s })}
			/>
			<Segments
				label={t("pages.agentsFilterTime")}
				testId="agents-filter-time"
				value={filter.time}
				options={time}
				onPick={(s) => onFilter({ ...filter, time: s })}
			/>
		</>
	);
	const search = (
		<div
			className={cx(
				"relative flex items-center",
				// Folded, it takes the row with the Filters button, and drops above it rather than cutting its prompt.
				folded ? "min-w-36 flex-1" : "min-w-0 max-sm:basis-full sm:w-52",
			)}
		>
			<Search
				size={13}
				className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint"
				aria-hidden
			/>
			<input
				type="search"
				aria-label={t("pages.agentsSearchLabel")}
				placeholder={t("pages.agentsSearchPlaceholder")}
				autoComplete="off"
				spellCheck={false}
				data-testid="agents-search"
				value={query}
				onChange={(e) => onQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key !== "Enter") return;
					e.preventDefault();
					onStep(e.shiftKey ? -1 : 1);
				}}
				className={cx(
					"h-8 w-full min-w-0 rounded-lg border border-border bg-surface pl-7 text-sm outline-none placeholder:text-faint focus:border-faint",
					// The room for the count is kept only while there is one: an empty field in a narrow strip shows its
					// whole prompt.
					count ? "pr-16" : "pr-2",
				)}
			/>
			<span
				aria-live="polite"
				data-testid="agents-search-count"
				className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs whitespace-nowrap text-muted tabular-nums"
			>
				{count}
			</span>
		</div>
	);
	const switches = (
		<>
			<Toggle on={grid} testId="agents-grid" icon={<LayoutGrid size={13} aria-hidden />} onToggle={() => onGrid(!grid)}>
				{t("pages.agentsGrid")}
			</Toggle>
			<Toggle on={focus} testId="agents-focus" icon={<Focus size={13} aria-hidden />} onToggle={() => onFocus(!focus)}>
				{t("pages.agentsFocus")}
			</Toggle>
		</>
	);

	// One row in both layouts, with the search at the same place in it: folding or unfolding (a subagent opened beside the
	// graph, the window narrowed) keeps the field, and what is typed in it and the focus with it.
	return (
		<>
			<div
				className={cx("flex min-w-0 flex-wrap items-center gap-2", folded && "basis-full")}
				data-testid="agents-controls"
			>
				{folded ? null : filters}
				{search}
				{folded ? (
					<button
						type="button"
						aria-expanded={open}
						aria-controls={panelId}
						data-testid="agents-more"
						data-on={on}
						onClick={() => setOpen(!open)}
						className={cx(
							"inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs whitespace-nowrap",
							on
								? "border-accent bg-accent-soft font-medium text-fg"
								: "border-border bg-surface text-muted hover:bg-hover hover:text-fg",
						)}
					>
						<SlidersHorizontal size={13} aria-hidden />
						{t("pages.agentsMore")}
						{on ? (
							<>
								<span
									aria-hidden
									className="rounded-full bg-accent px-1.5 text-xs leading-4 font-semibold text-accent-fg tabular-nums"
								>
									{on}
								</span>
								<span className="sr-only">{t("pages.agentsMoreOn", { n: on })}</span>
							</>
						) : null}
						<ChevronDown size={13} aria-hidden className={cx("transition-transform", open && "rotate-180")} />
					</button>
				) : (
					switches
				)}
			</div>
			{!folded ? (
				<Legend />
			) : open ? (
				<div
					id={panelId}
					className="flex min-w-0 basis-full flex-wrap items-center gap-2"
					data-testid="agents-more-panel"
				>
					{filters}
					{switches}
					<Legend className="basis-full" />
				</div>
			) : null}
		</>
	);
}
