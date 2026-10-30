import { MAX_PREF_LENGTH, PREF } from "@shared/prefs.ts";
import {
	BUILT_IN_IDS,
	DEFAULT_QUICK_PROMPTS,
	parseQuickPrompts,
	type QuickPrompt,
	serializeQuickPrompts,
} from "@shared/quick-prompts.ts";
import { useMemo, useSyncExternalStore } from "react";
import type { MessageKey, Translate } from "../i18n/index.ts";
import { onPrefsChanged, setPref } from "./prefs.ts";

/**
 * The quick prompts (#659): the preference `ompw.quickPrompts`, read as everything reads a preference (`localStorage`, kept
 * in step with the server by `lib/prefs.ts`), with `ompw.quickPromptsSeen`, the built-ins the saved list was made with
 * (a built-in added since joins it). The message box's menu and the Settings card read it through `useQuickPrompts`, so
 * an edit shows in the menu at once, and one made in another tab when `lib/prefs.ts` hears it.
 */

const changed = new Set<() => void>();

/** Both preferences in one string: what `useSyncExternalStore` compares. */
const stored = (): string =>
	JSON.stringify([localStorage.getItem(PREF.quickPrompts), localStorage.getItem(PREF.quickPromptsSeen)]);

function subscribe(fn: () => void): () => void {
	changed.add(fn);
	const stop = onPrefsChanged(
		(keys) => (keys.includes(PREF.quickPrompts) || keys.includes(PREF.quickPromptsSeen)) && fn(),
	);
	return () => {
		changed.delete(fn);
		stop();
	};
}

const parsed = (raw: string): QuickPrompt[] => {
	const [value, seen] = JSON.parse(raw) as [string | null, string | null];
	return parseQuickPrompts(value, seen);
};

/** The list now (the defaults until one is saved); the component draws again only when it changes. */
export function useQuickPrompts(): QuickPrompt[] {
	const raw = useSyncExternalStore(subscribe, stored, () => "[null,null]");
	return useMemo(() => parsed(raw), [raw]);
}

/** The prompts now, outside a component (the command palette). */
export const quickPrompts = (): QuickPrompt[] => parsed(stored());

export class QuickPromptsTooLarge extends Error {}

/**
 * Keep `list`: remembered here and on the server (`setPref`), and every menu told. The defaults as shipped are kept as
 * nothing; any other list is kept with the built-ins it was made with (all of today's), so that one removed stays
 * removed. Throws `QuickPromptsTooLarge` when the list does not fit a preference (16 KiB).
 */
export function saveQuickPrompts(list: readonly QuickPrompt[]): void {
	const value = serializeQuickPrompts(list);
	if (value !== null && value.length > MAX_PREF_LENGTH) throw new QuickPromptsTooLarge();
	setPref(PREF.quickPrompts, value);
	setPref(PREF.quickPromptsSeen, value === null ? null : JSON.stringify(BUILT_IN_IDS));
	for (const fn of changed) fn();
}

/** The name each built-in is shown by in the page's language, while the person keeps its shipped name. */
const BUILT_IN_NAMES: Record<string, MessageKey> = {
	"soft-stop": "quickPrompts.softStopName",
	"review-changes": "quickPrompts.presetReviewName",
	"write-tests": "quickPrompts.presetTestsName",
	summarize: "quickPrompts.presetSummaryName",
	"commit-work": "quickPrompts.presetCommitName",
	simplify: "quickPrompts.presetSimplifyName",
};

/** The name a prompt is shown by: a built-in that keeps its shipped name in the page's language, else its own. */
export function promptName(p: QuickPrompt, t: Translate): string {
	const shipped = DEFAULT_QUICK_PROMPTS.find((d) => d.id === p.id);
	const key = BUILT_IN_NAMES[p.id];
	return shipped && key && p.name === shipped.name ? t(key) : p.name;
}
