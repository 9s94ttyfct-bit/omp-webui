import * as Menu from "@radix-ui/react-dropdown-menu";
import type { FolderEntry, GitMark } from "@shared/folder.ts";
import {
	ChevronRight,
	File,
	FileCode,
	FileImage,
	FileJson,
	FileSymlink,
	FileText,
	Folder,
	FolderOpen,
	FolderSymlink,
	MoreHorizontal,
} from "lucide-react";
import { type KeyboardEvent, memo, useCallback, useEffect, useRef, useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { type EntryRow, kindOf, moveFor, type Row, splitMatch } from "../../lib/files-rows.ts";
import { cx, Spinner } from "../ui.tsx";

/** The mark a file's git state gets: a letter, its words (for those who cannot see its colour) and its colour. */
const MARKS: Record<GitMark | "changed", { letter: string; word: MessageKey; tone: string }> = {
	modified: { letter: "M", word: "files.gitModified", tone: "text-warning" },
	added: { letter: "A", word: "files.gitAdded", tone: "text-success" },
	untracked: { letter: "U", word: "files.gitUntracked", tone: "text-success" },
	conflict: { letter: "!", word: "files.gitConflict", tone: "text-danger" },
	changed: { letter: "•", word: "files.gitChanged", tone: "text-warning" },
};

export function GitMarkBadge({ git }: { git: GitMark | "changed" }) {
	const t = useT();
	const mark = MARKS[git];
	return (
		<span
			className={cx("ml-auto shrink-0 pl-2 text-xs font-medium", mark.tone)}
			data-testid="git-mark"
			data-git={git}
			title={t(mark.word)}
		>
			<span aria-hidden>{mark.letter}</span>
			<span className="sr-only">{t(mark.word)}</span>
		</span>
	);
}

/** The icon of an entry: folders open or closed, links drawn as links, files by what they hold. */
export function EntryIcon({ entry, open }: { entry: FolderEntry; open?: boolean }) {
	const size = 14;
	const cls = "shrink-0";
	if (entry.kind === "dir") {
		if (entry.link) return <FolderSymlink size={size} className={cx(cls, "text-muted")} />;
		return open ? (
			<FolderOpen size={size} className={cx(cls, "text-accent")} />
		) : (
			<Folder size={size} className={cx(cls, "text-accent")} />
		);
	}
	if (entry.link === "out") return <FileSymlink size={size} className={cx(cls, "text-faint")} />;
	switch (kindOf(entry.name)) {
		case "image":
			return <FileImage size={size} className={cx(cls, "text-muted")} />;
		case "text":
			return <FileText size={size} className={cx(cls, "text-muted")} />;
		case "data":
			return <FileJson size={size} className={cx(cls, "text-muted")} />;
		case "code":
			return <FileCode size={size} className={cx(cls, "text-muted")} />;
		default:
			return <File size={size} className={cx(cls, "text-muted")} />;
	}
}

/** A name with the part a filter matched in stronger type. */
export function Marked({ text, query }: { text: string; query: string }) {
	const [before, hit, after] = splitMatch(text, query);
	return hit ? (
		<>
			{before}
			<span className="font-semibold text-fg">{hit}</span>
			{after}
		</>
	) : (
		text
	);
}

const INDENT = 14;

interface RowProps {
	row: EntryRow;
	focused: boolean;
	onActivate: (row: EntryRow, viaKeyboard: boolean) => void;
	/** This page may open a folder in Finder. */
	local: boolean;
	onMenu: (row: EntryRow, at: { x: number; y: number }, viaKeyboard: boolean) => void;
}

const TreeRow = memo(function TreeRow({ row, focused, onActivate, local, onMenu }: RowProps) {
	const t = useT();
	const { entry } = row;
	const isDir = entry.kind === "dir";
	const out = entry.link === "out";
	// A folder on this computer has a menu (opening the folder itself in Finder); a link that leads out is not followed.
	const menu = local && isDir && !out;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the tree handles the keys of its rows once, on the tree
		<div
			role="treeitem"
			tabIndex={focused ? 0 : -1}
			aria-level={row.depth + 1}
			aria-posinset={row.index + 1}
			aria-setsize={row.count}
			aria-expanded={isDir ? row.open : undefined}
			aria-disabled={out || undefined}
			data-testid="file-row"
			data-path={row.path}
			data-kind={entry.kind}
			title={out ? t("files.linkOut") : row.path}
			onClick={() => onActivate(row, false)}
			onContextMenu={
				menu
					? (e) => {
							e.preventDefault();
							onMenu(row, { x: e.clientX, y: e.clientY }, false);
						}
					: undefined
			}
			style={{ paddingLeft: 4 + row.depth * INDENT }}
			className={cx(
				"group flex h-7 cursor-default select-none items-center gap-1 rounded-md pr-1.5 text-sm hover:bg-hover pointer-coarse:h-9",
				entry.hidden || out ? "text-faint" : "text-fg",
			)}
		>
			{isDir ? (
				<ChevronRight
					size={12}
					className={cx("shrink-0 text-faint transition-transform", row.open && "rotate-90")}
					aria-hidden
				/>
			) : (
				<span className="w-3 shrink-0" aria-hidden />
			)}
			<EntryIcon entry={entry} open={row.open} />
			<span className={cx("min-w-0 truncate", out && "italic")}>{entry.name}</span>
			{menu ? (
				// For the mouse only: a button inside a tree item is not for the keyboard or a screen reader (the menu key and
				// Shift+F10 on the row open the same menu).
				<button
					type="button"
					tabIndex={-1}
					aria-hidden
					data-testid="file-row-menu"
					className={cx(
						"shrink-0 rounded-md p-1 text-faint opacity-0 hover:bg-surface hover:text-fg group-hover:opacity-100 pointer-coarse:opacity-100",
						!entry.git && "ml-auto",
					)}
					onClick={(e) => {
						e.stopPropagation();
						const box = e.currentTarget.getBoundingClientRect();
						onMenu(row, { x: box.left, y: box.bottom }, false);
					}}
				>
					<MoreHorizontal size={13} />
				</button>
			) : null}
			{entry.git ? <GitMarkBadge git={entry.git} /> : null}
		</div>
	);
});

