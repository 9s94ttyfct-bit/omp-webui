import type { SessionSummary } from "@shared/protocol.ts";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
	type FocusEvent,
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	type RefObject,
	useMemo,
	useRef,
} from "react";
import { useT } from "../i18n/index.ts";
import type { ContentMatch } from "../lib/session-search.ts";
import { type LiveDot, type SessionAction, SessionItem } from "./SessionItem.tsx";
import { cx } from "./ui.tsx";

/** Rows rendered beyond the ones in view, so a scroll shows rows that are already there. */
const OVERSCAN = 10;
/**
 * A list this short is drawn whole: windowing earns its keep over hundreds of rows, and below that every row being in
 * the page keeps the page as it was (find-in-page, a screen reader's list, tests that look rows up by name).
 */
const WINDOW_FROM = 200;
/** Sizes until a row is measured; rows are one line, a date heading a little more. */
const ROW_HEIGHT = 32;
/** A content match's row (#717) has the line of the message under its name. */
const HIT_ROW_HEIGHT = 50;
const HEADING_HEIGHT = 32;
const TITLE_HEIGHT = 28;

type Entry =
	| { kind: "title"; key: string }
	| { kind: "heading"; key: string; label: string; fold?: boolean }
	| { kind: "session"; key: string; session: SessionSummary };

/** The group whose heading folds it (the Pinned one, #700): its name, whether it is folded, and how many rows it has. */
export interface FoldableGroup {
	label: string;
	folded: boolean;
	count: number;
	onToggle: () => void;
}

const ROW = '[data-testid="session-item"]';
const MENU = '[data-testid="session-menu"]';

interface Props {
	/** The rows by date group, in display order. */
	groups: [string, SessionSummary[]][];
	/** The archive's own title above the rows. */
	showArchived: boolean;
	/** Where the filter matched each row's name, by file: the row marks those characters. */
	marks?: ReadonlyMap<string, readonly number[]>;
	/**
	 * The conversations found by what was said in them, by file (#717): the row shows the matching line. Their group is
	 * headed even in a search's results: the heading says why they are listed.
	 */
	hits?: ReadonlyMap<string, ContentMatch>;
	/**
	 * How the caller moves the keyboard from the filter field into the list: the sidebar sets `current` to a function
	 * that puts focus on the first row, whatever is drawn (a list scrolled far down has no first row in the page).
	 */
	focusFirst?: RefObject<(() => void) | null>;
	/**
	 * A search's results: the rows are in the order the search ranked them, so they are drawn as one list and the date
	 * headings are left out (a date would cut a ranking into pieces).
	 */
	ranked?: boolean;
	/** What shows in place of the rows (the spinner, the error, "nothing here") and before them. */
	before: ReactNode;
	/** The list's actions (Select, the archive), drawn at the right of its first line. */
	actions?: ReactNode;
	/** The group a click on its heading folds and unfolds. */
	foldable?: FoldableGroup;
	activeFile: string | null;
	pinSet: ReadonlySet<string>;
	archivedSet: ReadonlySet<string>;
	liveFiles: ReadonlyMap<string, LiveDot>;
	selecting: boolean;
	selected: ReadonlySet<string>;
	onOpen: (file: string) => void;
	onTogglePin: (file: string) => void;
	onToggleArchive: (file: string) => void;
	onAction: (session: SessionSummary, action: SessionAction, trigger: HTMLElement | null) => void;
	onSelect: (file: string, e: MouseEvent) => void;
}

/**
 * The sidebar's list of conversations. Past `WINDOW_FROM` entries only the rows in view (and a few around them) are
 * in the page: a library of thousands is a few dozen rows of DOM however long it is, and typing in the filter or switching the palette
 * renders those, not all of them. The rest of the list behaves as if it were all there:
 *
 * - Tab, Shift+Tab, the arrow keys, Home and End move from row to row through the whole list: a row that is not
 *   in the page yet is scrolled to and focused.
 * - The row that has focus stays in the page when it is scrolled out of view, so focus is not lost.
 * - Date groups, pins and selection are the sidebar's; this only decides what is drawn.
 */
