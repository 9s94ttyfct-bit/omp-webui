import type { CleanupDep, CleanupFolder, TrashPick, TrashResult } from "@shared/delete-cleanup.ts";
import type { DiskConversation, DiskRow, DiskSort, DiskSpaceAnswer } from "@shared/disk-space.ts";
import { get, post } from "./api.ts";

/** The Disk space page's calls (docs/superpowers/specs/2026-11-26-disk-space-page-design.md, "Server"). */

export interface DiskPreview {
	folder: string;
	conversations: (DiskConversation & { busy: boolean })[];
	/** This page may move things to the Trash (`mayTrash` on the server). */
	mayTrash: boolean;
	/** This computer has a Trash command. */
	trash: boolean;
	/** Null: no folder part (protected, gone, no Trash, or not allowed). */
	cleanup: { folder: CleanupFolder | null; deps: CleanupDep[] } | null;
}

export interface DiskCleaned {
	deleted: string[];
	failed: { file: string; error: string }[];
	trashed: TrashResult;
}

export const diskApi = {
	rows: () => get<DiskSpaceAnswer>("/api/disk-space"),
	scan: () => post<{ started: boolean }>("/api/disk-space/scan", {}),
	preview: (folder: string, leaving: string[]) => post<DiskPreview>("/api/disk-space/preview", { folder, leaving }),
	clean: (folder: string, files: string[], trash: TrashPick[]) =>
		post<DiskCleaned>("/api/disk-space/clean", { folder, files, trash }),
};

/** What a row takes in all: its folder (when measured) and its conversations. */
export const rowTotal = (r: DiskRow): number => (r.folderBytes ?? 0) + r.conversationBytes;

/** The rows in the order `sort` asks for: ties by name; a row whose folder size or last use is not known comes last whichever way. */
export function sortRows(rows: readonly DiskRow[], sort: DiskSort): DiskRow[] {
	const dir = sort.desc ? -1 : 1;
	const byName = (a: DiskRow, b: DiskRow) => a.name.localeCompare(b.name) || a.folder.localeCompare(b.folder);
	const known = (r: DiskRow): number | null =>
		sort.by === "folder" ? r.folderBytes : sort.by === "lastUsed" ? r.lastUsed : 0;
	const key = (a: DiskRow, b: DiskRow): number => {
		switch (sort.by) {
			case "name":
				return a.name.localeCompare(b.name);
			case "folder":
				return (a.folderBytes ?? 0) - (b.folderBytes ?? 0);
			case "conversations":
				return a.conversations - b.conversations;
			case "total":
				return rowTotal(a) - rowTotal(b);
			case "lastUsed":
				return (a.lastUsed ?? 0) - (b.lastUsed ?? 0);
		}
	};
	return [...rows].sort((a, b) => {
		if ((known(a) === null) !== (known(b) === null)) return known(a) === null ? 1 : -1;
		return dir * key(a, b) || byName(a, b);
	});
}
