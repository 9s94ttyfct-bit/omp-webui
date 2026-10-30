import type { FolderChanges } from "@shared/changes.ts";
import { create } from "zustand";

/**
 * What the Files tab's Changes view keeps of each conversation: whether it is shown instead of the tree, which list it is on,
 * the file whose change is open and the list as it was last read (so that coming back from the tree shows it at once and reads
 * it again). Kept per conversation, the few last ones, like the tree (see `store/files.ts`).
 */

export interface ChangesUi {
	/** What the Files tab shows: the folder's tree, or how it differs from the last commit. */
	view: "files" | "changes";
	/** The list in the Changes view: every file that differs now, or what each turn of the conversation changed. */
	source: "tree" | "turns";
	/** The file whose change is open. */
	selected: string | null;
	/** The list as it was last read. */
	data: FolderChanges | null;
}

const EMPTY: ChangesUi = { view: "files", source: "tree", selected: null, data: null };

/** Conversations whose view is kept. */
const KEPT = 6;

export type DiffMode = "unified" | "split";

interface ChangesStore {
	by: Record<string, ChangesUi>;
	/** Oldest first. */
	order: string[];
	/** How a diff is drawn when the room allows both. */
	mode: DiffMode;
}

export const useChanges = create<ChangesStore>(() => ({ by: {}, order: [], mode: "unified" }));

/** The view of one conversation (the empty one for a conversation that has none yet). */
export const uiOf = (state: ChangesStore, key: string): ChangesUi => state.by[key] ?? EMPTY;

export function patchChanges(key: string, change: Partial<ChangesUi>): void {
	useChanges.setState((s) => {
		const by = { ...s.by, [key]: { ...uiOf(s, key), ...change } };
		const order = [...s.order.filter((k) => k !== key), key];
		while (order.length > KEPT) delete by[order.shift() as string];
		return { by, order };
	});
}

export function setDiffMode(mode: DiffMode): void {
	useChanges.setState({ mode });
}
