import { PREF } from "@shared/prefs.ts";
import { useSyncExternalStore } from "react";
import { onPrefsChanged, setPref } from "./prefs.ts";

/**
 * Which tool calls show how long they run (#657): the preference `ompw.toolTimer`, read as everything reads a preference
 * (`localStorage`, kept in step with the server by `lib/prefs.ts`). Every card reads it through `useToolTimerMode`, so a
 * change made in Settings shows on the cards at once, and one made in another tab or window when `lib/prefs.ts` hears it.
 */

const changed = new Set<() => void>();

/** What `ompw.toolTimer` can hold: a timer on every tool call, on shell commands only, or none. */
export const TOOL_TIMERS = ["all", "shell", "off"] as const;
export type ToolTimerMode = (typeof TOOL_TIMERS)[number];

/** The mode a stored value names; anything else (not set, a value from another version) is `all`. */
export const toolTimerOf = (v: string | null): ToolTimerMode => TOOL_TIMERS.find((m) => m === v) ?? "all";

export const toolTimerMode = (): ToolTimerMode => toolTimerOf(localStorage.getItem(PREF.toolTimer));

/** Choose the mode: remembered here and on the server (`setPref`), and every card told. */
export function setToolTimerMode(mode: ToolTimerMode): void {
	setPref(PREF.toolTimer, mode);
	for (const fn of changed) fn();
}

function subscribe(fn: () => void): () => void {
	changed.add(fn);
	const stop = onPrefsChanged((keys) => keys.includes(PREF.toolTimer) && fn());
	return () => {
		changed.delete(fn);
		stop();
	};
}

/** The mode now; the component draws again only when it changes. */
export function useToolTimerMode(): ToolTimerMode {
	return useSyncExternalStore(subscribe, toolTimerMode, () => "all");
}
