import { create } from "zustand";

/**
 * "Change folder…" of a conversation (v0.17.0), from its sidebar menu or from the folder on its status line: which
 * conversation the folder picker is open for. The picker and the move are a chunk of their own (`ChangeFolderDialog.tsx`),
 * which the app loads when one is asked for.
 */
export interface ChangeFolderAsk {
	/** Its session file; null for a new chat that has none yet (then `liveId` names it). */
	file: string | null;
	liveId: string | null;
	/** Its folder now: where the picker opens. */
	cwd: string;
}

export const useChangeFolder = create<{ ask: ChangeFolderAsk | null; moving: boolean }>(() => ({
	ask: null,
	moving: false,
}));

export function askChangeFolder(ask: ChangeFolderAsk): void {
	if (!useChangeFolder.getState().moving) useChangeFolder.setState({ ask });
}
