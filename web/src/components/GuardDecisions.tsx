import {
	decisionMatches,
	GUARD_BYS,
	GUARD_OUTCOMES,
	type GuardBy,
	type GuardDecision,
	type GuardLogQuery,
	type GuardOutcome,
} from "@shared/guard.ts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { guardApi } from "../lib/guard-api.ts";
import { BY_TEXT, OUTCOME_TEXT } from "../lib/guard-format.ts";
import { useApp } from "../store/app.ts";
import { conversationOf, useGuard } from "../store/guard.ts";
import { DecisionRow } from "./GuardDecisionRow.tsx";
import { Select, Spinner } from "./ui.tsx";

/** How many decisions one request asks for: the list is read a page at a time, as the person scrolls. */
const PAGE = 50;
/** The pause after the last key of the search box before the list is asked for again. */
const SEARCH_MS = 250;
/** A row's height before it is measured. */
const ROW_ESTIMATE = 118;

interface Filters {
	outcome: GuardOutcome | "";
	by: GuardBy | "";
	text: string;
}

/** The words in the box, a moment after the last key. */
function useDebounced(value: string, ms: number): string {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), ms);
		return () => clearTimeout(timer);
	}, [value, ms]);
	return settled;
}

/** `list` with `incoming` in front, once each by id. */
function withFirst(list: GuardDecision[], incoming: GuardDecision[]): GuardDecision[] {
	const seen = new Set(list.map((d) => d.id));
	return [...incoming.filter((d) => !seen.has(d.id)), ...list];
}

/**
 * The decisions the guard made, newest first, in a list of their own: filtered by outcome, by who decided and by words, read
 * from the server a page at a time as the person scrolls, and drawn a window at a time (a log of thousands is as light as one of
 * ten). A decision that is made while the page is open joins the top when it matches the filters. A decision's words come from a
 * reviewer model or from the processes the agent runs in, so they are never taken for anything but text.
 */