export function SessionList({
	groups,
	showArchived,
	marks,
	hits,
	ranked,
	focusFirst,
	before,
	actions,
	foldable,
	activeFile,
	pinSet,
	archivedSet,
	liveFiles,
	selecting,
	selected,
	onOpen,
	onTogglePin,
	onToggleArchive,
	onAction,
	onSelect,
}: Props) {
	const t = useT();
	const navRef = useRef<HTMLElement>(null);
	const entries = useMemo<Entry[]>(() => {
		const out: Entry[] = [];
		if (showArchived && groups.length) out.push({ kind: "title", key: "title" });
		for (const [label, list] of groups) {
			// A search's results are one ranked list: its groups are the caller's order, not dates to head. The content
			// matches are the exception: they are not name matches, and the heading says so.
			const found = list[0] !== undefined && hits?.has(list[0].file) === true;
			if (!ranked || found)
				out.push({ kind: "heading", key: `heading:${label}`, label, fold: foldable?.label === label });
			for (const session of list) out.push({ kind: "session", key: session.file, session });
		}
		return out;
	}, [groups, showArchived, ranked, foldable?.label, hits]);
	const indexOfFile = useMemo(() => {
		const m = new Map<string, number>();
		entries.forEach((e, i) => {
			if (e.kind === "session") m.set(e.session.file, i);
		});
		return m;
	}, [entries]);
	/** The row that has focus, if any: it stays rendered whatever the scroll position. */
	const focused = useRef<string | null>(null);
	const indexOfFocused = useRef(indexOfFile);
	indexOfFocused.current = indexOfFile;

	const virtualizer = useVirtualizer({
		count: entries.length,
		getScrollElement: () => navRef.current,
		estimateSize: (i) => {
			const entry = entries[i];
			if (entry?.kind === "session") return hits?.has(entry.session.file) ? HIT_ROW_HEIGHT : ROW_HEIGHT;
			return entry?.kind === "heading" ? HEADING_HEIGHT : TITLE_HEIGHT;
		},
		getItemKey: (i) => entries[i]?.key ?? i,
		overscan: OVERSCAN,
		rangeExtractor: (range) => {
			if (entries.length <= WINDOW_FROM) return Array.from({ length: entries.length }, (_, i) => i);
			const shown = defaultRangeExtractor(range);
			const at = focused.current === null ? undefined : indexOfFocused.current.get(focused.current);
			return at === undefined || shown.includes(at) ? shown : [...shown, at].sort((a, b) => a - b);
		},
	});

	/** The nearest session row from `from` in `step` direction (headings are not rows), or null. */
	const sessionFrom = (from: number, step: 1 | -1): number | null => {
		for (let i = from + step; i >= 0 && i < entries.length; i += step) if (entries[i]?.kind === "session") return i;
		return null;
	};
	/** Scroll to row `index`, wait for it to be drawn and give it focus (its menu button or the row itself). */
	const focusRow = (index: number, part: "row" | "menu") => {
		virtualizer.scrollToIndex(index);
		let frames = 0;
		const attempt = () => {
			const wrap = navRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
			const target =
				wrap?.querySelector<HTMLElement>(part === "menu" ? MENU : ROW) ?? wrap?.querySelector<HTMLElement>(ROW);
			if (target) target.focus();
			else if (frames++ < 30) requestAnimationFrame(attempt);
		};
		attempt();
	};
	// The filter's ArrowDown lands on the first row, after the list has scrolled to it: a row off screen is not in the page.
	const focusFirstRow = () => {
		const first = sessionFrom(-1, 1);
		if (first !== null) focusRow(first, "row");
	};
	if (focusFirst) focusFirst.current = focusFirstRow;
	const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
		if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
		const target = e.target as HTMLElement;
		const wrap = target.closest<HTMLElement>("[data-row-file]");
		const onRow = target.matches(ROW);
		const onMenu = target.matches(MENU);
		if (!wrap || (!onRow && !onMenu)) return;
		const index = Number(wrap.dataset.index);
		const go = (to: number | null, part: "row" | "menu") => {
			if (to === null) return;
			e.preventDefault();
			focusRow(to, part);
		};
		switch (e.key) {
			case "ArrowDown":
				return go(sessionFrom(index, 1), "row");
			case "ArrowUp":
				return go(sessionFrom(index, -1), "row");
			case "Home":
				return go(sessionFrom(-1, 1), "row");
			case "End":
				return go(sessionFrom(entries.length, -1), "row");
			// Tab goes row, menu button, next row, ...: the stops between two rows are the list's to place, because the
			// next row may not be in the page.
			case "Tab":
				if (!e.shiftKey && (onMenu || selecting)) return go(sessionFrom(index, 1), "row");
				if (e.shiftKey && onRow) return go(sessionFrom(index, -1), selecting ? "row" : "menu");
				return;
		}
	};
	const onFocus = (e: FocusEvent<HTMLElement>) => {
		focused.current = (e.target as HTMLElement).closest<HTMLElement>("[data-row-file]")?.dataset.rowFile ?? null;
	};
	const onBlur = (e: FocusEvent<HTMLElement>) => {
		// Focus moving to another row (or the row's menu) is a blur followed by a focus; only leaving the list counts.
		if (!(e.relatedTarget instanceof Node && navRef.current?.contains(e.relatedTarget))) focused.current = null;
	};

	return (
		<nav
			ref={navRef}
			className="@container mt-1 min-h-32 flex-1 overflow-y-auto px-2 pb-2"
			data-testid="session-list"
			onKeyDown={onKeyDown}
			onFocus={onFocus}
			onBlur={onBlur}
		>
			{!entries.length && (showArchived || actions) ? (
				<ListHeading first caps label={showArchived ? t("shell.sidebarArchived") : ""} actions={actions} />
			) : null}
			{before}
			{entries.length ? (
				<div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
					{virtualizer.getVirtualItems().map((v) => {
						const entry = entries[v.index];
						if (!entry) return null;
						return (
							<div
								key={entry.key}
								ref={virtualizer.measureElement}
								data-index={v.index}
								data-row-file={entry.kind === "session" ? entry.session.file : undefined}
								className="absolute top-0 left-0 w-full"
								style={{ transform: `translateY(${v.start}px)` }}
							>
								{entry.kind === "title" ? (
									<ListHeading
										first={v.index === 0}
										caps
										label={t("shell.sidebarArchived")}
										actions={v.index === 0 ? actions : null}
									/>
								) : entry.kind === "heading" ? (
									<ListHeading
										first={v.index === 0}
										label={entry.label}
										actions={v.index === 0 ? actions : null}
										fold={entry.fold ? foldable : undefined}
									/>
								) : (
									<SessionItem
										session={entry.session}
										mark={marks?.get(entry.session.file)}
										snippet={hits?.get(entry.session.file)?.snippet}
										active={activeFile === entry.session.file}
										pinned={pinSet.has(entry.session.file)}
										archived={archivedSet.has(entry.session.file)}
										liveState={liveFiles.get(entry.session.file)}
										onOpen={onOpen}
										onTogglePin={onTogglePin}
										onToggleArchive={onToggleArchive}
										onAction={onAction}
										selecting={selecting}
										selected={selected.has(entry.session.file)}
										onSelect={onSelect}
									/>
								)}
							</div>
						);
					})}
				</div>
			) : null}
		</nav>
	);
}

