import {
	DEFAULT_PANES,
	DEFAULT_SPLIT,
	otherPane,
	PANEL_TABS,
	type PaneId,
	type PaneLayout,
	type PanelTab,
	paneOfTab,
	parsePanes,
	SPLIT_BOUNDS,
	samePanes,
	serializePanes,
} from "@shared/panes.ts";
import { PREF } from "@shared/prefs.ts";
import { useSyncExternalStore } from "react";
import { useApp } from "../store/app.ts";
import { PANEL_SHEET_QUERY, useMediaQuery } from "./media.ts";
import { onPrefsChanged, setPref } from "./prefs.ts";

/**
 * The side panel's two panes: which tabs each pane's row lists and in what order, which tab each pane shows, which one is
 * folded to its tab row, and where the divider is. A tab is in one row only. A preference (localStorage, read when this
 * module loads so the first paint already has it, and kept by the server so that another port or window finds it), like the
 * panel's width. A phone-sized window shows one pane with every tab in its row, and leaves the layout as it is.
 */

// ------------------------------------------------------------------ transitions (pure)

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** `tab` shown in the pane that lists it, and that pane opened if it was folded: someone who picks a tab wants to see it. */
export function pick(layout: PaneLayout, tab: PanelTab): PaneLayout {
	const pane = paneOfTab(layout.rows, tab);
	const next = layout.shown[pane] === tab ? layout : { ...layout, shown: { ...layout.shown, [pane]: tab } };
	return next.collapsed === pane ? { ...next, collapsed: null } : next;
}

/**
 * `tab` put in `pane`'s row at `slot`: 0 is before the row's first tab and its length after the last, counted in the row as it
 * is now (so the slots on either side of the tab itself leave it where it is). Within its own row a tab only moves: what each
 * pane shows and whether it is folded stay as they were. Into the other pane it is shown there, and that pane is opened if it
 * was folded or closed; the pane it left shows the tab next to it now if it showed this one, and is closed when it has no tab
 * left (a closed pane is not folded).
 */
export function place(layout: PaneLayout, tab: PanelTab, pane: PaneId, slot: number): PaneLayout {
	const from = paneOfTab(layout.rows, tab);
	const source = layout.rows[from];
	const at = source.indexOf(tab);
	const rest = source.filter((x) => x !== tab);
	if (from === pane) {
		const to = clamp(slot, 0, source.length) - (slot > at ? 1 : 0);
		if (to === at) return layout;
		return { ...layout, rows: { ...layout.rows, [pane]: [...rest.slice(0, to), tab, ...rest.slice(to)] } };
	}
	const target = [...layout.rows[pane]];
	target.splice(clamp(slot, 0, target.length), 0, tab);
	const shown = { ...layout.shown, [pane]: tab };
	if (layout.shown[from] === tab) shown[from] = rest[Math.min(at, rest.length - 1)] ?? null;
	return {
		...layout,
		rows: { ...layout.rows, [from]: rest, [pane]: target },
		shown,
		collapsed: layout.collapsed === pane || rest.length === 0 ? null : layout.collapsed,
	};
}

/** `tab` one place along its row: -1 to the left, 1 to the right; the layout as it is where the tab is already at that end. */
export function moveBy(layout: PaneLayout, tab: PanelTab, step: -1 | 1): PaneLayout {
	const pane = paneOfTab(layout.rows, tab);
	const at = layout.rows[pane].indexOf(tab);
	return place(layout, tab, pane, step < 0 ? at - 1 : at + 2);
}

/** `tab` at the end of the other pane's row, and shown there. */
export function moveAcross(layout: PaneLayout, tab: PanelTab): PaneLayout {
	const to = otherPane(paneOfTab(layout.rows, tab));
	return place(layout, tab, to, layout.rows[to].length);
}

/**
 * Fold the pane to its tab row, or open it again. Folding a pane while the other is folded opens the other: at most one is
 * folded. A pane that is the whole panel (the other has no tab) does not fold.
 */
export function toggleFold(layout: PaneLayout, pane: PaneId): PaneLayout {
	if (layout.rows[otherPane(pane)].length === 0) return layout;
	return { ...layout, collapsed: layout.collapsed === pane ? null : pane };
}

/** Whether `tab` is on show in a pane: the one its pane shows, while that pane is not folded. */
export function isShown(layout: PaneLayout, tab: PanelTab): boolean {
	const pane = paneOfTab(layout.rows, tab);
	return layout.shown[pane] === tab && layout.collapsed !== pane;
}

