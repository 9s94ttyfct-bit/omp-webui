import { working } from "@shared/attention.ts";
import type { FolderFound } from "@shared/folder.ts";
import { Eye, EyeOff, FolderOpen, FolderX, RefreshCw, Search, X } from "lucide-react";
import {
	type KeyboardEvent,
	lazy,
	memo,
	type ReactNode,
	type RefObject,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { en } from "../../i18n/files.ts";
import { registerStrings, useT } from "../../i18n/index.ts";
import { type EntryRow, visibleOpen, visibleRows } from "../../lib/files-rows.ts";
import { type FolderScope, folder } from "../../lib/folder-api.ts";
import { targetFolder } from "../../lib/transfer-plan.ts";
import { socket } from "../../lib/ws.ts";
import { useApp } from "../../store/app.ts";
import { patchChanges, uiOf, useChanges } from "../../store/changes.ts";
import {
	closeDir,
	keyOf,
	loadDir,
	openDir,
	refreshAll,
	select,
	setFilter,
	setFocused,
	setShowAll,
	toggleDir,
	useFiles,
	useTree,
} from "../../store/files.ts";
import type { TurnSource } from "../changes/ChangesView.tsx";
import { cx, Empty, IconButton, Spinner } from "../ui.tsx";
import { FilePreview } from "./FilePreview.tsx";
import { EntryIcon, FileTree, GitMarkBadge, Marked } from "./FileTree.tsx";
import { TransferDialogs, TransferMenu, useTransferDrop, useTransferLoaded } from "./TransferMenu.tsx";

/** The Changes view's code is loaded when it is first shown: the folder's tree does not carry it. */
const ChangesView = lazy(() => import("../changes/ChangesView.tsx"));

// This chunk carries its own English strings: the first page does not (see `registerStrings`).
registerStrings("files", en);

/** How long the filter waits for the typing to pause. */
const FILTER_MS = 150;
/** A burst of changes is read once, this long after the last of them. */
const REFRESH_MS = 60;
/**
 * The folders are not read more often than this: a turn that writes files all the time is followed at this pace, and
 * every read asks git too (the server keeps that for a moment, and one read of several folders is one look at git).
 */
const MIN_GAP_MS = 800;

function pause(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Where each conversation's tree was scrolled to, for when the preview is closed or the tab is opened again. */
const scrolls = new Map<string, number>();

/**
 * What the tab reads while it is open, and nothing at all while it is not: the root and the open folders when it is
 * shown, again when the server says something in them changed (it watches the open folders for this page and no others),
 * when a turn ends, when the page comes back to the screen, and when the connection to the server is made again.
 */
function useFolderSync(scope: FolderScope, key: string) {
	const connected = useApp((s) => s.connected);
	const open = useFiles((s) => s.trees[key]?.open);
	const dirs = useMemo(() => visibleOpen(open ?? []), [open]);
	const watched = ["", ...dirs].join("\0");
	const busy = useApp((s) => (scope.live && s.lives[scope.live] ? working(s.lives[scope.live]) : false));
	const scopeRef = useRef(scope);
	scopeRef.current = scope;

	// Read again, one at a time and not in a hurry: a change that comes while the folders are being read is read for once
	// more afterwards, when the gap since the last read is over.
	const reading = useRef(false);
	const again = useRef(false);
	const lastRead = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const refresh = useCallback(() => {
		clearTimeout(timer.current);
		const wait = Math.max(REFRESH_MS, lastRead.current + MIN_GAP_MS - Date.now());
		timer.current = setTimeout(async () => {
			if (reading.current) {
				again.current = true;
				return;
			}
			reading.current = true;
			try {
				do {
					again.current = false;
					lastRead.current = Date.now();
					await refreshAll(scopeRef.current);
					if (again.current) await pause(Math.max(0, lastRead.current + MIN_GAP_MS - Date.now()));
				} while (again.current);
			} finally {
				reading.current = false;
			}
		}, wait);
	}, []);

	// First thing on show: what was kept is on screen at once, and is read again.
	useEffect(() => {
		if (key) refresh();
		return () => clearTimeout(timer.current);
	}, [key, refresh]);

	// The server watches what this page has open. What it says reaches the page as a socket message.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `watched` stands for the folders; a new connection is a new watch
	useEffect(() => {
		// No conversation to show a folder of: nothing is watched.
		if (!key) return socket.post({ t: "folder_watch", dirs: [] });
		if (!connected) return;
		socket.post({
			t: "folder_watch",
			...(scope.live ? { live: scope.live } : {}),
			...(scope.file ? { file: scope.file } : {}),
			dirs: ["", ...dirs],
		});
	}, [key, connected, watched]);
	useEffect(
		() => () => {
			socket.post({ t: "folder_watch", dirs: [] });
		},
		[],
	);
	useEffect(
		() =>
			socket.on((msg) => {
				if (msg.t === "folder_changed" && msg.root === useFiles.getState().trees[key]?.root) refresh();
			}),
		[key, refresh],
	);

	const wasBusy = useRef(busy);
	useEffect(() => {
		if (wasBusy.current && !busy) refresh();
		wasBusy.current = busy;
	}, [busy, refresh]);
	useEffect(() => {
		const onShow = () => {
			if (document.visibilityState === "visible") refresh();
		};
		document.addEventListener("visibilitychange", onShow);
		window.addEventListener("focus", onShow);
		return () => {
			document.removeEventListener("visibilitychange", onShow);
			window.removeEventListener("focus", onShow);
		};
	}, [refresh]);
	return refresh;
}

/**
 * The files that match what is typed, read once the typing pauses, and walked for again when the folder was read again
 * (something changed): the walk the server keeps for a moment is then not used.
 */
function useMatches(scope: FolderScope, query: string, all: boolean, reads: number): FolderFound | null {
	const [found, setFound] = useState<{ query: string; all: boolean; result: FolderFound } | null>(null);
	const seen = useRef(reads);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `scope` is rebuilt from these two ids
	useEffect(() => {
		const q = query.trim();
		const fresh = reads !== seen.current;
		seen.current = reads;
		if (!q) {
			setFound(null);
			return;
		}
		const ctl = new AbortController();
		const timer = setTimeout(() => {
			folder.find(scope, q, all, fresh, ctl.signal).then(
				(result) => setFound({ query, all, result }),
				() => {},
			);
		}, FILTER_MS);
		return () => {
			clearTimeout(timer);
			ctl.abort();
		};
	}, [scope.live, scope.file, query, all, reads]);
	return found && found.query === query && found.all === all ? found.result : null;
}

function Toolbar({
	scope,
	filter,
	showAll,
	hiddenCount,
	guarded,
	activeId,
	onFilterKey,
	onRefresh,
	onOpenFolder,
	filterRef,
	transfer,
}: {
	scope: FolderScope;
	filter: string;
	showAll: boolean;
	hiddenCount: number;
	/** The page is not this computer's: there is no switch for what is hidden. */
	guarded: boolean;
	activeId: string | undefined;
	onFilterKey: (e: KeyboardEvent<HTMLInputElement>) => void;
	onRefresh: () => void;
	/** Open the conversation's folder in Finder; absent when this page may not (a page that is not on this Mac). */
	onOpenFolder: (() => void) | undefined;
	filterRef: RefObject<HTMLInputElement | null>;
	/** The Transfer button (only where this page may move files). */
	transfer: ReactNode;
}) {
	const t = useT();
	const hidden = showAll
		? t("files.hideHidden")
		: hiddenCount
			? t("files.showHiddenCount", { n: hiddenCount })
			: t("files.showHidden");
	return (
		<div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
			<div className="relative min-w-0 flex-1">
				<Search
					size={13}
					className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint"
					aria-hidden
				/>
				<input
					ref={filterRef}
					type="search"
					role="combobox"
					aria-label={t("files.filterLabel")}
					aria-expanded={filter.trim() !== ""}
					aria-controls="files-results"
					aria-activedescendant={activeId}
					aria-autocomplete="list"
					autoComplete="off"
					spellCheck={false}
					placeholder={t("files.filterPlaceholder")}
					data-testid="files-filter"
					value={filter}
					onChange={(e) => setFilter(scope, e.target.value)}
					onKeyDown={onFilterKey}
					className="h-7 w-full min-w-0 rounded-lg border border-border bg-surface pr-7 pl-7 text-sm outline-none placeholder:text-faint focus:border-faint [&::-webkit-search-cancel-button]:hidden"
				/>
				{filter ? (
					<button
						type="button"
						aria-label={t("files.filterClear")}
						data-testid="files-filter-clear"
						className="absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg"
						onClick={() => {
							setFilter(scope, "");
							filterRef.current?.focus();
						}}
					>
						<X size={12} />
					</button>
				) : null}
			</div>
			{guarded ? null : (
				<IconButton
					label={hidden}
					size="sm"
					active={showAll}
					aria-pressed={showAll}
					data-testid="files-show-hidden"
					onClick={() => setShowAll(scope, !showAll)}
				>
					{showAll ? <Eye size={14} /> : <EyeOff size={14} />}
				</IconButton>
			)}
			{onOpenFolder ? (
				<IconButton
					label={t("files.openFolderFinder")}
					size="sm"
					data-testid="files-open-folder"
					onClick={onOpenFolder}
				>
					<FolderOpen size={14} />
				</IconButton>
			) : null}
			{transfer}
			<IconButton label={t("files.refresh")} size="sm" data-testid="files-refresh" onClick={onRefresh}>
				<RefreshCw size={14} />
			</IconButton>
		</div>
	);
}

/** What matches the filter: a list to pick from with the arrow keys while the typing stays in the box. */
function Results({
	found,
	query,
	active,
	showAll,
	onPick,
	onHover,
}: {
	found: FolderFound | null;
	query: string;
	active: number;
	showAll: boolean;
	onPick: (path: string) => void;
	onHover: (i: number) => void;
}) {
	const t = useT();
	if (!found) {
		return (
			<div className="flex justify-center py-6">
				<Spinner />
			</div>
		);
	}
	if (found.matches.length === 0) {
		return (
			<div className="px-3 py-6 text-center text-xs text-muted" data-testid="files-none">
				{t(showAll ? "files.filterNone" : "files.filterNoneHidden", { query: query.trim() })}
				{found.partial ? <div className="mt-2">{t("files.filterPartial")}</div> : null}
			</div>
		);
	}
	return (
		<>
			<div
				id="files-results"
				role="listbox"
				aria-label={t("files.filterResultsLabel")}
				data-testid="files-results"
				className="px-1 py-1"
			>
				{found.matches.map((m, i) => {
					const slash = m.path.lastIndexOf("/");
					const name = m.path.slice(slash + 1);
					return (
						// biome-ignore lint/a11y/useKeyWithClickEvents: the options are picked from the filter box, which has the keys
						<div
							key={m.path}
							id={`files-hit-${i}`}
							role="option"
							aria-selected={i === active}
							tabIndex={-1}
							data-testid="files-hit"
							data-path={m.path}
							title={m.path}
							onMouseMove={() => onHover(i)}
							onClick={() => onPick(m.path)}
							className="flex h-9 cursor-default items-center gap-1.5 rounded-md px-2 text-sm hover:bg-hover"
						>
							<EntryIcon entry={{ name, kind: "file" }} />
							<span className="min-w-0 flex-1">
								<span className="block truncate">
									<Marked text={name} query={query} />
								</span>
								{slash >= 0 ? (
									<span className="block truncate text-xs text-faint">
										<Marked text={m.path.slice(0, slash)} query={query} />
									</span>
								) : null}
							</span>
							{m.git ? <GitMarkBadge git={m.git} /> : null}
						</div>
					);
				})}
			</div>
			{found.truncated ? (
				<div className="px-3 py-2 text-xs text-faint">{t("files.filterMore", { n: found.matches.length })}</div>
			) : null}
			{found.partial ? <div className="px-3 pb-2 text-xs text-faint">{t("files.filterPartial")}</div> : null}
		</>
	);
}

/** Whether the tab shows the folder's tree or how it differs from the last commit (the Changes view, loaded when first shown). */
function ViewSwitch({ scope }: { scope: FolderScope }) {
	const t = useT();
	const key = keyOf(scope);
	const view = useChanges((s) => uiOf(s, key).view);
	const choice = (value: "files" | "changes", label: string) => (
		<button
			type="button"
			aria-pressed={view === value}
			data-testid={`files-view-${value}`}
			className={cx(
				"inline-flex h-7 items-center rounded-md px-2.5 text-xs max-lg:min-h-9",
				view === value ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg",
			)}
			onClick={() => patchChanges(key, { view: value })}
		>
			{label}
		</button>
	);
	return (
		<div className="flex shrink-0 items-center border-b border-border px-2 py-1.5">
			<fieldset
				className="flex items-center rounded-lg border border-border p-0.5"
				aria-label={t("files.viewSwitchLabel")}
			>
				{choice("files", t("files.viewFiles"))}
				{choice("changes", t("files.viewChanges"))}
			</fieldset>
		</div>
	);
}

/**
 * The Files tab: the tree of the folder the conversation works in, a filter over its files, and a read-only preview of
 * the file that is opened. Everything is for one conversation (`liveId` and `file` name it; the server knows its folder).
 */
function FilesPane({
	liveId,
	file,
	getTurns,
}: {
	liveId: string | null;
	file: string | null;
	getTurns: () => TurnSource;
}) {
	const t = useT();
	const scope = useMemo<FolderScope>(() => ({ live: liveId, file }), [liveId, file]);
	const key = keyOf(scope);
	const view = useChanges((s) => uiOf(s, key).view);
	const tree = useTree(key);
	const refresh = useFolderSync(scope, key);
	const rows = useMemo(() => visibleRows(tree.slots, tree.open), [tree.slots, tree.open]);
	const root = tree.slots[""]?.listing;

	// Where the tree was left, when it comes back from a preview or from another tab.
	const scroller = useRef<HTMLDivElement>(null);
	const hasTree = root !== undefined && tree.selected === null && tree.filter.trim() === "";
	useLayoutEffect(() => {
		if (hasTree && scroller.current) scroller.current.scrollTop = scrolls.get(key) ?? 0;
	}, [hasTree, key]);

	// Open a folder (the conversation's own when `path` is empty) in Finder: the server refuses what it must, and says so.
	const toast = useApp((s) => s.toast);
	const openInFinder = useCallback(
		(path: string) =>
			folder.openDir(scope, path).catch((e: unknown) => {
				toast("error", t("files.openFailed", { error: e instanceof Error ? e.message : String(e) }));
			}),
		[scope, toast, t],
	);

	// The filter.
	const filterRef = useRef<HTMLInputElement>(null);
	const found = useMatches(scope, tree.filter, tree.showAll, tree.reads);
	const [active, setActive] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the first match is the one to pick when the matches change
	useEffect(() => setActive(0), [found]);
	const filtering = tree.filter.trim() !== "";
	const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
		const count = found?.matches.length ?? 0;
		if (e.key === "ArrowDown" && count) {
			e.preventDefault();
			setActive((i) => Math.min(count - 1, i + 1));
		} else if (e.key === "ArrowUp" && count) {
			e.preventDefault();
			setActive((i) => Math.max(0, i - 1));
		} else if (e.key === "Enter" && found?.matches[active]) {
			e.preventDefault();
			byKeyboard.current = true;
			select(scope, found.matches[active].path);
		} else if (e.key === "Escape" && tree.filter) {
			// Clearing the filter is Escape's job here; it must not also close the sheet the panel is on a phone.
			e.preventDefault();
			setFilter(scope, "");
		}
	};

	// Back from a preview, a keyboard user is where they were.
	const returned = useRef(false);
	const onBack = () => {
		returned.current = true;
		select(scope, null);
	};
	useEffect(() => {
		if (tree.selected !== null || !returned.current) return;
		returned.current = false;
		const box = filtering
			? filterRef.current
			: scroller.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]');
		box?.focus();
	}, [tree.selected, filtering]);

	// How the file on screen was opened: by the keyboard, its preview takes the focus; by the mouse, it does not.
	const byKeyboard = useRef(false);
	const activate = useCallback(
		(row: EntryRow, viaKeyboard: boolean) => {
			if (row.entry.link === "out") return;
			if (row.entry.kind === "dir") toggleDir(scope, row.path);
			else {
				byKeyboard.current = viaKeyboard;
				setFocused(scope, row.path);
				select(scope, row.path);
			}
		},
		[scope],
	);

	// Moving files (#614): what this page may do, the folder it is aimed at, and the drop of files on the tab.
	const transferMode = useApp((s) => s.meta?.fileTransfer);
	const canUpload = transferMode === "full";
	const [transferOpen, setTransferOpen] = useState(false);
	const target = targetFolder(tree.focused ?? tree.selected, (path) =>
		rows.some((r) => r.kind === "entry" && r.path === path && r.entry.kind === "dir"),
	);
	const drop = useTransferDrop({
		scope,
		enabled: canUpload && tree.selected === null,
		target,
		onTaken: () => setTransferOpen(true),
	});
	const over = drop.over;
	// The folder row a drag is over is marked.
	useEffect(() => {
		const marked = over?.row ?? null;
		for (const el of scroller.current?.querySelectorAll<HTMLElement>('[role="treeitem"][data-path]') ?? []) {
			if (marked !== null && el.dataset.path === marked) el.setAttribute("data-drop-target", "");
			else el.removeAttribute("data-drop-target");
		}
	}, [over]);
	const transferLoaded = useTransferLoaded();
	const dialogs =
		canUpload && transferLoaded ? (
			<Suspense fallback={null}>
				<TransferDialogs scope={scope} />
			</Suspense>
		) : null;

	if (!liveId && !file) {
		return (
			<Empty icon={<FolderX size={22} />} title={t("files.noFolderTitle")}>
				{t("files.noFolderBody")}
			</Empty>
		);
	}
	if (view === "changes") {
		return (
			<div className="flex min-h-0 flex-1 flex-col" data-testid="files-pane" data-view="changes">
				<ViewSwitch scope={scope} />
				<Suspense
					fallback={
						<div className="flex flex-1 items-center justify-center">
							<Spinner />
						</div>
					}
				>
					<ChangesView scope={scope} getTurns={getTurns} />
				</Suspense>
				{dialogs}
			</div>
		);
	}
	if (tree.selected !== null) {
		return (
			<div className="flex min-h-0 flex-1 flex-col" data-testid="files-pane">
				<FilePreview
					scope={scope}
					path={tree.selected}
					root={tree.root}
					reads={tree.reads}
					focusBack={byKeyboard.current}
					onBack={onBack}
				/>
				{dialogs}
			</div>
		);
	}
	const transferToolbar =
		transferMode === "off" || transferMode === undefined ? null : (
			<TransferMenu
				scope={scope}
				target={target}
				canUpload={canUpload}
				open={transferOpen}
				onOpenChange={setTransferOpen}
			/>
		);
	return (
		<div
			className={cx("relative flex min-h-0 flex-1 flex-col", over && "ring-2 ring-inset ring-accent")}
			data-testid="files-pane"
			data-dropping={over ? "" : undefined}
			{...drop.handlers}
		>
			<ViewSwitch scope={scope} />
			<Toolbar
				scope={scope}
				filter={tree.filter}
				showAll={tree.showAll}
				hiddenCount={root?.hiddenCount ?? 0}
				guarded={root?.guarded ?? false}
				activeId={filtering && found?.matches.length ? `files-hit-${active}` : undefined}
				onFilterKey={onFilterKey}
				onRefresh={refresh}
				onOpenFolder={root?.local && !root.guarded ? () => openInFinder("") : undefined}
				filterRef={filterRef}
				transfer={transferToolbar}
			/>
			{over ? (
				<div
					className="pointer-events-none absolute inset-x-2 top-12 z-10 rounded-lg border border-accent bg-surface px-3 py-1.5 text-xs shadow-lg"
					data-testid="transfer-drop-hint"
					role="status"
				>
					{t("files.transferDropHere", { folder: over.dest || t("files.transferFolderRoot") })}
				</div>
			) : null}
			{dialogs}
			<div
				ref={scroller}
				className="min-h-0 flex-1 overflow-y-auto"
				onScroll={(e) => {
					if (hasTree) scrolls.set(key, e.currentTarget.scrollTop);
				}}
			>
				{filtering ? (
					<Results
						found={found}
						query={tree.filter}
						active={active}
						showAll={tree.showAll || (root?.guarded ?? false)}
						onPick={(path) => {
							byKeyboard.current = false;
							select(scope, path);
						}}
						onHover={setActive}
					/>
				) : tree.rootError && !root ? (
					<Empty icon={<FolderX size={22} />} title={t("files.rootErrorTitle")}>
						<div>{tree.rootError.message}</div>
						<button
							type="button"
							className="mt-2 rounded-md border border-border px-2 py-1 text-xs hover:bg-hover"
							onClick={() => void loadDir(scope, "")}
						>
							{t("files.retry")}
						</button>
					</Empty>
				) : !root ? (
					<div className="flex justify-center py-10">
						<Spinner />
					</div>
				) : (
					<div className="px-1 py-1">
						{root.entries.length === 0 ? (
							<div className="px-3 py-6 text-center text-xs text-muted" data-testid="tree-note-empty">
								{root.hiddenCount ? t("files.emptyFolderHidden") : t("files.emptyFolder")}
							</div>
						) : (
							<FileTree
								rows={rows}
								focused={tree.focused}
								label={t("files.treeLabel")}
								onFocus={(path) => setFocused(scope, path)}
								onActivate={activate}
								onOpen={(path) => openDir(scope, path)}
								onClose={(path) => closeDir(scope, path)}
								local={root.local && !root.guarded}
								onOpenFinder={openInFinder}
							/>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

export default memo(FilesPane);
