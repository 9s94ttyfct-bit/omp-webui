import type { WorktreeList } from "@shared/git.ts";

/**
 * The repository's worktrees (`/api/git/worktrees`, #698). A plain ask is answered from what the server kept a moment ago;
 * `fresh` looks again, which is a POST (as `/api/git`'s fresh look is).
 */
export async function loadWorktrees(cwd: string, fresh: boolean, signal?: AbortSignal): Promise<WorktreeList> {
	const res = await fetch(`/api/git/worktrees?cwd=${encodeURIComponent(cwd)}${fresh ? "&fresh=1" : ""}`, {
		signal,
		...(fresh ? { method: "POST", headers: { "x-omp-webui": "1" } } : {}),
	});
	const body = await res.json().catch(() => ({ error: res.statusText }));
	if (!res.ok) throw new Error(body.error ?? res.statusText);
	return body as WorktreeList;
}