/** A row that is no entry: a folder being read, one that could not be, an empty one or a list that was cut. */
function NoteRow({ row }: { row: Exclude<Row, EntryRow> }) {
	const t = useT();
	const pad = { paddingLeft: 4 + row.depth * INDENT + 16 };
	if (row.kind === "loading") {
		return (
			<div
				role="treeitem"
				tabIndex={-1}
				aria-disabled
				aria-level={row.depth + 1}
				style={pad}
				className="flex h-7 items-center gap-2 text-xs text-faint"
			>
				<Spinner size={12} />
				{t("files.loading")}
			</div>
		);
	}
	const text =
		row.kind === "error"
			? t("files.listError", { error: row.message ?? "" })
			: row.kind === "cut"
				? t("files.truncatedList", { n: row.n ?? 0 })
				: row.n
					? t("files.emptyFolderHidden")
					: t("files.emptyFolder");
	return (
		<div
			role="treeitem"
			tabIndex={-1}
			aria-disabled
			aria-level={row.depth + 1}
			style={pad}
			className={cx("flex min-h-7 items-center py-1 pr-2 text-xs", row.kind === "error" ? "text-danger" : "text-faint")}
			data-testid={`tree-note-${row.kind}`}
		>
			{text}
		</div>
	);
}

/**
 * The tree: a WAI-ARIA tree of the rows on screen, one of them in the tab order (the focused one), and the keys of
 * `moveFor`. Clicking a folder opens or closes it, a file opens it.
 */
