import { chatProjectScope, projectsOf } from "@shared/chat-projects.ts";
import { FolderInput, FolderKanban, FolderOpen, MessageSquarePlus } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useT } from "../i18n/index.ts";
import { useChatProjectsStrings } from "../lib/chat-projects-strings.ts";
import { dateGroup, shortPath } from "../lib/format.ts";
import { askProject, newChatIn } from "../lib/project-actions.ts";
import { useApp } from "../store/app.ts";
import type { TurnSource } from "./changes/ChangesView.tsx";
import { FilesTab } from "./files/FilesTab.tsx";
import { sessionLabel } from "./SessionItem.tsx";
import { Button } from "./ui.tsx";

/** The Files panel of a project has no conversation, so no turn of one changed anything in it. */
const NO_TURNS: TurnSource = { entries: [], results: { get: () => undefined }, cwds: [] };
const noTurns = () => NO_TURNS;

/**
 * A sidebar project's own page (`#/project/<id>`), what its folder button opens when no conversation on screen works in
 * that folder: its name and folder, New chat in it, its conversations (newest first), and the Files panel on the right,
 * rooted at the project's folder. The Files panel names the project, not the folder (`chatProjectScope`): the server
 * looks the folder up in its own list, and the files API's rules for this page and a remote one apply as for a
 * conversation's.
 */
export function ProjectPage({ id }: { id: string }) {
	const ready = useChatProjectsStrings();
	const t = useT();
	const { projects, excluded, sessions, archived, home, setView } = useApp(
		useShallow((s) => ({
			projects: s.chatProjects,
			excluded: s.chatProjectsExcluded,
			sessions: s.sessions,
			archived: s.archived,
			home: s.meta?.home,
			setView: s.setView,
		})),
	);
	const project = projects.find((p) => p.id === id) ?? null;
	const members = useMemo(() => {
		const membership = projectsOf(sessions, projects, excluded);
		const hidden = new Set(archived);
		return sessions
			.filter((s) => membership.get(s.file)?.project === id && !hidden.has(s.file) && s.messageCount > 0)
			.sort((a, b) => b.modifiedAt - a.modifiedAt);
	}, [sessions, projects, excluded, archived, id]);
	if (!ready) return null;
	if (!project)
		return (
			<div className="flex flex-1 items-center justify-center p-6 text-sm text-muted" data-testid="project-page-gone">
				{t("chatProjects.pageGone")}
			</div>
		);
	return (
		<div className="flex min-h-0 flex-1 max-[900px]:flex-col" data-testid="project-page" data-project={project.id}>
			<section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-6 py-8 max-[900px]:px-4">
				<div className="mx-auto w-full max-w-2xl">
					<h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight" data-testid="project-page-name">
						<FolderKanban size={22} className="shrink-0 text-accent" aria-hidden />
						<span className="min-w-0 truncate">{project.name}</span>
					</h1>
					<div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
						{project.folder ? (
							<span className="inline-flex min-w-0 items-center gap-1.5" data-testid="project-page-folder">
								<FolderOpen size={14} className="shrink-0" aria-hidden />
								<span className="truncate">{shortPath(project.folder, home)}</span>
							</span>
						) : null}
						<Button size="sm" variant="ghost" onClick={() => askProject({ kind: "folder", project })}>
							<FolderInput size={14} /> {project.folder ? t("chatProjects.changeFolder") : t("chatProjects.setFolder")}
						</Button>
					</div>
					<Button className="mt-5" data-testid="project-page-new-chat" onClick={() => newChatIn(project)}>
						<MessageSquarePlus size={16} /> {t("chatProjects.pageNewChat")}
					</Button>
					<h2 className="mt-8 mb-2 text-xs font-medium text-faint">{t("chatProjects.pageConversations")}</h2>
					{members.length ? (
						<ul className="divide-y divide-border rounded-xl border border-border" data-testid="project-page-sessions">
							{members.map((s) => (
								<li key={s.file}>
									<button
										type="button"
										className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-hover"
										data-testid="project-page-session"
										data-file={s.file}
										onClick={() => setView({ kind: "chat", file: s.file, liveId: null })}
									>
										<span className="min-w-0 flex-1 truncate">{sessionLabel(s)}</span>
										<span className="hidden max-w-48 shrink-0 truncate text-xs text-faint sm:inline">
											{shortPath(s.cwd, home)}
										</span>
										<span className="shrink-0 text-xs text-faint">{dateGroup(s.modifiedAt)}</span>
									</button>
								</li>
							))}
						</ul>
					) : (
						<p className="text-sm text-muted">{t("chatProjects.pageEmpty")}</p>
					)}
				</div>
			</section>
			<aside
				className="flex min-h-0 w-[min(30rem,45%)] shrink-0 flex-col border-l border-border bg-bg-soft max-[900px]:h-[50vh] max-[900px]:w-full max-[900px]:border-t max-[900px]:border-l-0"
				aria-label={t("chatProjects.pageFiles")}
				data-testid="project-files"
			>
				<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-sm font-medium">
					<FolderOpen size={14} className="text-faint" aria-hidden /> {t("chatProjects.pageFiles")}
				</div>
				{project.folder ? (
					// Keyed by the folder: a project whose folder changes shows the new one from its top.
					<FilesTab key={project.folder} liveId={null} file={chatProjectScope(project.id)} getTurns={noTurns} />
				) : (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted">
						<p>{t("chatProjects.pageNoFolder")}</p>
						<Button size="sm" onClick={() => askProject({ kind: "folder", project })}>
							<FolderInput size={14} /> {t("chatProjects.setFolder")}
						</Button>
					</div>
				)}
			</aside>
		</div>
	);
}
