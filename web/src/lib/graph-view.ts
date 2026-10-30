import { type GraphFilter, statusFilterOf, timeFilterOf } from "@shared/graph-filter.ts";
import { PREF, type PrefKey } from "@shared/prefs.ts";
import { useSyncExternalStore } from "react";
import { onPrefsChanged, setPref } from "./prefs.ts";

/**
 * How the agent graph is looked at (v0.12.2): siblings in a grid, the focus view (which brings the minimap) and the
 * status and time filters. One choice for every conversation's graph, remembered with the app's other preferences
 * (`ompw.agentGraph.*`, kept in step with the server by `lib/prefs.ts`), so it outlives a reload, a restart of the app and
 * the app's move to another port. What the toolbar holds only while it is used (the search, the opened batches, the
 * zoom, the folded Filters panel) is not here.
 */

export interface GraphViewPrefs {
	grid: boolean;
	focus: boolean;
	filter: GraphFilter;
}

const KEYS: readonly PrefKey[] = [PREF.graphGrid, PREF.graphFocus, PREF.graphStatus, PREF.graphTime];

/**
 * The view the stored values name. A value no version writes (edited by hand, or a filter a later version has and this one
 * does not) is that setting's default: off, or all.
 */
export function graphViewOf(get: (key: PrefKey) => string | null): GraphViewPrefs {
	return {
		grid: get(PREF.graphGrid) === "on",
		focus: get(PREF.graphFocus) === "on",
		filter: { status: statusFilterOf(get(PREF.graphStatus)), time: timeFilterOf(get(PREF.graphTime)) },
	};
}

/** The last view read, by the stored values it was read from: the same values are the same object (`useSyncExternalStore`). */
let held: { raw: string; view: GraphViewPrefs } | null = null;
function viewNow(): GraphViewPrefs {
	const raw = KEYS.map((k) => localStorage.getItem(k) ?? "").join("\n");
	if (held?.raw !== raw) held = { raw, view: graphViewOf((k) => localStorage.getItem(k)) };
	return held.view;
}

const changed = new Set<() => void>();
function subscribe(fn: () => void): () => void {
	changed.add(fn);
	const stop = onPrefsChanged((keys) => keys.some((k) => KEYS.includes(k)) && fn());
	return () => {
		changed.delete(fn);
		stop();
	};
}
const tell = () => {
	for (const fn of changed) fn();
};

export function setGraphGrid(on: boolean): void {
	setPref(PREF.graphGrid, on ? "on" : "off");
	tell();
}

export function setGraphFocus(on: boolean): void {
	setPref(PREF.graphFocus, on ? "on" : "off");
	tell();
}

export function setGraphFilter(filter: GraphFilter): void {
	setPref(PREF.graphStatus, filter.status);
	setPref(PREF.graphTime, filter.time);
	tell();
}

const DEFAULT_VIEW = graphViewOf(() => null);

/** The graph's view as it was last chosen, on any conversation's graph, in any tab or window. */
export function useGraphView(): GraphViewPrefs {
	return useSyncExternalStore(subscribe, viewNow, () => DEFAULT_VIEW);
}
