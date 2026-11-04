import type { ChatProject } from "@shared/chat-projects.ts";
import { create } from "zustand";
import { t } from "../i18n/index.ts";
import { useApp } from "../store/app.ts";
import { chatProjectsApi } from "./chat-projects.ts";
import { errorText } from "./error-text.ts";

/**
 * What the sidebar's projects do from more than one place: the row's buttons, a project's menu, a conversation's "Move to
 * project", the selection bar, a drop onto a project, and a project's page. The first page carries it (the sidebar does);
 * the dialogs it asks for are a chunk of their own (`ProjectDialogs`), drawn while `useProjectAsk` holds a question.
 */

/** A question a dialog asks about a project: its name (new, with conversations to put in it, or rename), its folder, or its deletion. */
export type ProjectAsk =
	| { kind: "new"; sessions: string[] }
	| { kind: "rename"; project: ChatProject }
	| { kind: "folder"; project: ChatProject }
	| { kind: "delete"; project: ChatProject };

export const useProjectAsk = create<{ ask: ProjectAsk | null }>(() => ({ ask: null }));

export function askProject(ask: ProjectAsk | null): void {
	useProjectAsk.setState({ ask });
}

/** New chat in a project: in its folder when it has one (else where New chat starts), put in it with its first message. */
export function newChatIn(project: ChatProject): void {
	useApp
		.getState()
		.setView(
			project.folder ? { kind: "new", cwd: project.folder, project: project.id } : { kind: "new", project: project.id },
		);
}

/**
 * The project's folder in the Files panel. A conversation on screen that works in that very folder shows it in its own
 * panel; anything else opens the project's page, whose Files panel is the project's folder (the server finds the folder
 * from the project's id: the page never names it).
 */
export function openProjectFolder(project: ChatProject): void {
	const { view, sessions, lives, setView } = useApp.getState();
	if (view.kind === "chat" && project.folder) {
		const live = view.liveId ? lives[view.liveId] : undefined;
		const cwd = live?.info.cwd ?? sessions.find((s) => s.file === view.file)?.cwd;
		if (cwd === project.folder) {
			void import("./panel-panes.ts").then((m) => m.showPanelTab("files"));
			return;
		}
	}
	setView({ kind: "project", id: project.id });
}

/** Put conversations (by session id) in a project, or with `project` null out of every project, and say so. */
export async function moveToProject(
	sessions: string[],
	project: ChatProject | null,
	from?: ChatProject,
): Promise<boolean> {
	if (!sessions.length) return false;
	const { toast } = useApp.getState();
	try {
		await chatProjectsApi.assign(sessions, project?.id ?? null);
		if (project) toast("success", t("shell.sidebarProjectMoved", { name: project.name }));
		else if (from) toast("success", t("shell.sidebarProjectRemoved", { name: from.name }));
		return true;
	} catch (e) {
		toast("error", t("shell.sidebarProjectMoveFailed", { error: errorText(e) }));
		return false;
	}
}
