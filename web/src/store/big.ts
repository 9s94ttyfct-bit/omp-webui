import { create } from "zustand";
import { whenFree } from "../lib/leave-guard.ts";

/**
 * A file, or one file's change, opened large in place of the conversation's column (`BigView.tsx`). It is the page's own
 * state, like the side panel's width and the subagent shown full screen: the column it covers stays mounted, so closing it
 * finds the transcript where it was and the draft still typed.
 *
 * It is kept for the conversation it was opened in (`chatKey`, see `lib/chat-key.ts`): another conversation, or New chat,
 * does not show it. Nothing of this module is in the first page load — the panel and `ChatView` are chunks of their own —
 * and nothing of `BigView` is imported here, so the view itself loads when something is first opened large.
 */

/** What is open large: a file of the conversation's folder (`/api/folder/file`), or one file's change (`/api/folder/diff`). */
export interface BigTarget {
	kind: "file" | "diff";
	/** The path, relative to the conversation's folder (the panel names files so). */
	path: string;
}

interface BigState {
	/** The conversation it was opened in; null when nothing is open large. */
	chatKey: string | null;
	target: BigTarget | null;
}

export const useBig = create<BigState>(() => ({ chatKey: null, target: null }));

/** What had focus (or was pressed) when the view opened: focus goes back to it when the view closes. */
let opener: HTMLElement | null = null;

/** The element that opened the view, once: for the view to give focus back to it when it closes. */
export function takeBigOpener(): HTMLElement | null {
	const el = opener;
	opener = null;
	return el?.isConnected ? el : null;
}

/**
 * Show `target` large over the conversation `chatKey` names. Opening another file while one is large replaces it (the
 * panel's list is one click from the next). `from` is the control that was pressed: a button does not take focus when
 * pressed in every browser, so the focused element alone cannot say what opened it. A file that is being edited and has
 * unsaved text asks first (`lib/leave-guard.ts`).
 */
export function openBig(chatKey: string, target: BigTarget, from?: Element | null): void {
	const cur = useBig.getState();
	if (cur.chatKey === chatKey && cur.target?.kind === target.kind && cur.target.path === target.path) return;
	const focused = document.activeElement;
	const source = from ?? (focused === document.body ? null : focused);
	whenFree(null, () => {
		opener = source instanceof HTMLElement ? source : null;
		useBig.setState({ chatKey, target });
	});
}

/** Close the large view: back to the conversation as it was left (it stays mounted underneath). Unsaved text in its editor is asked about first. */
export function closeBig(): void {
	if (useBig.getState().target === null) return;
	whenFree(null, () => useBig.setState({ chatKey: null, target: null }));
}