/**
 * One line of the list: a date group's name (or the archive's title) and, on the first line of the list, the list's
 * actions at the right (Select, the archive), so that they take no row of their own above it.
 *
 * The name keeps its full width (`min-w-min`): the date is the only thing that says which group a row is in, and a
 * stub of it ("T…") says nothing. The actions are one group that moves to a second line when the name and the
 * actions do not both fit, which only happens in the narrowest sidebar.
 */
function ListHeading({
	label,
	actions,
	first,
	caps,
	fold,
}: {
	label: string;
	actions: ReactNode;
	first: boolean;
	caps?: boolean;
	/** The heading folds its group: it is a button that says so, with how many rows are hidden while it is folded. */
	fold?: FoldableGroup;
}) {
	const t = useT();
	const name = cx("min-w-min flex-1 truncate text-xs font-medium text-faint", caps && "tracking-wide uppercase");
	return (
		<div className={cx("flex flex-wrap items-center gap-1 px-2.5", first ? "pt-1 pb-0.5" : "pt-3 pb-1")}>
			{fold ? (
				<button
					type="button"
					className={cx(name, "-ml-1 flex items-center gap-0.5 rounded px-1 text-left hover:text-fg")}
					aria-expanded={!fold.folded}
					title={t(fold.folded ? "shell.sidebarPinnedUnfold" : "shell.sidebarPinnedFold")}
					data-testid="pinned-fold"
					onClick={fold.onToggle}
				>
					{fold.folded ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
					{label}
					{fold.folded ? <span className="ml-1 tabular-nums">{fold.count}</span> : null}
				</button>
			) : (
				<span className={name}>{label}</span>
			)}
			{actions ? <span className="flex shrink-0 items-center gap-1">{actions}</span> : null}
		</div>
	);
}
