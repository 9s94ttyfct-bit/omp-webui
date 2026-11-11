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
	| "unchecked"
	/** It is not there (or is not a folder) any more. */
	| "missing";

/** Work git has that moving the folder would take away. Null counts: git could not be asked. */
export interface GitRisk {
	/** Changed or untracked files under the folder. */
	uncommitted: number | null;
	/** Commits of the branch not on its upstream (a branch without one: its commits); counted at a repository's top only. */
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
	/** Who works in it, for `inUse` and `containsOther` ("“Fix CI”", "a Terminal tab", "node (pid 4120)"). */
	usedBy: string[];
	/** Null: not in a repository, or nothing at risk. */
	git: GitRisk | null;
}

export interface CleanupDep extends CleanupPath {
	/** `node_modules`, `.venv`, `target`, … */
	kind: string;
	/** What runs in the conversation's folder now; not empty: it is shown, not offered. */
	usedBy: string[];
}

export interface DeletePreview {
	file: string;
	/** Null: nothing to offer (no Trash here, the folder is gone, or another conversation of the same request offers it). */
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
	/** The preview's git counts: more work than this since then stops the move. */
	git: GitRisk | null;
}

export interface TrashResult {
	moved: string[];
	notMoved: { path: string; error: string }[];
}
