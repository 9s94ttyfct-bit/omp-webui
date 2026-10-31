import { working } from "@shared/attention.ts";
import type { SessionSummary } from "@shared/protocol.ts";
import {
	Archive,
	ArchiveRestore,
	ArrowLeft,
	ArrowUpDown,
	ListChecks,
	MessageSquarePlus,
	PanelLeftClose,
	Search,
	Trash2,
} from "lucide-react";
import {
	type CSSProperties,
	type MouseEvent,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useT } from "../i18n/index.ts";
import { api, sessionActions } from "../lib/api.ts";
import { setArchived } from "../lib/archive.ts";
import { forgetDraft } from "../lib/drafts.ts";
import { dateGroup } from "../lib/format.ts";
import { lazyChunk } from "../lib/lazy-chunk.ts";
import { useLayout } from "../lib/panel-widths.ts";
import {
	SESSION_SORTS,
	type SessionSort,
	sessionGroups,
	setPinnedFolded,
	setSessionSort,
	usePinnedFolded,
	useSessionSort,
} from "../lib/session-order.ts";
import type { SearchResults } from "../lib/session-search.ts";
import { useShortcutLabel } from "../lib/shortcuts.ts";
import { useStable } from "../lib/stable.ts";
import { dismissOverlays, liveFor, refreshState, useApp } from "../store/app.ts";
import type { LiveState } from "../store/live.ts";
import { HostChip } from "./HostChip.tsx";
import { LoadError } from "./LoadError.tsx";
import { MachineChip } from "./MachineChip.tsx";
import { NavGroup } from "./NavDock.tsx";
import { RemoteIndicator } from "./RemoteIndicator.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { Select } from "./Select.tsx";
import { type LiveDot, type SessionAction, sessionLabel } from "./SessionItem.tsx";
import { SessionList } from "./SessionList.tsx";
import { StarPrompt } from "./StarPrompt.tsx";
import { UpdateIndicator } from "./UpdateIndicator.tsx";
import { Button, cx, IconButton, Kbd, Modal, Spinner } from "./ui.tsx";

// The search bar, the scorer behind it and their strings: a chunk of its own, fetched as soon as there are conversations
// to search (the sidebar is the first page, and none of this belongs in it).
const { Chunk: SessionSearch, preload: preloadSearch } = lazyChunk(() =>
	import("./SessionSearch.tsx").then((m) => ({ default: m.SessionSearch })),
);

/** How many titles the bulk-delete confirmation lists before it sums up the rest. */
const BULK_LIST_MAX = 8;

/** The name each order of the list has in its select (#701). */
const SORT_LABEL = {
	activity: "shell.sidebarSortActivity",
	created: "shell.sidebarSortCreated",
	title: "shell.sidebarSortTitle",
} as const satisfies Record<SessionSort, string>;

