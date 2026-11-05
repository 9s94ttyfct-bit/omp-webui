import * as Menu from "@radix-ui/react-dropdown-menu";
import type { ChatProject } from "@shared/chat-projects.ts";
import type { SessionSummary } from "@shared/protocol.ts";
import { ChevronDown, ChevronRight, FolderOpen, MoreHorizontal, Plus, SquarePen } from "lucide-react";
import { type MouseEvent, memo, Suspense, useState } from "react";
import { t as translate, useT } from "../i18n/index.ts";
import { chatProjectsApi } from "../lib/chat-projects.ts";
import { errorText } from "../lib/error-text.ts";
import { lazyChunk } from "../lib/lazy-chunk.ts";
import { askProject, newChatIn, openProjectFolder } from "../lib/project-actions.ts";
import { useApp } from "../store/app.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { type LiveDot, type SessionAction, SessionItem } from "./SessionItem.tsx";
import { cx, IconButton } from "./ui.tsx";

// A project's menu: a chunk of its own, loaded when it opens (its strings come with it).
const { Chunk: ProjectMenu, retry: retryProjectMenu } = lazyChunk(() =>
	import("./ProjectMenu.tsx").then((m) => ({ default: m.ProjectMenu })),
);

/** How many of a project's conversations an open project shows before "Show all". */
const FIRST_ROWS = 5;

/** What a project's rows are drawn with: the list's own (`SessionList`), so a row is the same row wherever it is. */
export interface ProjectRowProps {
	activeFile: string | null;
	pinSet: ReadonlySet<string>;
	archivedSet: ReadonlySet<string>;
	liveFiles: ReadonlyMap<string, LiveDot>;
	/** The conversations whose process runs in Light mode. */
	lightFiles: ReadonlySet<string>;
	selecting: boolean;
	selected: ReadonlySet<string>;
	onOpen: (file: string) => void;
	onTogglePin: (file: string) => void;
	onToggleArchive: (file: string) => void;
	onAction: (session: SessionSummary, action: SessionAction, trigger: HTMLElement | null) => void;
	onSelect: (file: string, e: MouseEvent) => void;
}

/**
 * The sidebar's projects, above the list by date: a heading with "New project", then each project with its conversations
 * (the 5 most recent, then "Show all"). A project's row folds it, starts a new chat in it, shows its folder in the Files
 * panel, and has a menu; a conversation dropped on it is put in it (`lib/session-drag.ts`, `data-project-drop`).
 *
 * It is drawn even with no project, with a line that says what a project is for: that is how the person finds it.
 */
export function ProjectsSection({
	projects,
	rows,
	activeProject,
	...row
}: ProjectRowProps & {
	projects: readonly ChatProject[];
	/** Each project's conversations that the list shows, newest first. */
	rows: ReadonlyMap<string, readonly SessionSummary[]>;
	/** The project whose page is open. */
	activeProject: string | null;
}) {
	const t = useT();
	return (
		<section
			className="max-h-[45vh] shrink-0 overflow-y-auto overscroll-contain px-2 pt-2"
			aria-labelledby="sidebar-projects-heading"
			data-testid="projects-section"
		>
			<div className="flex items-center gap-1 px-2.5 pb-0.5">
				<h2 id="sidebar-projects-heading" className="min-w-0 flex-1 truncate text-xs font-medium text-faint">
					{t("shell.sidebarProjects")}
				</h2>
				<IconButton
					size="xs"
					label={t("shell.sidebarNewProject")}
					data-testid="projects-new"
					onClick={() => askProject({ kind: "new", sessions: [] })}
				>
					<Plus size={14} />
				</IconButton>
			</div>
			{projects.length ? (
				<ul className="space-y-0.5">
					{projects.map((p) => (
						<ProjectLine
							key={p.id}
							project={p}
							index={projects.indexOf(p)}
							count={projects.length}
							sessions={rows.get(p.id) ?? []}
							active={activeProject === p.id}
							{...row}
						/>
					))}
				</ul>
			) : (
				// What the section is for, while it is empty: only where the window is tall enough that the list keeps its room
				// (on a short window or a phone the list starts high, and the + button, New project, is what is left).
				<p
					className="hidden px-2.5 pb-1 text-xs text-muted [@media(min-height:880px)]:block"
					data-testid="projects-hint"
				>
					{t("shell.sidebarProjectsHint")}
				</p>
			)}
		</section>
	);
}

