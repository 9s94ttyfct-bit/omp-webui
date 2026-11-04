import type { ChatProjectsAnswer } from "@shared/chat-projects.ts";
import { useApp } from "../store/app.ts";
import { ApiError } from "./api.ts";
import { shareProjects, shareStrings } from "./share.ts";

/**
 * `/api/chat-projects/*`: the sidebar's projects, read by every page (with the session list, `store.loadSessions`) and
 * changed by any of them.
 *
 * A change answers the whole list, which this page shows at once; every other page is told (`chat_projects`) and reads it
 * again. A refusal is an `ApiError` carrying the server's `code` (`errorText` words it).
 */
async function change(path: string, body: Record<string, unknown>): Promise<ChatProjectsAnswer> {
	const res = await fetch(`/api/chat-projects/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-omp-webui": "1" },
		body: JSON.stringify(body),
	});
	const answer = await res.json().catch(() => ({}));
	if (!res.ok) {
		const message = typeof answer.error === "string" ? answer.error : res.statusText;
		throw new ApiError(message, res.status, answer.code, answer.params);
	}
	const done = answer as ChatProjectsAnswer;
	const st = useApp.getState();
	st.set({
		chatProjects: shareProjects(st.chatProjects, done.projects),
		chatProjectsExcluded: shareStrings(st.chatProjectsExcluded, done.excluded),
		chatProjectsProblem: done.problem,
	});
	return done;
}

export const chatProjectsApi = {
	/** A new project, with conversations (their session ids) put in it at once when they are given. */
	create: (name: string, sessions: string[] = []) => change("create", { name, sessions }),
	rename: (id: string, name: string) => change("rename", { id, name }),
	/** Set the project's folder (an existing folder), or take it away with null. */
	setFolder: (id: string, folder: string | null) => change("folder", { id, folder }),
	/** Fold or open a project in the sidebar; kept in the app's data, not in this page. */
	setCollapsed: (id: string, collapsed: boolean) => change("collapse", { id, collapsed }),
	/** Put conversations (their session ids) in a project, or with `project` null take them out of every project. */
	assign: (sessions: string[], project: string | null) => change("assign", { sessions, project }),
	reorder: (id: string, delta: -1 | 1) => change("reorder", { id, delta }),
	/** Remove a project: its conversations are in no project again, and none is touched. */
	remove: (id: string) => change("delete", { id }),
};
