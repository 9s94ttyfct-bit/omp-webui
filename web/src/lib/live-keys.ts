import type { SessionEntry } from "@shared/protocol.ts";
import type { OverlayMessage } from "../store/live.ts";
import { messageOf } from "./messages.ts";

/**
 * A message streams as an overlay row and, once omp saves it, is a row of the saved transcript: to the reader the same
 * message. React tells rows apart by their key, so the saved row must carry the key the streamed one had, or its DOM is
 * torn down and built anew (the text fades in from nothing, a thinking block the reader opened closes, a selection is
 * lost). omp gives the saved message the `timestamp` it streamed with; that is how the two are matched.
 */

/** The claims kept: a claim is dropped only long after its message was saved, when nothing of it is on screen. */
const MAX_CLAIMS = 5000;

export class LiveKeys {
	/** The key a streamed message was drawn under, by its `timestamp`. */
	private readonly claimed = new Map<number, string>();

	/** The key of the row that streams `o`. */
	overlay(o: OverlayMessage): string {
		return `live:${o.messageId}`;
	}

	/** Remember the streamed messages on screen: the saved entry that replaces one is drawn under its key. */
	note(overlay: readonly OverlayMessage[]): void {
		for (const o of overlay) {
			const at = o.message.role === "assistant" ? o.message.timestamp : undefined;
			if (!at || this.claimed.get(at) === this.overlay(o)) continue;
			// Re-inserted, so the newest claims are the last to go.
			this.claimed.delete(at);
			this.claimed.set(at, this.overlay(o));
		}
		for (const at of this.claimed.keys()) {
			if (this.claimed.size <= MAX_CLAIMS) break;
			this.claimed.delete(at);
		}
	}

	/** The key of the row that draws a saved entry: its own id, or that of the streamed message it replaced. */
	entry(e: SessionEntry): string {
		const m = messageOf(e);
		const at = m?.role === "assistant" ? m.timestamp : undefined;
		return (at && this.claimed.get(at)) || e.id;
	}
}
