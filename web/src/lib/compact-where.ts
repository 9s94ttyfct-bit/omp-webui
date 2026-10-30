import { type CompactWhere, compactWhereOf } from "@shared/compact-queue.ts";
import { PREF } from "@shared/prefs.ts";
import { useSyncExternalStore } from "react";
import { onPrefsChanged, setPref } from "./prefs.ts";

/**
 * Where a compact queued while the agent works runs (#651): the preference `ompw.compactWhere`, read as everything reads a
 * preference (`localStorage`, kept in step with the server by `lib/prefs.ts`). It is only where a conversation's own choice
 * starts from: This session has the choice for the compact in front of it, and says what the conversation could give.
 */

const changed = new Set<() => void>();

/** The place a stored value names; anything else (not set, a value from another version) is the end of the turn. */
export const compactWhereFrom = (v: string | null): CompactWhere => compactWhereOf(v) ?? "turn";

export const compactWherePref = (): CompactWhere => compactWhereFrom(localStorage.getItem(PREF.compactWhere));

/** Choose the place: remembered here and on the server (`setPref`), and everything that shows it told. */
export function setCompactWherePref(where: CompactWhere): void {
	setPref(PREF.compactWhere, where);
	for (const fn of changed) fn();
}

function subscribe(fn: () => void): () => void {
	changed.add(fn);
	const stop = onPrefsChanged((keys) => keys.includes(PREF.compactWhere) && fn());
	return () => {
		changed.delete(fn);
		stop();
	};
}

/** The place now; the component draws again only when it changes. */
export function useCompactWherePref(): CompactWhere {
	return useSyncExternalStore(subscribe, compactWherePref, () => "turn");
}
