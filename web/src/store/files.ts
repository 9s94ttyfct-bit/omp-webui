import { create } from "zustand";
import { ApiError } from "../lib/api.ts";
import { type DirSlot, visibleOpen } from "../lib/files-rows.ts";
import { type FolderScope, folder } from "../lib/folder-api.ts";

/**
 * What the Files tab shows of each conversation's folder: the folders listed, which are open, the file being previewed
 * and the filter. Kept per conversation (the few last ones) so that leaving the tab, or the conversation, and coming
 * back finds the tree as it was; nothing is requested or watched while the tab is closed (see `FilesPane`).
 */

export interface TreeState {
	/** The folder of the conversation, as the server resolved it: what the path of a file is written under. */
	root: string | null;
	/** The listings by folder (relative path; "" is the conversation's own folder). */
	slots: Record<string, DirSlot>;
	/** The folders that are open, in the order they were opened. Includes ones whose parent has been closed. */
	open: string[];
	/** Show what is hidden by default (dotfiles, dependency and build folders, ignored files). */
	showAll: boolean;
	/** The file being previewed. */
	selected: string | null;
	filter: string;
	/** The row that holds the tree's focus. */
	focused: string | null;
	/** Counts up every time what is listed was read again: a preview of a file that may have changed reads it again. */
	reads: number;
	/** The root could not be read (the folder is gone, or the conversation unknown). */
	rootError: { message: string; status: number } | null;
}

const EMPTY: TreeState = {
	root: null,
	slots: {},
	open: [],
	showAll: false,
	selected: null,
	filter: "",
	focused: null,
	reads: 0,
	rootError: null,
};

/** Conversations whose tree is kept. */
const KEPT = 4;

interface FilesStore {
	trees: Record<string, TreeState>;
	/** Oldest first. */
	order: string[];
	patch(key: string, change: (tree: TreeState) => Partial<TreeState>): void;
}

export const useFiles = create<FilesStore>((set) => ({
	trees: {},
	order: [],
	patch(key, change) {
		set((s) => {
			const tree = s.trees[key] ?? EMPTY;
			const trees = { ...s.trees, [key]: { ...tree, ...change(tree) } };
			const order = [...s.order.filter((k) => k !== key), key];
			while (order.length > KEPT) delete trees[order.shift() as string];
			return { trees, order };
		});
	},
}));

/** The tree of a conversation (never undefined: a new one is empty). */
export function useTree(key: string): TreeState {
	return useFiles((s) => s.trees[key]) ?? EMPTY;
}

export const keyOf = (scope: FolderScope): string => scope.file ?? scope.live ?? "";

const treeOf = (key: string): TreeState => useFiles.getState().trees[key] ?? EMPTY;
const patch = (key: string, change: (tree: TreeState) => Partial<TreeState>) => useFiles.getState().patch(key, change);

/** The newest request for each folder: an answer that is not it has been overtaken. */
const newest = new Map<string, number>();
let requests = 0;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Read a folder. A folder that is not there any more is closed; the root that is not there is the tab's error. */
export async function loadDir(scope: FolderScope, path: string, fresh = false): Promise<void> {
	const key = keyOf(scope);
	const id = ++requests;
	newest.set(`${key}\0${path}`, id);
	const all = treeOf(key).showAll;
	try {
		const listing = await folder.list(scope, path, all, fresh);
		if (newest.get(`${key}\0${path}`) !== id || treeOf(key).showAll !== all) return;
		patch(key, (t) => ({
			root: listing.root,
			rootError: path === "" ? null : t.rootError,
			slots: {
				...t.slots,
				[path]: {
					listing: {
						entries: listing.entries,
						hiddenCount: listing.hiddenCount,
						truncated: listing.truncated,
						git: listing.git,
						guarded: listing.guarded === true,
						local: listing.local === true,
					},
				},
			},
		}));
	} catch (e) {
		if (newest.get(`${key}\0${path}`) !== id || (e instanceof DOMException && e.name === "AbortError")) return;
		const status = e instanceof ApiError ? e.status : 0;
		if (path === "") {
			patch(key, () => ({ rootError: { message: messageOf(e), status } }));
		} else if (status === 404 || status === 400) {
			// Gone (or turned into a file) since it was listed: closed, with what was below it.
			patch(key, (t) => {
				const slots = { ...t.slots };
				delete slots[path];
				return { slots, open: t.open.filter((p) => p !== path && !p.startsWith(`${path}/`)) };
			});
		} else {
			patch(key, (t) => ({ slots: { ...t.slots, [path]: { error: messageOf(e) } } }));
		}
	}
}

/** Read again everything that is on screen: the root and the folders that are open. */
export async function refreshAll(scope: FolderScope): Promise<void> {
	const key = keyOf(scope);
	const dirs = ["", ...visibleOpen(treeOf(key).open)];
	await Promise.all(dirs.map((d) => loadDir(scope, d, true)));
	patch(key, (t) => ({ reads: t.reads + 1 }));
}

/** Open a folder, reading it if it has not been (or if the last read failed): resolves when what it holds is on screen. */
export function openDir(scope: FolderScope, path: string): Promise<void> {
	const key = keyOf(scope);
	patch(key, (t) => ({ open: t.open.includes(path) ? t.open : [...t.open, path], focused: path }));
	return treeOf(key).slots[path]?.listing ? Promise.resolve() : loadDir(scope, path);
}

/** Close a folder. What is open below it stays open for when it is opened again. */
export function closeDir(scope: FolderScope, path: string): void {
	patch(keyOf(scope), (t) => ({ open: t.open.filter((p) => p !== path), focused: path }));
}

export function toggleDir(scope: FolderScope, path: string): Promise<void> {
	if (!treeOf(keyOf(scope)).open.includes(path)) return openDir(scope, path);
	closeDir(scope, path);
	return Promise.resolve();
}

/** Show or leave out what is hidden by default: every listing is read again. */
export async function setShowAll(scope: FolderScope, showAll: boolean): Promise<void> {
	const key = keyOf(scope);
	if (treeOf(key).showAll === showAll) return;
	patch(key, () => ({ showAll }));
	await Promise.all(["", ...visibleOpen(treeOf(key).open)].map((d) => loadDir(scope, d)));
}

export const setFilter = (scope: FolderScope, filter: string) => patch(keyOf(scope), () => ({ filter }));
export const setFocused = (scope: FolderScope, focused: string | null) => patch(keyOf(scope), () => ({ focused }));
export const select = (scope: FolderScope, selected: string | null) => patch(keyOf(scope), () => ({ selected }));
