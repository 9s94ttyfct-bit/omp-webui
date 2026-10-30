import { SEARCH_LIMIT_MAX, type SearchHit, type SessionSummary } from "@shared/protocol.ts";
import { type RefObject, useEffect, useMemo, useState } from "react";
import { useT } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import { contentMatches, type DateRange, pageOf, rankSessions, type SearchResults } from "../lib/session-search.ts";
import { ProjectFilter } from "./ProjectFilter.tsx";
import { RangeFilter } from "./RangeFilter.tsx";

/** How many conversations one ask for content matches is for, and what "More results" adds (#717). */
const CONTENT_PAGE = 30;
/** The most conversations a page may cover: one past it is asked for too, and the server answers at most its maximum. */
const CONTENT_LAST = SEARCH_LIMIT_MAX - 1;
/** The shortest query asked of the messages: one character is in nearly every one of them. */
const CONTENT_MIN = 2;
/** The pause in typing that asks: a request per keystroke would be dropped by the next one anyway. */
const CONTENT_DEBOUNCE_MS = 250;
/** While the server is still indexing, the messages are asked again this often (as the palette does). */
const INDEXING_RETRY_MS = 3000;

/**
 * The sidebar's search bar: the filter field, the project filter and the date range, and the ranking behind them.
 *
 * It is a chunk of its own: the sidebar is on the first page, and the scorer and the names people call a project are not
 * worth its weight there (a library of conversations is searched many times a day, but the first paint is not one of
 * them). `preload` fetches it as soon as the sidebar has conversations. It owns the three controls and hands the list it
 * comes to up with `onResults`, so the list itself stays the sidebar's.
 */