/** What each conversation's omp process is doing, by session file (the agent graph's list reads it too). */
export function liveDotsOf(lives: Record<string, LiveState>): Record<string, LiveDot> {
	const dots: Record<string, LiveDot> = {};
	for (const l of Object.values(lives)) {
		if (l.info.exited || !l.info.sessionFile) continue;
		// A pending dialog (tool approval, question) means omp waits for the user rather than works. A conversation held at its
		// provider's quota floor (#652) waits for the reset, which is not progress either, but a person's answer comes first.
		dots[l.info.sessionFile] = l.info.pausedAt
			? "paused"
			: l.needsInput
				? "needsInput"
				: l.info.quotaHold?.state === "held"
					? "quotaHeld"
					: working(l)
						? "running"
						: "open";
	}
	return dots;
}
export function Sidebar() {
	const t = useT();
	const newChatHint = useShortcutLabel("newChat");
	const searchHint = useShortcutLabel("search");
	// Selected one by one: a streamed token changes `lives`, and the list must not render again for it.
	const {
		sessions,
		sessionsLoaded,
		view,
		setView,
		set,
		connected,
		meta,
		pins,
		archived,
		showArchived,
		toast,
		loadSessions,
	} = useApp(
		useShallow((s) => ({
			sessions: s.sessions,
			sessionsLoaded: s.sessionsLoaded,
			view: s.view,
			setView: s.setView,
			set: s.set,
			connected: s.connected,
			meta: s.meta,
			pins: s.pins,
			archived: s.archived,
			showArchived: s.sidebarArchived,
			toast: s.toast,
			loadSessions: s.loadSessions,
		})),
	);
	const setShowArchived = useCallback((on: boolean) => set({ sidebarArchived: on }), [set]);
	// Equal for every token of a streamed reply (only a process starting, stopping, asking or pausing changes it).
	const liveDots = useApp(useShallow((s) => liveDotsOf(s.lives)));
	const [selecting, setSelecting] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [anchor, setAnchor] = useState<string | null>(null);
	const [bulkDelete, setBulkDelete] = useState<SessionSummary[] | null>(null);
	const liveFiles = useMemo(() => new Map(Object.entries(liveDots)), [liveDots]);
	const archivedSet = useMemo(() => new Set(archived), [archived]);
	/**
	 * What the search bar (a chunk of its own, see `SessionSearch`) came to: the conversations to list, where the query
	 * matched each name, and whether a query is narrowing them. Until it is asked for, this is everything.
	 */
	const [results, setResults] = useState<SearchResults | null>(null);
	const onResults = useCallback((next: SearchResults) => setResults(next), []);
	/** The list's way into its first row, which it fills in: the search field's ArrowDown lands there. */
	const focusFirstRow = useRef<(() => void) | null>(null);
	// A row of the archive is not a row of the search's list (and the search would list it only to hide it again).
	const pool = useMemo(
		() =>
			sessions.filter((s) => archivedSet.has(s.file) === showArchived && (s.messageCount > 0 || liveFiles.has(s.file))),
		[sessions, archivedSet, showArchived, liveFiles],
	);
	/** The conversations the list shows, once the search bar has had its say (or all of them, while it has not). */
	const visible = results ? results.sessions : pool;
	/** Where the filter matched each row's name: the row marks the characters. */
	const marks = results?.marks;
	const searching = results?.searching ?? false;
	/** The conversations found by what was said in them (#717): their own group, after every name match. */
	const content = results?.content;
	/** The message each of `content` matched in: its row shows the line and opens the conversation there. */
	const hits = results?.hits;
	// The bar is fetched as soon as there is something to search: by the time the pointer reaches the field, it is there.
	const hasSessions = sessionsLoaded && sessions.some((s) => s.messageCount > 0);
	useEffect(() => {
		if (hasSessions) preloadSearch();
	}, [hasSessions]);
	const archivedCount = useMemo(() => sessions.filter((s) => archivedSet.has(s.file)).length, [sessions, archivedSet]);
	/** No conversation exists yet: there is nothing to filter, so the sidebar says how to start instead. */
	const firstRun = sessionsLoaded && !sessions.some((s) => s.messageCount > 0 || liveFiles.has(s.file));
	// With nothing to list there is no way back from the archive view (the first-run sidebar has no actions), and the first conversation would appear in it.
	useEffect(() => {
		if (firstRun && showArchived) set({ sidebarArchived: false });
	}, [firstRun, showArchived, set]);
	const activeFile = view.kind === "chat" ? view.file : null;
	const pinSet = useMemo(() => new Set(pins), [pins]);
	const sort = useSessionSort();
	const pinnedFolded = usePinnedFolded();
	/** The conversations working now (#699): first after the pinned ones, whatever the order. */
	const workingFiles = useMemo(() => {
		const out = new Set<string>();
		for (const [file, dot] of liveFiles)
			if (dot === "running" || dot === "needsInput" || dot === "quotaHeld") out.add(file);
		return out;
	}, [liveFiles]);
	// Also invalidates `groups` when the language changes (dateGroup reads the language itself).
	const pinnedLabel = t("shell.sidebarPinned");
	const byNameLabel = t("shell.sidebarByName");
	const inMessagesLabel = t("shell.sidebarInMessages");
	const groups = useMemo(() => {
		const named = sessionGroups({
			sessions: visible,
			pins,
			sort,
			working: workingFiles,
			dateOf: dateGroup,
			today: dateGroup(Date.now()),
			pinnedLabel,
			byNameLabel,
			ranked: searching,
			pinnedFolded,
		});
		// Content matches are not grouped with the names: every name match comes first, a pinned content match too.
		return content?.length ? [...named, [inMessagesLabel, content] as [string, SessionSummary[]]] : named;
	}, [visible, pins, sort, workingFiles, pinnedLabel, byNameLabel, searching, pinnedFolded, content, inMessagesLabel]);
	/** How many pinned conversations the list holds: what the folded Pinned heading says it hides (#700). */
	const pinnedCount = useMemo(() => {
		const shown = new Set(visible.map((s) => s.file));
		return pins.filter((f) => shown.has(f)).length;
	}, [visible, pins]);
	/** Rows in display order: the range a shift-click selects, and the only rows the selection acts on. */
	const rows = useMemo(() => groups.flatMap(([, list]) => list), [groups]);
	const order = useMemo(() => rows.map((s) => s.file), [rows]);
	/** The selected rows that are showing. A filter can hide selected rows; what is not shown is not counted or acted on. */
	const chosen = useMemo(() => rows.filter((s) => selected.has(s.file)), [rows, selected]);

	const [pending, setPending] = useState<{
		action: SessionAction;
		session: SessionSummary;
		title: string;
		/** The row's menu button, which gets focus back when the dialog closes. */
		returnTo: HTMLElement | null;
	} | null>(null);
	const [working, setWorking] = useState(false);
	// omp refuses to delete a conversation that is replying or waiting (the server answers 409): the dialog says so first.
	const pendingDot = pending ? liveFiles.get(pending.session.file) : undefined;
	const deleteBusy =
		pending?.action === "delete" &&
		(pendingDot === "running" || pendingDot === "needsInput" || pendingDot === "paused");
	const togglePin = (file: string) =>
		void sessionActions
			.setPin(file, !pinSet.has(file))
			.then((next) => set({ pins: next }))
			.catch((e) => toast("error", e.message));

	const stopSelecting = () => {
		setSelecting(false);
		setSelected(new Set());
		setAnchor(null);
	};
	// Esc leaves selection mode. Esc inside a dialog (or popover) belongs to that dialog: it closes, selection stays.
	// The target is the test, not `defaultPrevented`: a tooltip that reopens on the restored focus also takes Esc.
	useEffect(() => {
		if (!selecting) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			if (e.target instanceof Element && e.target.closest('[role="dialog"], [role="alertdialog"]')) return;
			// An overlay opened over the list takes this Escape, even before it has registered as the top layer.
			if (dismissOverlays()) return;
			setSelecting(false);
			setSelected(new Set());
			setAnchor(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [selecting]);
	const select = (file: string, e: MouseEvent) => {
		const next = new Set(selected);
		if (e.shiftKey && anchor && order.includes(anchor)) {
			const [a, b] = [order.indexOf(anchor), order.indexOf(file)].sort((x, y) => x - y);
			for (const f of order.slice(a, b + 1)) next.add(f);
		} else if (next.has(file)) next.delete(file);
		else next.add(file);
		setSelected(next);
		setAnchor(file);
	};

	const confirmPending = async () => {
		if (!pending || deleteBusy) return;
		setWorking(true);
		try {
			if (pending.action === "rename") {
				await sessionActions.rename(pending.session.file, pending.title.trim());
				// A running chat shows omp's in-memory name; set_session_name emits no frames.
				const live = liveFor(pending.session.file);
				if (live) await refreshState(live.info.liveId);
			} else {
				await sessionActions.remove(pending.session.file);
				forgetDraft(pending.session.file);
				if (activeFile === pending.session.file) setView({ kind: "new" });
			}
			await loadSessions();
			setPending(null);
		} catch (e) {
			toast(
				"error",
				t(pending.action === "rename" ? "shell.sidebarRenameFailed" : "shell.sidebarDeleteFailed", {
					error: (e as Error).message,
				}),
			);
		} finally {
			setWorking(false);
		}
	};
	const confirmBulkDelete = async () => {
		if (!bulkDelete) return;
		setWorking(true);
		try {
			const r = await sessionActions.removeMany(bulkDelete.map((s) => s.file));
			for (const file of r.deleted) forgetDraft(file);
			if (activeFile && r.deleted.includes(activeFile)) setView({ kind: "new" });
			if (r.failed.length)
				toast("error", t("shell.sidebarBulkDeleteFailed", { n: r.failed.length, error: r.failed[0].error }));
			await loadSessions();
			// omp can report a failure for a delete that did remove the file: whatever the list no longer has is gone.
			const left = new Set(useApp.getState().sessions.map((s) => s.file));
			for (const s of bulkDelete) if (!left.has(s.file)) forgetDraft(s.file);
			setBulkDelete(null);
			stopSelecting();
		} catch (e) {
			toast("error", t("shell.sidebarDeleteFailed", { error: (e as Error).message }));
		} finally {
			setWorking(false);
		}
	};

	// The rows are memoized: these never change identity (each runs the latest code), so a row renders again only
	// when what it shows changed, not whenever the sidebar does (typing in the filter, a session list reload).
	const openRow = useStable((file: string) => {
		// The end of the conversation is asked for before the code that shows it is loaded.
		api.prefetchTail(file);
		// A conversation found by what was said in it opens at that message, as the palette's message hits do (#717).
		const at = hits?.get(file)?.entryId;
		setView(
			at ? { kind: "chat", file, liveId: null, focus: at, focusAt: Date.now() } : { kind: "chat", file, liveId: null },
		);
	});
	const pinRow = useStable((file: string) => togglePin(file));
	const archiveRow = useStable((file: string) => void setArchived([file], !archivedSet.has(file)));
	const actionRow = useStable((session: SessionSummary, action: SessionAction, returnTo: HTMLElement | null) =>
		setPending({ action, session, title: sessionLabel(session), returnTo }),
	);
	const selectRow = useStable((file: string, e: MouseEvent) => select(file, e));

	/** A page through the tunnel is not offered what only this Mac may change; until `meta` says so the page is taken for this Mac's, so the Guard's row is not added later (a move of the page) for the usual page. */
	const remotePage = meta?.remote === true;
	const toolButton =
		"inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted hover:bg-hover hover:text-fg aria-pressed:bg-hover aria-pressed:text-fg";
	const listButton =
		"inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted hover:bg-hover hover:text-fg aria-pressed:bg-hover aria-pressed:text-fg";
	const archivedLabel = archivedCount
		? t("shell.sidebarArchivedCount", { n: archivedCount })
		: t("shell.sidebarArchived");
	/** What the list's first line carries at its right: its own row under the filter would push the list down. */
	const listActions = firstRun ? null : (
		<>
			{showArchived ? (
				<button
					type="button"
					className={listButton}
					data-testid="show-all-sessions"
					onClick={() => {
						setShowArchived(false);
						stopSelecting();
					}}
				>
					<ArrowLeft size={12} /> {t("shell.sidebarAllConversations")}
				</button>
			) : (
				// Always there (#707): without it the archive had no place until something was in it. The label gives way to the
				// icon and the count where the sidebar is narrow (its container, not the window), which is what keeps Select beside it.
				<button
					type="button"
					className={listButton}
					data-testid="show-archived"
					aria-label={archivedLabel}
					title={archivedLabel}
					onClick={() => {
						setShowArchived(true);
						stopSelecting();
					}}
				>
					<Archive size={12} aria-hidden />
					<span className="hidden @[256px]:inline">{archivedLabel}</span>
					{archivedCount ? <span className="tabular-nums @[256px]:hidden">{archivedCount}</span> : null}
				</button>
			)}
			{/*
			 * The order of the list (#701): the app's select laid invisibly over its icon, so it takes no more of the list's
			 * first line than an icon (the narrowest sidebar still fits Select beside it); the headings show the order, and so
			 * does the tooltip.
			 */}
			<span
				className={cx(listButton, "relative focus-within:bg-hover focus-within:text-fg")}
				title={`${t("shell.sidebarSort")}: ${t(SORT_LABEL[sort])}`}
			>
				<ArrowUpDown size={13} aria-hidden />
				<Select
					tone="overlay"
					aria-label={t("shell.sidebarSort")}
					data-testid="session-sort"
					value={sort}
					onValueChange={(v) => setSessionSort(v as SessionSort)}
				>
					{SESSION_SORTS.map((s) => (
						<option key={s} value={s}>
							{t(SORT_LABEL[s])}
						</option>
					))}
				</Select>
			</span>
			<button
				type="button"
				className={listButton}
				aria-pressed={selecting}
				aria-label={t("shell.sidebarSelectAria")}
				data-testid="select-sessions"
				onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
			>
				<ListChecks size={13} /> {t("shell.sidebarSelect")}
			</button>
		</>
	);
	return (
		<SidebarFrame>
			<div className="flex items-center gap-1 px-3 pt-3 pb-2">
				<button
					type="button"
					className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-hover"
					onClick={() => setView({ kind: "new" })}
				>
					<img src="/favicon.png" alt="" className="h-6 w-6" />
					<span className="text-[15px] font-semibold tracking-tight">omp</span>
				</button>
				<span
					className={cx("ml-1 h-2 w-2 rounded-full", connected ? "bg-success" : "bg-danger")}
					title={connected ? t("shell.sidebarConnected") : t("shell.sidebarDisconnected")}
				/>
				<span className="flex-1" />
				<IconButton
					label={searchHint ? t("shell.sidebarSearch", { keys: searchHint }) : t("shell.paletteTitle")}
					onClick={() => set({ paletteOpen: true })}
				>
					<Search size={16} />
				</IconButton>
				<IconButton label={t("shell.sidebarHide")} onClick={() => set({ sidebarOpen: false })}>
					<PanelLeftClose size={16} />
				</IconButton>
			</div>
			<div className="px-3">
				<button
					type="button"
					data-testid="new-chat"
					className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium shadow-sm hover:bg-hover"
					onClick={() => setView({ kind: "new" })}
				>
					<MessageSquarePlus size={16} className="text-accent" /> {t("shell.sidebarNewChat")}
					{newChatHint ? (
						<span className="ml-auto">
							<Kbd>{newChatHint}</Kbd>
						</span>
					) : null}
				</button>
			</div>
			<MachineChip />
			{/* The pages the person put on top of the list (#654): none until they do. */}
			<div className="px-3">
				<NavGroup variant="rows" surface="sidebar" group="top" remote={remotePage} />
			</div>
			{/* The search bar, its strings and the scorer travel in a chunk of their own: the sidebar is the first page. */}
			<Suspense fallback={null}>
				<SessionSearch
					sessions={pool}
					home={meta?.home}
					firstRun={firstRun}
					onResults={onResults}
					focusFirst={focusFirstRow}
				/>
			</Suspense>
			<SessionList
				groups={groups}
				showArchived={showArchived}
				marks={marks}
				hits={hits}
				ranked={searching}
				focusFirst={focusFirstRow}
				actions={listActions}
				foldable={
					pinnedCount
						? {
								label: pinnedLabel,
								folded: pinnedFolded,
								count: pinnedCount,
								onToggle: () => setPinnedFolded(!pinnedFolded),
							}
						: undefined
				}
				before={
					<>
						{!sessionsLoaded ? <SessionsPending /> : null}
						{sessionsLoaded && !visible.length ? (
							firstRun ? (
								<div className="px-4 py-8 text-center" data-testid="sidebar-onboarding">
									<MessageSquarePlus size={22} className="mx-auto mb-2 text-accent" aria-hidden />
									<div className="text-sm font-medium">{t("shell.sidebarFirstRunTitle")}</div>
									<p className="mt-1 text-xs text-muted">{t("shell.sidebarFirstRunHint")}</p>
								</div>
							) : showArchived && !archivedCount ? (
								<div className="px-4 py-8 text-center" data-testid="sidebar-archived-empty">
									<Archive size={22} className="mx-auto mb-2 text-faint" aria-hidden />
									<div className="text-sm font-medium">{t("shell.sidebarArchivedEmpty")}</div>
									<p className="mt-1 text-xs text-muted">{t("shell.sidebarArchivedHint")}</p>
								</div>
							) : (
								<div className="px-3 py-6 text-center text-xs text-muted" data-testid="sidebar-empty">
									{showArchived
										? t("shell.sidebarArchivedEmpty")
										: results?.searching
											? t("shell.sidebarNoMatch")
											: t("shell.sidebarEmpty")}
								</div>
							)
						) : null}
					</>
				}
				activeFile={activeFile}
				pinSet={pinSet}
				archivedSet={archivedSet}
				liveFiles={liveFiles}
				selecting={selecting}
				selected={selected}
				onOpen={openRow}
				onTogglePin={pinRow}
				onToggleArchive={archiveRow}
				onAction={actionRow}
				onSelect={selectRow}
			/>
			{selecting ? (
				// Two rows: what is chosen and how to choose, then what to do with it. The actions say what they do in words:
				// two icons alone beside "All" were a guess.
				<div
					className="space-y-1.5 border-t border-border bg-surface px-2 py-2"
					role="toolbar"
					aria-label={t("shell.sidebarSelectAria")}
					data-testid="selection-bar"
				>
					<div className="flex items-center gap-1">
						<span className="px-1.5 text-xs tabular-nums text-muted" data-testid="selection-count">
							{t("shell.sidebarSelected", { n: chosen.length })}
						</span>
						<span className="flex-1" />
						<button type="button" className={toolButton} onClick={() => setSelected(new Set(order))}>
							{t("shell.sidebarSelectAll")}
						</button>
						<Button size="sm" variant="ghost" onClick={stopSelecting}>
							{t("shell.sidebarDoneSelecting")}
						</Button>
					</div>
					<div className="flex gap-1.5">
						<Button
							size="sm"
							className="flex-1"
							disabled={!chosen.length}
							data-testid="selection-archive"
							onClick={() =>
								void setArchived(
									chosen.map((s) => s.file),
									!showArchived,
								).then((ok) => ok && stopSelecting())
							}
						>
							{showArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}{" "}
							{showArchived ? t("shell.sidebarUnarchiveSelected") : t("shell.sidebarArchiveSelected")}
						</Button>
						<Button
							size="sm"
							variant="danger"
							className="flex-1"
							disabled={!chosen.length}
							data-testid="selection-delete"
							onClick={() => setBulkDelete(chosen)}
						>
							<Trash2 size={14} /> {t("shell.sidebarDeleteSelected")}
						</Button>
					</div>
				</div>
			) : (
				<div className="border-t border-border">
					<StarPrompt />
					<div className="space-y-0.5 p-2">
						<NavGroup variant="rows" surface="sidebar" group="hidden" remote={remotePage} />
						<NavGroup variant="rows" surface="sidebar" group="bottom" remote={remotePage} />
						{meta ? (
							<div className="px-2.5 pt-1 text-xs text-faint" data-testid="app-versions">
								omp {meta.ompVersion} · webui {meta.serverVersion}
							</div>
						) : null}
						<HostChip variant="line" />
						<UpdateIndicator />
						<RemoteIndicator />
					</div>
				</div>
			)}
			<Modal
				open={bulkDelete !== null}
				onOpenChange={(o) => !o && !working && setBulkDelete(null)}
				title={t(bulkDelete?.length === 1 ? "shell.sidebarBulkDeleteTitleOne" : "shell.sidebarBulkDeleteTitle", {
					n: bulkDelete?.length ?? 0,
				})}
				description={t(
					bulkDelete?.length === 1 ? "shell.sidebarBulkDeleteDescriptionOne" : "shell.sidebarBulkDeleteDescription",
				)}
			>
				<ul
					aria-label={t("shell.sidebarBulkDeleteList")}
					data-testid="bulk-delete-list"
					className="mb-3 space-y-0.5 rounded-lg border border-border bg-bg-soft p-2 text-sm"
				>
					{bulkDelete?.slice(0, BULK_LIST_MAX).map((s) => (
						<li key={s.file} className="truncate">
							{sessionLabel(s)}
						</li>
					))}
					{bulkDelete && bulkDelete.length > BULK_LIST_MAX ? (
						<li className="text-muted">{t("shell.sidebarBulkDeleteMore", { n: bulkDelete.length - BULK_LIST_MAX })}</li>
					) : null}
				</ul>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" disabled={working} onClick={() => setBulkDelete(null)}>
						{t("common.cancel")}
					</Button>
					<Button
						variant="danger"
						data-testid="confirm-bulk-delete"
						disabled={working}
						onClick={() => void confirmBulkDelete()}
					>
						{working ? <Spinner size={14} /> : null}
						{t("common.delete")}
					</Button>
				</div>
			</Modal>
			<Modal
				open={pending !== null}
				onOpenChange={(o) => !o && !working && setPending(null)}
				returnFocusTo={pending?.returnTo}
				title={pending?.action === "delete" ? t("shell.sidebarDeleteTitle") : t("shell.sidebarRenameTitle")}
				description={
					pending?.action === "delete"
						? t(deleteBusy ? "shell.sidebarDeleteBusy" : "shell.sidebarDeleteDescription", {
								title: sessionLabel(pending.session),
							})
						: undefined
				}
			>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void confirmPending();
					}}
				>
					{pending?.action === "rename" ? (
						<input
							aria-label={t("shell.sidebarNameLabel")}
							data-testid="rename-input"
							className="w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint"
							value={pending.title}
							onChange={(e) => setPending({ ...pending, title: e.target.value })}
						/>
					) : null}
					<div className="mt-3 flex justify-end gap-2">
						<Button variant="ghost" disabled={working} onClick={() => setPending(null)}>
							{t("common.cancel")}
						</Button>
						<Button
							variant={pending?.action === "delete" ? "danger" : "primary"}
							type="submit"
							data-testid="confirm-session-action"
							disabled={working || deleteBusy || (pending?.action === "rename" && !pending.title.trim())}
						>
							{working ? <Spinner size={14} /> : null}
							{pending?.action === "delete" ? t("common.delete") : t("common.save")}
						</Button>
					</div>
				</form>
			</Modal>
		</SidebarFrame>
	);
}

