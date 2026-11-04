import * as Menu from "@radix-ui/react-dropdown-menu";
import { projectsOf } from "@shared/chat-projects.ts";
import type { SessionSummary } from "@shared/protocol.ts";
import {
	Archive,
	ArchiveRestore,
	Check,
	ChevronRight,
	Download,
	FolderInput,
	FolderKanban,
	FolderMinus,
	FolderPlus,
	Pencil,
	Pin,
	PinOff,
	SquareTerminal,
	Trash2,
} from "lucide-react";
import { type RefObject, useMemo } from "react";
import { useT } from "../i18n/index.ts";
import { downloadExport } from "../lib/api.ts";
import { askChangeFolder } from "../lib/change-folder.ts";
import { useChatProjectsStrings } from "../lib/chat-projects-strings.ts";
import { askProject, moveToProject } from "../lib/project-actions.ts";
import { useApp } from "../store/app.ts";
import { cx } from "./ui.tsx";

const itemCls =
	"flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-hover data-[state=open]:bg-hover";
const contentCls = "z-50 min-w-48 rounded-xl border border-border bg-surface p-1 shadow-2xl";

/**
 * A conversation's actions, in the menu of its sidebar row. The menu's own contents are a chunk of their own: a
 * page of conversations shows its rows and their buttons, and only the menu that opens shows the actions.
 */
export function SessionMenu({
	session: s,
	pinned,
	archived,
	trigger,
	onAction,
	onTogglePin,
	onToggleArchive,
}: {
	session: SessionSummary;
	pinned: boolean;
	archived: boolean;
	/**
	 * The row's menu button: the dialog an action opens returns focus there when it closes. It is the button's ref,
	 * not the button: the row is not re-rendered when the menu opens, so a button read at render time would be gone.
	 */
	trigger: RefObject<HTMLButtonElement | null>;
	onAction: (session: SessionSummary, action: "rename" | "delete", trigger: HTMLElement | null) => void;
	onTogglePin: (file: string) => void;
	onToggleArchive: (file: string) => void;
}) {
	const t = useT();
	const ready = useChatProjectsStrings();
	const projects = useApp((st) => st.chatProjects);
	const excluded = useApp((st) => st.chatProjectsExcluded);
	const sessions = useApp((st) => st.sessions);
	// The project it is in (its own, or the one of the conversation it came from): read when the menu opens, not by every row.
	const current = useMemo(() => {
		const id = projectsOf(sessions, projects, excluded).get(s.file)?.project;
		return projects.find((p) => p.id === id) ?? null;
	}, [sessions, projects, excluded, s.file]);
	return (
		<Menu.Content align="start" sideOffset={4} className={contentCls}>
			<Menu.Item className={itemCls} onSelect={() => onAction(s, "rename", trigger.current)}>
				<Pencil size={14} /> {t("common.rename")}
			</Menu.Item>
			<Menu.Item className={itemCls} onSelect={() => onTogglePin(s.file)}>
				{pinned ? <PinOff size={14} /> : <Pin size={14} />} {pinned ? t("shell.sessionUnpin") : t("shell.sessionPin")}
			</Menu.Item>
			<Menu.Item className={itemCls} onSelect={() => onToggleArchive(s.file)}>
				{archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}{" "}
				{archived ? t("shell.sessionUnarchive") : t("shell.sessionArchive")}
			</Menu.Item>
			{/* Move to project: the projects, a new one made for it, and out of the one it is in. It never changes its folder. */}
			{ready ? (
				<Menu.Sub>
					<Menu.SubTrigger className={itemCls} data-testid="session-move-to-project">
						<FolderKanban size={14} /> {t("shell.sidebarMoveSelected")}
						<ChevronRight size={14} className="ml-auto text-faint" aria-hidden />
					</Menu.SubTrigger>
					<Menu.Portal>
						<Menu.SubContent sideOffset={4} className={cx(contentCls, "max-h-[60vh] overflow-y-auto")}>
							{projects.length ? null : (
								<Menu.Label className="px-2 py-1 text-xs text-faint">{t("chatProjects.noProjects")}</Menu.Label>
							)}
							{projects.map((p) => (
								<Menu.Item
									key={p.id}
									className={itemCls}
									disabled={current?.id === p.id}
									data-testid="move-to-project"
									data-project={p.id}
									onSelect={() => void moveToProject([s.id], p)}
								>
									<span className="min-w-0 flex-1 truncate">{p.name}</span>
									{current?.id === p.id ? (
										<Check size={14} className="shrink-0 text-faint" aria-label={t("chatProjects.inThisProject")} />
									) : null}
								</Menu.Item>
							))}
							<Menu.Separator className="my-1 h-px bg-border" />
							<Menu.Item
								className={itemCls}
								data-testid="move-to-new-project"
								onSelect={() => askProject({ kind: "new", sessions: [s.id] })}
							>
								<FolderPlus size={14} /> {t("shell.sidebarNewProjectItem")}
							</Menu.Item>
							{current ? (
								<Menu.Item
									className={itemCls}
									data-testid="remove-from-project"
									onSelect={() => void moveToProject([s.id], null, current)}
								>
									<FolderMinus size={14} /> {t("chatProjects.removeFromProject")}
								</Menu.Item>
							) : null}
						</Menu.SubContent>
					</Menu.Portal>
				</Menu.Sub>
			) : null}
			<Menu.Item
				className={itemCls}
				onSelect={() => void downloadExport(s.file).catch((e) => useApp.getState().toast("error", e.message))}
			>
				<Download size={14} /> {t("shell.sessionExportHtml")}
			</Menu.Item>
			<Menu.Item
				className={itemCls}
				onSelect={() => useApp.getState().setView({ kind: "cli", run: ["--resume", s.file] })}
			>
				<SquareTerminal size={14} /> {t("shell.sessionOpenTerminal")}
			</Menu.Item>
			<Menu.Item
				className={itemCls}
				data-testid="session-change-folder"
				onSelect={() => askChangeFolder({ file: s.file, liveId: null, cwd: s.cwd })}
			>
				<FolderInput size={14} /> {t("shell.sessionChangeFolder")}
			</Menu.Item>
			<Menu.Separator className="my-1 h-px bg-border" />
			<Menu.Item className={cx(itemCls, "text-danger")} onSelect={() => onAction(s, "delete", trigger.current)}>
				<Trash2 size={14} /> {t("shell.sessionDelete")}
			</Menu.Item>
		</Menu.Content>
	);
}
