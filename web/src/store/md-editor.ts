import { extensionOf } from "@shared/folder.ts";
import { create } from "zustand";
import { whenFree } from "../lib/leave-guard.ts";

/**
 * The Markdown editor (`components/md/MdEditor.tsx`): one `.md` file of a conversation's folder, open over the whole window
 * with its source and its rendering side by side. It is opened from where the app shows a file (the Files tab's preview,
 * the large view, the Changes view, a path in the conversation) and kept for the conversation it was opened in (`chatKey`,
 * see `lib/chat-key.ts`), as the large view is (`store/big.ts`). Nothing of the editor is imported here: its chunk loads
 * when a file is first opened in it.
 */

export interface MdTarget {
	/** The conversation it was opened in. */
	chatKey: string;
	/** The file, relative to the conversation's folder. */
	path: string;
}

/** A section of the file to show (`guide.md#install`, see `lib/slug.ts`): a new object for each link followed, taken once shown. */
export interface MdJump {
	section: string;
}

export const useMdEditor = create<{ target: MdTarget | null; jump: MdJump | null }>(() => ({
	target: null,
	jump: null,
}));

/** Whether a path names a file the editor opens: what the Files tab renders as Markdown (`viewOf` on the server). */
export function isMarkdownPath(path: string): boolean {
	const ext = extensionOf(path.slice(path.lastIndexOf("/") + 1));
	return ext === "md" || ext === "markdown";
}

/** What had focus when the editor opened: focus goes back to it when the editor closes. */
let opener: HTMLElement | null = null;

/** The element that opened the editor, once. */
export function takeMdOpener(): HTMLElement | null {
	const el = opener;
	opener = null;
	return el?.isConnected ? el : null;
}

/**
 * Open `path` in the editor over the conversation `chatKey`, at its `section` when one is named (the preview scrolls to that
 * heading). Another file open in it is replaced, after asking when it has text that is not saved (and so is a file with
 * unsaved text in the large view's editor: `lib/leave-guard.ts`). The file already open only goes to the section.
 */
export function openMdEditor(chatKey: string, path: string, from?: Element | null, section?: string): void {
	const cur = useMdEditor.getState().target;
	const jump = section ? { section } : null;
	if (cur?.chatKey === chatKey && cur.path === path) {
		if (jump) useMdEditor.setState({ jump });
		return;
	}
	const focused = document.activeElement;
	const source = from ?? (focused === document.body ? null : focused);
	whenFree(null, () => {
		// The first file opened keeps the element to give focus back to; one opened from inside the editor does not replace it.
		if (cur === null) opener = source instanceof HTMLElement ? source : null;
		useMdEditor.setState({ target: { chatKey, path }, jump });
	});
}

/** The section the editor was opened at, once: the preview has scrolled to it (or it named none there). */
export function takeMdJump(): void {
	if (useMdEditor.getState().jump !== null) useMdEditor.setState({ jump: null });
}

/** Close the editor (unsaved text is asked about first). */
export function closeMdEditor(): void {
	if (useMdEditor.getState().target === null) return;
	whenFree(null, () => useMdEditor.setState({ target: null, jump: null }));
}