/**
 * The sidebar's column: its width is the remembered one, and dragging the handle re-renders only this frame (the
 * list inside is the same element tree as before). In a window too short for everything in it (a browser zoomed in, a
 * phone on its side) the column scrolls inside itself, the list keeping `SessionList`'s minimum height: the app's
 * frame does not scroll (index.css), so this is what keeps the lower items (the pages, feedback, the remote mark)
 * reachable by a wheel, a finger and Tab. The handle is the frame's: it stands outside the box, which a scroll
 * container would clip.
 */
function SidebarFrame({ children }: { children: ReactNode }) {
	const t = useT();
	const { width } = useLayout();
	return (
		<aside
			className="relative flex h-full w-72 shrink-0 flex-col border-r border-border bg-bg-soft min-[901px]:w-[var(--sidebar-w)] max-[900px]:pt-[env(safe-area-inset-top)] max-[900px]:pb-[env(safe-area-inset-bottom)] max-[900px]:pl-[env(safe-area-inset-left)]"
			style={{ "--sidebar-w": `${width.sidebar}px` } as CSSProperties}
			aria-label={t("shell.sidebarAria")}
		>
			<ResizeHandle kind="sidebar" label={t("shell.resizeSidebar")} className="left-full max-[900px]:hidden" />
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">{children}</div>
		</aside>
	);
}

/** The list before it has loaded: a spinner, or — if the first load failed — what went wrong, with a Retry. */
function SessionsPending() {
	const t = useT();
	const error = useApp((s) => s.sessionsError);
	const loadSessions = useApp((s) => s.loadSessions);
	if (error === null)
		return (
			<div className="flex justify-center py-8">
				<Spinner />
			</div>
		);
	return (
		<div className="px-1 pt-2" data-testid="sessions-error">
			<LoadError title={t("shell.sidebarLoadError")} error={error} onRetry={() => void loadSessions()} />
		</div>
	);
}
