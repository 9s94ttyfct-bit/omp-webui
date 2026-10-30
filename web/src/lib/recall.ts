import type { SessionEntry } from "@shared/protocol.ts";
import { Fold } from "./lineage.ts";
import { messageOf, textOf } from "./messages.ts";

/**
 * Up and Down in the composer walk through what was sent in the conversation, like the terminal's prompt
 * history. The history is read from the transcript, so it is the same after a reload.
 */

/** Where the walk is: `back` prompts before the newest (1 = the newest), and the text the composer held before it began. */
export interface Recall {
	back: number;
	draft: string;
}

/** The user's prompts, and the `!commands` they ran, in the order they were sent; a repeat in a row counts once. */
export function promptsOf(path: SessionEntry[]): string[] {
	return sentFold.run(path).list;
}

/** The list changes only when something was sent: the same array is returned while it did not, and the path is read from where it was last. */
const sentFold = new Fold<SessionEntry, { list: string[] }>(
	() => ({ list: [] }),
	(sent, path, from) => {
		let list = sent.list;
		for (let i = from; i < path.length; i++) {
			const m = messageOf(path[i]);
			if (!m) continue;
			let text = "";
			// Messages omp wrote on its own (reminders, injected context) carry another attribution.
			if (m.role === "user" && m.attribution !== "agent") text = textOf(m).trim();
			else if (m.role === "bashExecution" && m.command) text = `!${m.command}`;
			if (text && text !== list.at(-1)) list = [...list, text];
		}
		return list === sent.list ? sent : { list };
	},
);

/** Up: one prompt further back. Null when there is nothing to recall, so the key keeps its ordinary job. */
export function recallUp(
	history: string[],
	current: string,
	state: Recall | null,
): { text: string; state: Recall } | null {
	if (!history.length) return null;
	const back = (state?.back ?? 0) + 1;
	// Already at the oldest prompt: it stays, and the key is still taken.
	if (state && back > history.length) return { text: current, state };
	return { text: history[history.length - back], state: { back, draft: state ? state.draft : current } };
}

/** Down: one prompt forward, and past the newest the draft comes back. Null when no walk is going on. */
export function recallDown(history: string[], state: Recall | null): { text: string; state: Recall | null } | null {
	if (!state) return null;
	if (state.back <= 1) return { text: state.draft, state: null };
	const back = state.back - 1;
	return { text: history[history.length - back], state: { back, draft: state.draft } };
}