export default function GuardDecisions() {
	const t = useT();
	const [filters, setFilters] = useState<Filters>({ outcome: "", by: "", text: "" });
	const words = useDebounced(filters.text, SEARCH_MS);
	const query = useMemo<Omit<GuardLogQuery, "limit" | "before">>(
		() => ({
			...(filters.outcome ? { outcome: filters.outcome } : {}),
			...(filters.by ? { by: filters.by } : {}),
			...(words.trim() ? { text: words } : {}),
		}),
		[filters.outcome, filters.by, words],
	);
	const [items, setItems] = useState<GuardDecision[]>([]);
	const [counts, setCounts] = useState<{ matched: number; total: number } | null>(null);
	const [next, setNext] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	/** Numbers the requests: only the answer to the latest query is used. */
	const generation = useRef(0);
	const loadingRef = useRef(false);
	const queryRef = useRef(query);
	queryRef.current = query;

	const sessions = useApp((s) => s.sessions);
	const bySession = useMemo(() => new Map(sessions.map((s) => [s.file.replace(/\.jsonl$/, ""), s])), [sessions]);

	const load = (before: string | undefined): void => {
		const mine = before ? generation.current : ++generation.current;
		loadingRef.current = true;
		setLoading(true);
		guardApi
			.log({ limit: PAGE, ...(before ? { before } : {}), ...query })
			.then(
				(res) => {
					if (mine !== generation.current) return;
					setItems((kept) =>
						before ? [...kept, ...res.decisions.filter((d) => !kept.some((k) => k.id === d.id))] : res.decisions,
					);
					setCounts({ matched: res.matched, total: res.total });
					setNext(res.next);
					setProblem(null);
				},
				(e) => mine === generation.current && setProblem(e instanceof Error ? e.message : String(e)),
			)
			.finally(() => {
				if (mine !== generation.current) return;
				loadingRef.current = false;
				setLoading(false);
			});
	};

	// The first page again whenever a filter changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `load` reads the query it is made with; the effect runs when that changes.
	useEffect(() => {
		setItems([]);
		setNext(null);
		load(undefined);
	}, [query]);

	// A decision that is made while the page is open: first in the list, when it is one the filters show.
	useEffect(
		() =>
			useGuard.subscribe((s, before) => {
				const d = s.last;
				if (!d || d === before.last) return;
				const matches = decisionMatches(d, queryRef.current);
				if (matches) setItems((kept) => withFirst(kept, [d]));
				setCounts((c) => (c ? { matched: c.matched + (matches ? 1 : 0), total: c.total + 1 } : c));
			}),
		[],
	);

	const scroller = useRef<HTMLDivElement>(null);
	const rows = items.length + (next ? 1 : 0);
	const virtual = useVirtualizer({
		count: rows,
		getScrollElement: () => scroller.current,
		estimateSize: () => ROW_ESTIMATE,
		overscan: 6,
		getItemKey: (i) => items[i]?.id ?? "more",
	});
	const virtualItems = virtual.getVirtualItems();
	const last = virtualItems[virtualItems.length - 1]?.index ?? -1;
	// The end of what is loaded came into view: the next page.
	// biome-ignore lint/correctness/useExhaustiveDependencies: asked once for each position of the end that comes into view.
	useEffect(() => {
		if (next && last >= items.length - 1 && !loadingRef.current) load(next);
	}, [last, next, items.length]);

	const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
	const listId = useId();
	const filtered = Object.keys(query).length > 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 pt-3 sm:px-6" data-testid="guard-log">
			<div className="flex flex-wrap items-end gap-3">
				<label className="block min-w-36 flex-1 text-xs text-muted">
					<span className="mb-1 block">{t("guard.decFilterOutcome")}</span>
					<Select
						tone="compact"
						data-testid="guard-filter-outcome"
						value={filters.outcome}
						onChange={(e) => set({ outcome: e.target.value as GuardOutcome | "" })}
					>
						<option value="">{t("guard.decAll")}</option>
						{GUARD_OUTCOMES.map((o) => (
							<option key={o} value={o}>
								{t(OUTCOME_TEXT[o])}
							</option>
						))}
					</Select>
				</label>
				<label className="block min-w-36 flex-1 text-xs text-muted">
					<span className="mb-1 block">{t("guard.decFilterBy")}</span>
					<Select
						tone="compact"
						data-testid="guard-filter-by"
						value={filters.by}
						onChange={(e) => set({ by: e.target.value as GuardBy | "" })}
					>
						<option value="">{t("guard.decAnyone")}</option>
						{GUARD_BYS.map((b) => (
							<option key={b} value={b}>
								{t(BY_TEXT[b])}
							</option>
						))}
					</Select>
				</label>
				<label className="relative block min-w-48 flex-[2] text-xs text-muted">
					<span className="mb-1 block">{t("guard.decSearch")}</span>
					<Search size={14} className="pointer-events-none absolute bottom-2 left-2.5" aria-hidden />
					<input
						type="search"
						className="h-8 w-full rounded-lg border border-border bg-surface pr-2.5 pl-8 text-xs text-fg outline-none focus-visible:border-faint"
						data-testid="guard-filter-text"
						value={filters.text}
						placeholder={t("guard.decSearchPlaceholder")}
						onChange={(e) => set({ text: e.target.value })}
					/>
				</label>
			</div>

			{/* With nothing decided the empty message below says so: no "0 decisions" line over it. */}
			<p className="text-xs text-muted" role="status" data-testid="guard-log-count">
				{counts === null || counts.total === 0
					? ""
					: filtered
						? t("guard.decCountFiltered", { matched: counts.matched, total: counts.total })
						: t("guard.decCount", { total: counts.total })}
			</p>

			{problem !== null ? (
				<p className="text-xs text-danger" role="alert" data-testid="guard-log-error">
					{t("guard.logFailed", { error: problem })}
				</p>
			) : counts === null ? (
				<p className="flex items-center gap-1.5 text-xs text-muted">
					<Spinner size={12} /> {t("guard.logLoading")}
				</p>
			) : counts.total === 0 ? (
				<p className="text-xs text-muted" data-testid="guard-log-empty">
					{t("guard.logEmpty")}
				</p>
			) : items.length === 0 && !loading ? (
				<p className="text-xs text-muted" data-testid="guard-log-nomatch">
					{t("guard.decNoMatch")}
				</p>
			) : (
				// A region that scrolls is reachable from the keyboard, or its content cannot be read without a mouse.
				<section
					ref={scroller}
					id={listId}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard to be read (axe: scrollable-region-focusable).
					tabIndex={0}
					aria-label={t("guard.decListLabel")}
					className="min-h-0 flex-1 overflow-auto"
					data-testid="guard-log-list"
				>
					<div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
						{virtualItems.map((v) => {
							const d = items[v.index];
							return (
								<div
									key={v.key}
									ref={virtual.measureElement}
									data-index={v.index}
									className="absolute left-0 top-0 w-full pb-2"
									style={{ transform: `translateY(${v.start}px)` }}
								>
									{d ? (
										<DecisionRow d={d} session={bySession.get(conversationOf(d.file))} />
									) : (
										<p className="flex items-center gap-1.5 py-2 text-xs text-muted" data-testid="guard-log-more">
											<Spinner size={12} /> {t("guard.decLoadingMore")}
										</p>
									)}
								</div>
							);
						})}
					</div>
				</section>
			)}
		</div>
	);
}
