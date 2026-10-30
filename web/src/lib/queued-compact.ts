import type { CompactEnded } from "@shared/compact-queue.ts";
import "../i18n/later.ts";
import { t } from "../i18n/index.ts";
import { insertIntoComposer } from "./composer-bridge.ts";

/**
 * A compact that waited for the end of a turn, or for a step of it, is over (#651); said by the page that shows the conversation (see
 * `LiveInfo.compactEnded`). One omp could not do says why (a conversation too small to compact is the usual one); messages
 * the server could not send after it are put back in the message box, as Stop puts back the queue.
 */
export function noteQueuedCompactEnd(
	ended: CompactEnded,
	toast: (level: "error" | "warning", text: string) => void,
): void {
	if (!ended.ok)
		toast(
			"error",
			t(ended.stopped ? "chat.queuedCompactStopped" : "chat.queuedCompactFailed", { error: ended.error ?? "" }),
		);
	const returned = ended.returned ?? [];
	if (returned.length > 0 && insertIntoComposer(returned.join("\n\n"), false))
		toast("warning", t("chat.queuedCompactReturned"));
}