/** A tab row's height in px: the top one is the chat header's (`h-13`), so that the two rules across the seam are one line. */
export const ROW_HEIGHT = { top: 52, bottom: 40 } as const;
/** The least a pane's body keeps when the divider is moved: a few rows of whatever it shows. */
export const MIN_BODY = 104;

/** The divider's reach for panes `height` px tall: the share the top pane can have, from the least height of either pane. */
export function shareBounds(height: number): { min: number; max: number } {
	if (height <= 0) return { min: SPLIT_BOUNDS.min, max: SPLIT_BOUNDS.max };
	const min = Math.max(SPLIT_BOUNDS.min, (ROW_HEIGHT.top + MIN_BODY) / height);
	const max = Math.min(SPLIT_BOUNDS.max, 1 - (ROW_HEIGHT.bottom + MIN_BODY) / height);
	// A panel too short for both minimums splits at the middle.
	return min > max ? { min: 0.5, max: 0.5 } : { min, max };
}

// ------------------------------------------------------------------ the remembered layout

function readStored(): PaneLayout {
	try {
		return parsePanes(localStorage.getItem(PREF.panelPanes)) ?? DEFAULT_PANES;
	} catch {
		return DEFAULT_PANES;
	}
}

let layout: PaneLayout = readStored();
const listeners = new Set<() => void>();

function subscribe(l: () => void) {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
}

export const currentPanes = (): PaneLayout => layout;

/**
 * Show a layout. `persist: false` only draws it: a drag shows every share on its way and keeps the one it ends on
 * (`commitPanes`), instead of writing the file a dozen times a second.
 */
export function setPanes(next: PaneLayout, persist = true): void {
	if (samePanes(layout, next)) return;
	layout = next;
	if (persist) commitPanes();
	for (const l of listeners) l();
}

/** Keep the layout now drawn: in localStorage, and on the server shortly. */
export function commitPanes(): void {
	try {
		setPref(PREF.panelPanes, serializePanes(layout));
	} catch {
		// Private mode or a full quota: the layout still applies until reload.
	}
}

/** Another page chose the layout: show what localStorage now holds. */
export function reloadPanes(): void {
	const next = readStored();
	if (samePanes(next, layout)) return;
	layout = next;
	for (const l of listeners) l();
}

// The layout can be chosen in another tab or window (the server's copy then arrives in localStorage). This module registers
// itself, so that the page's start-up code does not have to load it.
onPrefsChanged((keys) => {
	if (keys.includes(PREF.panelPanes)) reloadPanes();
});

/** Back to the default divider position. */
export const resetSplit = (): void => setPanes({ ...layout, split: null });

/** A part of the layout, for a component that draws only that part (a drag moves the divider without redrawing the tab rows). */
export function usePanes<T>(select: (l: PaneLayout) => T): T {
	return useSyncExternalStore(subscribe, () => select(layout));
}

/** The top pane's share of the height now drawn. */
export const splitOf = (l: PaneLayout): number => l.split ?? DEFAULT_SPLIT;

// ------------------------------------------------------------------ the sheet, and showing a tab from outside the panel

// A sheet (a phone-sized window) is one pane with every tab in its row, top row first. The tab it shows is its own choice and
// not the layout's: picking one there must not move a tab of the layout the desktop draws (the layout is shared with the other
// pages through the server), and a tab of the bottom row has no place in the top pane. It is not remembered.
let sheetChoice: PanelTab | null = null;

/** The tab a sheet shows: the one chosen in it, else the one the top pane shows (the bottom pane's when the top is closed). */
export const sheetTabOf = (l: PaneLayout): PanelTab => sheetChoice ?? l.shown.top ?? l.shown.bottom ?? PANEL_TABS[0];

/** Show `tab` in the sheet. */
export function chooseSheetTab(tab: PanelTab): void {
	if (sheetChoice === tab) return;
	sheetChoice = tab;
	for (const l of listeners) l();
}

/** Open the side panel on `tab`: in the pane that lists it, opened if it was folded (a sheet shows it in its one pane). */
export function showPanelTab(tab: PanelTab): void {
	if (matchMedia(PANEL_SHEET_QUERY).matches) chooseSheetTab(tab);
	else setPanes(pick(layout, tab));
	useApp.getState().set({ panelOpen: true });
}

/**
 * Whether a pane of the open side panel is showing `tab` (the strip and the jobs list above the composer step aside for
 * the pane that shows them). False with the panel closed, and in a sheet over the conversation, where the page behind it
 * is still the thing being read.
 */
export function useShownInPanel(tab: PanelTab): boolean {
	const open = useApp((s) => s.panelOpen);
	const sheet = useMediaQuery(PANEL_SHEET_QUERY);
	const shown = usePanes((l) => isShown(l, tab));
	return open && !sheet && shown;
}
