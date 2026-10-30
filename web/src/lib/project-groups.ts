import type { ProjectGroups, ProjectGroupsAnswer } from "@shared/project-groups.ts";
import { ApiError } from "./api.ts";

/**
 * `/api/project-groups*` (#636): the sidebar's project groups, read by every page and changed by any of them.
 *
 * A change answers the whole list, which is what the page shows: two pages' changes cannot leave one showing a list the
 * server does not have. A refusal is an `ApiError` carrying the server's `code` (`errorText` words it).
 */
async function call<T>(path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method: body === undefined ? "GET" : "POST",
		headers: body === undefined ? undefined : { "content-type": "application/json", "x-omp-webui": "1" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const answer = await res.json().catch(() => ({}));
	if (res.ok) return answer as T;
	const message = typeof answer.error === "string" ? answer.error : res.statusText;
	throw new ApiError(message, res.status, answer.code, answer.params);
}

export const projectGroupsApi = {
	list: () => call<ProjectGroups>("/api/project-groups"),
	create: (name: string) => call<ProjectGroupsAnswer>("/api/project-groups/create", { name }),
	rename: (id: string, name: string) => call<ProjectGroupsAnswer>("/api/project-groups/rename", { id, name }),
	/** Fold or open a group in the sidebar; kept in the app's data, not in this page. */
	setCollapsed: (id: string, collapsed: boolean) =>
		call<ProjectGroupsAnswer>("/api/project-groups/collapse", { id, collapsed }),
	/** Put a project (its folder) in a group, or with `group` null at the top level. */
	move: (cwd: string, group: string | null) => call<ProjectGroupsAnswer>("/api/project-groups/move", { cwd, group }),
	reorder: (id: string, delta: -1 | 1) => call<ProjectGroupsAnswer>("/api/project-groups/reorder", { id, delta }),
	/** Remove a group: its projects are the top level's again, and no folder is touched. */
	remove: (id: string) => call<ProjectGroupsAnswer>("/api/project-groups/delete", { id }),
};