export function FileTree({
	rows,
	focused,
	onFocus,
	onActivate,
	onOpen,
	onClose,
	label,
	local,
	onOpenFinder,
}: {
	rows: Row[];
	focused: string | null;
	onFocus: (path: string) => void;
	onActivate: (row: EntryRow, viaKeyboard: boolean) => void;
	onOpen: (path: string) => void;
	onClose: (path: string) => void;
	label: string;
	/** This page may open a folder in Finder: the folder rows have a menu for it. */
	local: boolean;
	onOpenFinder: (path: string) => void;
}) {
	const t = useT();
	const tree = useRef<HTMLDivElement>(null);
	// The folder whose menu is open, and where it opens (a click's place, or the row's own for the keyboard).
	const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
	// The row a menu that the keyboard opened gives the focus back to when it closes (the menu is gone from the props by then).
	const focusBack = useRef<string | null>(null);
	const rowEl = useCallback(
		(path: string) =>
			[...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"][data-path]') ?? [])].find(
				(r) => r.dataset.path === path,
			),
		[],
	);
	const openMenu = useCallback((row: EntryRow, at: { x: number; y: number }, viaKeyboard: boolean) => {
		focusBack.current = viaKeyboard ? row.path : null;
		setMenu({ path: row.path, ...at });
	}, []);
	// A tree that is not given a row to focus puts the first one in the tab order.
	const first = rows.find((r): r is EntryRow => r.kind === "entry")?.path ?? null;
	const current = focused !== null && rows.some((r) => r.kind === "entry" && r.path === focused) ? focused : first;
	// The keys move focus with the row they went to, but a tree that does not have focus (a refresh, a row opened by the mouse) does not take it.
	useEffect(() => {
		const el = tree.current;
		if (!el || current === null || !el.contains(document.activeElement)) return;
		const row = rowEl(current);
		if (row && row !== document.activeElement) row.focus();
	}, [current, rowEl]);
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		// The menu key, or Shift+F10: the folder row's menu, opened at the row.
		if (local && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
			const row = rows.find((r): r is EntryRow => r.kind === "entry" && r.path === current);
			const el = current === null ? undefined : rowEl(current);
			if (!row || !el || row.entry.kind !== "dir" || row.entry.link === "out") return;
			e.preventDefault();
			const box = el.getBoundingClientRect();
			openMenu(row, { x: box.left + 24, y: box.bottom }, true);
			return;
		}
		if (e.altKey || e.ctrlKey || e.metaKey) return;
		const move = moveFor(e.key, rows, current);
		if (!move) return;
		e.preventDefault();
		if ("to" in move) onFocus(move.to);
		else if ("open" in move) onOpen(move.open);
		else if ("close" in move) onClose(move.close);
		else {
			const path = "toggle" in move ? move.toggle : move.choose;
			const row = rows.find((r): r is EntryRow => r.kind === "entry" && r.path === path);
			if (row) onActivate(row, true);
		}
	};
	return (
		<>
			<div ref={tree} role="tree" aria-label={label} data-testid="file-tree" onKeyDown={onKeyDown}>
				{rows.map((row) =>
					row.kind === "entry" ? (
						<TreeRow
							key={`e:${row.path}`}
							row={row}
							focused={row.path === current}
							onActivate={onActivate}
							local={local}
							onMenu={openMenu}
						/>
					) : (
						<NoteRow key={`${row.kind}:${row.path}`} row={row} />
					),
				)}
			</div>
			{local ? (
				<Menu.Root open={menu !== null} onOpenChange={(open) => !open && setMenu(null)}>
					{/* Where the menu opens from: the place of the click or of the row. Nothing to see, hear or focus. */}
					<Menu.Trigger asChild>
						<span
							aria-hidden
							data-testid="folder-menu-anchor"
							style={{ position: "fixed", left: menu?.x ?? 0, top: menu?.y ?? 0, width: 0, height: 0 }}
						/>
					</Menu.Trigger>
					<Menu.Portal>
						<Menu.Content
							align="start"
							sideOffset={4}
							aria-label={t("files.folderActions", {
								name: menu ? menu.path.slice(menu.path.lastIndexOf("/") + 1) : "",
							})}
							data-testid="folder-menu"
							className="z-50 min-w-48 rounded-xl border border-border bg-surface p-1 shadow-2xl"
							onCloseAutoFocus={(e) => {
								// A menu the keyboard opened gives the focus back to the row; one of the mouse leaves it where it is.
								e.preventDefault();
								const back = focusBack.current;
								focusBack.current = null;
								if (back !== null) rowEl(back)?.focus();
							}}
						>
							<Menu.Item
								className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-hover"
								data-testid="folder-open-finder"
								onSelect={() => menu && onOpenFinder(menu.path)}
							>
								<FolderOpen size={14} /> {t("files.openFolderFinder")}
							</Menu.Item>
						</Menu.Content>
					</Menu.Portal>
				</Menu.Root>
			) : null}
		</>
	);
}