export function SessionSearch({
	sessions,
	home,
	firstRun,
	onResults,
	focusFirst,
}: {
	/** The conversations there are, before the three filters. */
	sessions: SessionSummary[];
	/** The person's home, so a project is named `~/…` as elsewhere. */
	home: string | undefined;
	/** Nothing to filter yet: the bar is not drawn (the sidebar says how to start instead). */
	firstRun: boolean;
	onResults: (results: SearchResults) => void;
	/** The list's way into its first row, which it fills in: the field's ArrowDown lands there. */
	focusFirst: RefObject<(() => void) | null>;
}) {
	const t = useT();
	const [project, setProject] = useState<string>("all");
	const [filter, setFilter] = useState("");
	const [range, setRange] = useState<DateRange>("all");
	/** One `now` per ranking: the date range must not drift between the rows of one list. */
	const [now, setNow] = useState(() => Date.now());
	const projects = useMemo(() => {
		const m = new Map<string, number>();
		for (const s of sessions) m.set(s.cwd, (m.get(s.cwd) ?? 0) + 1);
		return [...m.entries()].sort((a, b) => b[1] - a[1]);
	}, [sessions]);
	// A filter on a project with no conversation left (its last one was just deleted) is no filter: the dropdown has no
	// such option and shows "All projects", so the list must too.
	const shownProject = project === "all" || projects.some(([cwd]) => cwd === project) ? project : "all";
	useEffect(() => {
		if (shownProject !== project) setProject(shownProject);
	}, [shownProject, project]);
	const ranked = useMemo(
		() => rankSessions(sessions, { query: filter, project: shownProject, range, archived: false }, now),
		[sessions, filter, shownProject, range, now],
	);
	const searching = filter.trim() !== "";
	const query = filter.trim();
	// What was said in the conversations (#717): asked of the server once the typing pauses, a page of conversations at
	// a time. One character is not asked about: it is in nearly every message.
	/** How many conversations to ask for, for which query: a new query starts at one page again. */
	const [page, setPage] = useState({ query: "", limit: CONTENT_PAGE });
	const limit = page.query === query ? page.limit : CONTENT_PAGE;
	const [found, setFound] = useState<{
		query: string;
		limit: number;
		hits: SearchHit[];
		more: boolean;
		/** The ask failed: the name matches stay, and the status line offers to ask again. */
		failed: boolean;
	} | null>(null);
	/** Bumped by "Retry": the same query and page, asked again. */
	const [attempt, setAttempt] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is what asks again.
	useEffect(() => {
		if ([...query].length < CONTENT_MIN) return;
		const stop = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		const ask = () => {
			// One conversation past the page: whether it comes back is whether there are more (#717).
			api.searchConversations(query, limit + 1, stop.signal).then(
				(answer) => {
					setFound({ query, limit, failed: false, ...pageOf(answer.hits, limit) });
					// A library the server is still indexing is asked again, so what was indexed meanwhile shows up.
					if (answer.indexing) timer = setTimeout(ask, INDEXING_RETRY_MS);
				},
				// A search typed past is aborted; one that failed leaves the name matches, which are the list's own.
				() => {
					if (!stop.signal.aborted) setFound({ query, limit, hits: [], more: false, failed: true });
				},
			);
		};
		timer = setTimeout(ask, CONTENT_DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			stop.abort();
		};
	}, [query, limit, attempt]);
	/** The answer for what is typed now: one for an earlier query is not this one's (the list would jump). */
	const current = found && found.query === query && [...query].length >= CONTENT_MIN ? found : null;
	/** The conversations the filters keep whatever was typed: a content match outside them is not listed. */
	const scope = useMemo(
		() =>
			rankSessions(sessions, { query: "", project: shownProject, range, archived: false }, now).map((r) => r.session),
		[sessions, shownProject, range, now],
	);
	const content = useMemo(
		() =>
			current
				? contentMatches(current.hits, scope, new Set(ranked.map((r) => r.session.file)))
				: { sessions: [], hits: new Map() },
		[current, scope, ranked],
	);
	/** The server found more conversations than were asked for: "More results" asks for the next page. */
	const more = current?.more === true;
	/** As many as one search answers are shown, and there are more: a narrower search finds the rest. */
	const capped = more && limit >= CONTENT_LAST;
	const failed = current?.failed === true && current.limit === limit;
	const pendingContent = searching && [...query].length >= CONTENT_MIN && (!current || current.limit !== limit);
	// The list is the sidebar's, and it renders for the filter: the results are sent up after this one is drawn, so that
	// the ranking (and the search) renders once, not twice.
	useEffect(() => {
		onResults({
			sessions: ranked.map((r) => r.session),
			marks: new Map(ranked.filter((r) => r.positions.length).map((r) => [r.session.file, r.positions] as const)),
			searching,
			content: searching ? content.sessions : [],
			hits: searching ? content.hits : new Map(),
		});
	}, [ranked, searching, content, onResults]);
	// A date range is read against the clock: the hour turning over changes what "today" and "7 days" keep.
	useEffect(() => {
		if (range === "all") return;
		const timer = setInterval(() => setNow(Date.now()), 60_000);
		return () => clearInterval(timer);
	}, [range]);
	if (firstRun) return null;
	return (
		<>
			<div className="flex items-center gap-1.5 px-3 pt-2">
				<input
					aria-label={t("shell.sidebarFilterLabel")}
					aria-describedby={searching ? "session-search-status" : undefined}
					data-testid="session-filter"
					placeholder={t("shell.sidebarFilterPlaceholder")}
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					// Esc empties the field before it means anything else (a search is not a dialog).
					onKeyDown={(e) => {
						if (e.key === "Escape" && filter !== "") {
							e.preventDefault();
							e.stopPropagation();
							setFilter("");
						}
						// Down from the field is into the results: the first one, focused, so the arrows and Enter walk them.
						if (e.key === "ArrowDown" && filter.trim() !== "" && ranked.length + content.sessions.length) {
							e.preventDefault();
							focusFirst.current?.();
						}
					}}
					className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 text-sm outline-none placeholder:text-faint focus:border-faint"
				/>
				<ProjectFilter
					value={shownProject}
					onChange={setProject}
					total={sessions.length}
					projects={projects}
					home={home}
				/>
				<RangeFilter value={range} onChange={setRange} />
			</div>
			{/* How many the search found, and how it is moved through: a search the keyboard can walk, as the palette's. */}
			{searching ? (
				<div
					id="session-search-status"
					role="status"
					data-testid="session-search-status"
					className="flex items-center justify-between gap-2 px-3 pt-1.5 text-xs text-faint"
				>
					<span>{t("shell.sidebarSearchCount", { n: ranked.length + content.sessions.length })}</span>
					{pendingContent ? (
						<span className="truncate" data-testid="session-search-pending">
							{t("shell.sidebarSearchingMessages")}
						</span>
					) : failed ? (
						<button
							type="button"
							data-testid="session-search-retry"
							onClick={() => {
								// "Searching messages…" again until the answer.
								setFound(null);
								setAttempt((n) => n + 1);
							}}
							className="truncate rounded px-1 text-danger hover:underline"
						>
							{t("shell.sidebarSearchFailed")}
						</button>
					) : capped ? (
						<span className="truncate" data-testid="session-search-capped">
							{t("shell.sidebarSearchCapped", { n: limit })}
						</span>
					) : more ? (
						// The server found as many conversations as were asked for: there may be more, a page at a time.
						<button
							type="button"
							data-testid="session-search-more"
							onClick={() => setPage({ query, limit: Math.min(limit + CONTENT_PAGE, CONTENT_LAST) })}
							className="shrink-0 rounded px-1 text-accent hover:underline"
						>
							{t("shell.sidebarSearchMore")}
						</button>
					) : ranked.length + content.sessions.length > 0 ? (
						// The keys move through matches: with none there is nothing for them to do.
						<span className="truncate">{t("shell.sidebarSearchHint")}</span>
					) : null}
				</div>
			) : null}
		</>
	);
}
