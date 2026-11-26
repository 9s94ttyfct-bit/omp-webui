/**
 * The Disk space page (docs/superpowers/specs/2026-11-26-disk-space-page-design.md): every project folder with the room its
 * folder and its conversations take, and what the page asks the server to clean up.
 */

/**
 * What a row is: a folder of the projects folder (`project`), another folder conversations ran in (`other`), or a folder
 * that is only a place conversations ran in and is never measured nor offered (`protected`: the home folder, a system
 * folder, the projects folder itself and every folder above it).
 */
export type DiskRowKind = "project" | "other" | "protected";

/** How far a row's folder size is known: measured, over its time, not measured yet, never measured (protected), gone. */
export type DiskFolderState = "measured" | "unknown" | "pending" | "notMeasured" | "gone";

/** One conversation of a row, as the cleanup dialog lists it. */
export interface DiskConversation {
	file: string;
	title: string;
	modifiedAt: number;
	/** Its transcript and its artifacts folder (subagents, files it kept), in bytes. */
	bytes: number;
}

export interface DiskRow {
	/** The folder, as the page names it (real, every link resolved; the path conversations named for one that is gone). */
	folder: string;
	/** Null: the folder is gone. */
	real: string | null;
	/** The folder's last part. */
	name: string;
	kind: DiskRowKind;
	/** Allocated bytes of the folder (its conversations' files in it left out); null unless `folderState` is `measured`. */
	folderBytes: number | null;
	folderState: DiskFolderState;
	/** When `folderBytes` was measured. */
	measuredAt: number | null;
	conversations: number;
	conversationBytes: number;
	/** The newest of its conversations, else the folder's modification time; null: neither is known. */
	lastUsed: number | null;
}

export interface DiskScanState {
	running: boolean;
	startedAt: number | null;
	finishedAt: number | null;
	/** Folders measured by the running (or last) scan, and how many it has. */
	done: number;
	total: number;
}

/** `GET /api/disk-space`. */
export interface DiskSpaceAnswer {
	rows: DiskRow[];
	scan: DiskScanState;
	/** The disk the projects folder is on; null: it could not be read. */
	disk: { free: number; total: number } | null;
}

export const DISK_SORT_KEYS = ["name", "folder", "conversations", "total", "lastUsed"] as const;
export type DiskSortKey = (typeof DISK_SORT_KEYS)[number];
export interface DiskSort {
	by: DiskSortKey;
	desc: boolean;
}
export const DEFAULT_DISK_SORT: DiskSort = { by: "total", desc: true };

export function isDiskSort(v: unknown): v is DiskSort {
	if (typeof v !== "object" || v === null) return false;
	const s = v as Record<string, unknown>;
	return (DISK_SORT_KEYS as readonly unknown[]).includes(s.by) && typeof s.desc === "boolean";
}
