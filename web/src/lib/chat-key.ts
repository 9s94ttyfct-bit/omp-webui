import type { View } from "../store/app.ts";

type ChatView = Extract<View, { kind: "chat" }>;

export interface ChatKey {
	file: string | null;
	liveId: string | null;
	leaf?: string;
	focus?: string;
	key: string;
}

/**
 * React key for the chat page. A view that gains a process (resume: `{file}` →
 * `{file, liveId}`) or a file (new chat: `{liveId}` → `{file, liveId}`) is the same
 * conversation and keeps its key, so the page — and the composer's draft — is not
 * remounted. So does one whose process moved to a new session file (`from` names the
 * file it left: branch, fork, /new). Another file, process, branch leaf or focus
 * target gets a new key.
 */
export function nextChatKey(prev: ChatKey | null, view: ChatView): ChatKey {
	const same =
		prev !== null &&
		prev.leaf === view.leaf &&
		prev.focus === view.focus &&
		((view.file !== null && view.file === prev.file) ||
			(view.liveId !== null && view.liveId === prev.liveId) ||
			(view.from !== undefined && view.from === prev.file));
	const key = same ? prev.key : `${view.liveId ?? view.file ?? "none"}:${view.leaf ?? ""}:${view.focus ?? ""}`;
	return { file: view.file, liveId: view.liveId, leaf: view.leaf, focus: view.focus, key };
}