/** One project: its row (fold, name, count, new chat, folder, menu) and, while it is open, its conversations. */
const ProjectLine = memo(function ProjectLine({
	project: p,
	index,
	count,
	sessions,
	active,
	...row
}: ProjectRowProps & {
	project: ChatProject;
	index: number;
	count: number;
	sessions: readonly SessionSummary[];
	active: boolean;
}) {
	const t = useT();
	const [all, setAll] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const listId = `project-${p.id}`;
	const shown = all ? sessions : sessions.slice(0, FIRST_ROWS);
	const fold = () =>
		void chatProjectsApi
			.setCollapsed(p.id, !p.collapsed)
			.catch((e) =>
				useApp.getState().toast("error", translate("shell.sidebarProjectSaveFailed", { error: errorText(e) })),
			);
	const label =
		sessions.length === 1
			? t("shell.sidebarProjectAriaOne", { name: p.name })
			: t("shell.sidebarProjectAria", { name: p.name, n: sessions.length });
	const actions = "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100";
	return (
		<li data-testid="project" data-project={p.id}>
			<div
				className={cx(
					"group relative flex items-center rounded-lg text-sm",
					active ? "bg-hover text-fg" : "text-muted hover:bg-hover/70 hover:text-fg",
				)}
				data-testid="project-row"
				data-project-drop={p.id}
			>
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-1.5 pr-1 pl-2 text-left focus-visible:-outline-offset-2"
					aria-expanded={!p.collapsed}
					aria-controls={listId}
					aria-label={label}
					title={p.folder ?? p.name}
					data-testid="project-fold"
					onClick={fold}
				>
					{p.collapsed ? (
						<ChevronRight size={13} className="shrink-0 text-faint" aria-hidden />
					) : (
						<ChevronDown size={13} className="shrink-0 text-faint" aria-hidden />
					)}
					<span className="min-w-0 flex-1 truncate font-medium" data-testid="project-name">
						{p.name}
					</span>
					<span className="shrink-0 text-xs tabular-nums text-faint" data-testid="project-count">
						{sessions.length}
					</span>
				</button>
				<span className={cx("flex shrink-0 items-center pr-1", menuOpen ? "opacity-100" : actions)}>
					<IconButton
						size="xs"
						label={t("shell.sidebarProjectNewChat", { name: p.name })}
						data-testid="project-new-chat"
						onClick={() => newChatIn(p)}
					>
						<SquarePen size={13} />
					</IconButton>
				</span>
				{p.folder ? (
					<IconButton
						size="xs"
						label={t("shell.sidebarProjectFolder", { name: p.name })}
						data-testid="project-folder"
						className="mr-0.5"
						onClick={() => openProjectFolder(p)}
					>
						<FolderOpen size={13} />
					</IconButton>
				) : null}
				<Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
					<Menu.Trigger asChild>
						<button
							type="button"
							aria-label={t("shell.sidebarProjectActions", { name: p.name })}
							data-testid="project-menu"
							className={cx(
								"mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-surface hover:text-fg",
								menuOpen ? "opacity-100" : actions,
							)}
						>
							<MoreHorizontal size={14} />
						</button>
					</Menu.Trigger>
					{/* A chunk that is gone is a toast and a closed menu, as a conversation's menu is (`SessionItem`). */}
					<ErrorBoundary
						resetKey={menuOpen}
						fallback={() => null}
						onError={() => {
							retryProjectMenu();
							setMenuOpen(false);
							useApp.getState().toast("error", translate("shell.errorProjectMenuLoad"));
						}}
					>
						<Menu.Portal>
							<Suspense fallback={null}>
								<ProjectMenu project={p} first={index === 0} last={index === count - 1} />
							</Suspense>
						</Menu.Portal>
					</ErrorBoundary>
				</Menu.Root>
			</div>
			{p.collapsed ? null : (
				<div id={listId} className="ml-3 border-l border-border pl-1" data-testid="project-sessions">
					{shown.length ? (
						shown.map((s) => (
							<SessionItem
								key={s.file}
								session={s}
								active={row.activeFile === s.file}
								pinned={row.pinSet.has(s.file)}
								archived={row.archivedSet.has(s.file)}
								liveState={row.liveFiles.get(s.file)}
								light={row.lightFiles.has(s.file)}
								onOpen={row.onOpen}
								onTogglePin={row.onTogglePin}
								onToggleArchive={row.onToggleArchive}
								onAction={row.onAction}
								selecting={row.selecting}
								selected={row.selected.has(s.file)}
								onSelect={row.onSelect}
							/>
						))
					) : (
						<p className="px-2.5 py-1 text-xs text-faint">{t("shell.sidebarProjectNone")}</p>
					)}
					{sessions.length > FIRST_ROWS ? (
						<button
							type="button"
							className="w-full rounded-lg px-2.5 py-1 text-left text-xs text-muted hover:bg-hover hover:text-fg"
							aria-expanded={all}
							aria-controls={listId}
							data-testid="project-show-all"
							onClick={() => setAll(!all)}
						>
							{all ? t("shell.sidebarProjectShowFewer") : t("shell.sidebarProjectShowAll", { n: sessions.length })}
						</button>
					) : null}
				</div>
			)}
		</li>
	);
});
