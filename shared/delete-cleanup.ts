/**
 * Deleting a conversation with what it left on disk (docs/superpowers/specs/2026-11-11-delete-session-folder-design.md):
 * its working folder, or some of the dependency folders in it, moved to the Trash once omp has deleted the conversation.
 * The server previews what it would offer (`POST /api/session/delete-preview`), the page sends back what was ticked with
 * the delete, and the server checks every path again before it moves it.
 */

/** Why a conversation's folder is shown but not offered. */
export type FolderRefusal =
	/** The home folder or a folder above it. */
	| "home"
	/** A folder of the system, a volume's root, or a shared temporary folder itself. */
	| "system"
	/** omp-webui's or omp's own data, a folder above it, or one inside it. */
	| "data"
	/** Another conversation, a project or a running process works in it (or, for a conversation or project, in a folder that holds it). */
	| "inUse"
	/** A folder inside it is another conversation's, a project's or a running process's. */
	| "containsOther"
	/** Which processes work in it could not be found out. */
	| "unchecked";

/** Something that works in a folder, as the dialog names it. */
export interface UsedBy {
	kind: "conversation" | "project" | "terminal" | "process";
	/** A conversation's title, a project's name, a process's program (`node`); empty for a Terminal tab. */
	name: string;
	pid?: number;
}

/** Work git has that moving the folder would take away. Null counts: git could not be asked. */
export interface GitRisk {
	/** Changed or untracked files under the folder. */
	uncommitted: number | null;
	/** Commits of the branch not pushed (a branch without an upstream: those no remote has); counted at a repository's top only. */
	unpushed: number | null;
}

interface CleanupPath {
	/** As the conversation names it (its `cwd`, or a folder in it). */
	path: string;
	/** The same with every link resolved: what would be moved. Sent back with the pick. */
	real: string;
	/** Its size in bytes; null when it was not measured in time. */
	bytes: number | null;
}

export interface CleanupFolder extends CleanupPath {
	/** Null: it may be ticked. */
	refused: FolderRefusal | null;
	/** Who works in it, for `inUse` and `containsOther`. */
	usedBy: UsedBy[];
	/** Null: not in a repository, or nothing at risk. */
	git: GitRisk | null;
	/** The top of a linked git worktree: git keeps listing it (prunable) until `git worktree prune`. */
	worktree: boolean;
}

export interface CleanupDep extends CleanupPath {
	/** `node_modules`, `.venv`, `target`, … */
	kind: string;
	/** What runs in the conversation's folder now (shown, not offered); `unchecked`: that could not be found out. */
	refused: "inUse" | "unchecked" | null;
	usedBy: UsedBy[];
}

export interface DeletePreview {
	file: string;
	/** Null: nothing to offer (the folder is gone, or another conversation of the same request offers it). */
	folder: CleanupFolder | null;
	deps: CleanupDep[];
}

export interface DeletePreviewAnswer {
	/** Whether this computer moves things to the Trash at all; false: the dialogs offer nothing. */
	trash: boolean;
	previews: DeletePreview[];
}

/** A ticked path, as the preview gave it. */
export interface TrashPick {
	path: string;
	real: string;
	/** The preview's git counts (a dependency folder: null): more work than this since then stops the move. */
	git: GitRisk | null;
}

export interface TrashResult {
	moved: string[];
	notMoved: { path: string; error: string }[];
}

/** A ticked path read from a request body; null when it is not one. */
function trashPickOf(value: unknown): TrashPick | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (typeof v.path !== "string" || typeof v.real !== "string") return null;
	const count = (n: unknown): number | null => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null);
	const g = v.git as Record<string, unknown> | null | undefined;
	const git = g && typeof g === "object" ? { uncommitted: count(g.uncommitted), unpushed: count(g.unpushed) } : null;
	return { path: v.path, real: v.real, git };
}

/** A conversation's ticked paths read from a request body (absent: none); null when it is not a list of them. */
export function trashPicksOf(value: unknown): TrashPick[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return null;
	const picks = value.map(trashPickOf);
	return picks.every((p): p is TrashPick => p !== null) ? picks : null;
}
