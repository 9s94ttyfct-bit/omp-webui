import { useApp, type View } from "../store/app.ts";
import { nextChatKey } from "./chat-key.ts";

/**
 * Whether going to the view `next` stays in the conversation shown now: an editor over it (the large view's, the Markdown
 * editor) is then not left, and what is unsaved in it is not lost (`lib/leave-guard.ts`).
 */
export function inConversation(next: View): boolean {
	const now = useApp.getState().view;
	if (now.kind !== "chat" || next.kind !== "chat") return false;
	const here = nextChatKey(null, now);
	return nextChatKey(here, next).key === here.key;
}
