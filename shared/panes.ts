/**
 * The chat's side panel is two panes, one above the other. Each has a row of tabs and shows one of them; a tab is in exactly
 * one pane's row, and the rows together hold every tab of the panel. The layout (which tabs each row lists and in what order,
 * which tab each pane shows, which pane is folded to its tab row, where the divider is) is a synced preference
 * (`PREF.panelPanes`), so the server accepts only what the page writes and the page reads back only what is valid.
 */

/** Every tab of the panel. A tab added here is also listed in `DEFAULT_ROWS`: that is where a layout stored before it goes. */
export const PANEL_TABS = [
	"agents",
	"todos",
	"jobs",
	"files",
	"issues",
	"ci",
	"info",
	"tree",
	"btw",
	"host",
	"terminal",
	"guidance",
	"questions",
	"worktrees",
] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export type PaneId = "top" | "bottom";
export const PANES: readonly PaneId[] = ["top", "bottom"];
export const otherPane = (pane: PaneId): PaneId => (pane === "top" ? "bottom" : "top");

/** The tabs each pane's row lists, in order. */
export type PaneRows = Record<PaneId, readonly PanelTab[]>;

export interface PaneLayout {
	/** The tabs each row lists, in order. Every tab of the panel is in one row, once; a pane whose row is empty is closed. */
	rows: PaneRows;
	/** The tab each pane shows: one of its own row's, or null for a pane with no tabs. */
	shown: Record<PaneId, PanelTab | null>;
	/** The pane folded to its tab row, so that the other takes the height. At most one, and only while both panes are open. */
	collapsed: PaneId | null;
	/** The top pane's share of the panes' height; null is the default. */
	split: number | null;
}

/** The divider's reach: the share the top pane can have (a pane's own least height is enforced where the height is known). */
export const SPLIT_BOUNDS = { min: 0.1, max: 0.9 } as const;
export const DEFAULT_SPLIT = 0.5;

/** What the panel opens with: the tabs of the conversation above, the files and the side tools below. */
export const DEFAULT_ROWS: PaneRows = {
	top: ["agents", "todos", "jobs", "tree", "info", "guidance", "questions"],
	bottom: ["files", "issues", "ci", "btw", "host", "terminal", "worktrees"],
};

export const DEFAULT_PANES: PaneLayout = {
	rows: DEFAULT_ROWS,
	shown: { top: "agents", bottom: "files" },
	collapsed: null,
	split: null,
};

export const isPanelTab = (v: unknown): v is PanelTab => (PANEL_TABS as readonly unknown[]).includes(v);

/** The pane whose row lists `tab` in `rows`. */
export const paneOfTab = (rows: PaneRows, tab: PanelTab): PaneId => (rows.top.includes(tab) ? "top" : "bottom");

/**
 * The rows a stored list says: unknown ids are dropped, a tab listed twice keeps its first place (the top row is read first),
 * and a tab that is not listed (one a later version added) goes at the end of the row it has by default. So every tab of the
 * panel is in one row, once.
 */
function settleRows(top: readonly unknown[], bottom: readonly unknown[]): PaneRows {
	const seen = new Set<PanelTab>();
	const keep = (list: readonly unknown[]): PanelTab[] => {
		const out: PanelTab[] = [];
		for (const id of list) {
			if (isPanelTab(id) && !seen.has(id)) {
				seen.add(id);
				out.push(id);
			}
		}
		return out;
	};
	const rows: { top: PanelTab[]; bottom: PanelTab[] } = { top: keep(top), bottom: keep(bottom) };
	for (const tab of PANEL_TABS)
		if (!seen.has(tab)) rows[DEFAULT_ROWS.bottom.includes(tab) ? "bottom" : "top"].push(tab);
	return rows;
}

/**
 * The rows of a layout stored before the rows were (version 1: a tab for each pane, every tab listed in both rows): each pane
 * keeps the tab it showed, which goes at the end of that pane's row, and the rest follow the default rows.
 */
function migrateRows(top: PanelTab, bottom: PanelTab): PaneRows {
	const rows: { top: PanelTab[]; bottom: PanelTab[] } = {
		top: [...DEFAULT_ROWS.top],
		bottom: [...DEFAULT_ROWS.bottom],
	};
	for (const [pane, tab] of [
		["top", top],
		["bottom", bottom],
	] as const) {
		const from = otherPane(pane);
		const at = rows[from].indexOf(tab);
		if (at < 0) continue;
		rows[from].splice(at, 1);
		rows[pane].push(tab);
	}
	return rows;
}

/** The tab a pane shows when its row is `row` and the stored layout says `stored`: that one if the row lists it, else the row's first. */
const shownIn = (row: readonly PanelTab[], stored: unknown): PanelTab | null =>
	isPanelTab(stored) && row.includes(stored) ? stored : (row[0] ?? null);

/**
 * The layout a stored value says, or null for anything the page does not write (then the default is drawn). A layout of
 * version 2 has the rows; one with no version is what the page wrote before them, and is migrated (`migrateRows`).
 */
export function parsePanes(value: string | null): PaneLayout | null {
	if (value === null) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(value);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const { version, rows: storedRows, top, bottom, collapsed, split } = raw as Record<string, unknown>;
	if (collapsed !== undefined && collapsed !== "top" && collapsed !== "bottom") return null;
	if (split !== undefined && !(typeof split === "number" && split >= SPLIT_BOUNDS.min && split <= SPLIT_BOUNDS.max)) {
		return null;
	}
	let rows: PaneRows;
	let shown: Record<PaneId, PanelTab | null>;
	if (version === undefined) {
		if (!isPanelTab(top) || !isPanelTab(bottom) || top === bottom) return null;
		rows = migrateRows(top, bottom);
		shown = { top, bottom };
	} else if (version === 2) {
		if (typeof storedRows !== "object" || storedRows === null || Array.isArray(storedRows)) return null;
		const { top: topRow, bottom: bottomRow } = storedRows as Record<string, unknown>;
		if (!Array.isArray(topRow) || !Array.isArray(bottomRow)) return null;
		for (const shownTab of [top, bottom]) if (shownTab !== undefined && typeof shownTab !== "string") return null;
		rows = settleRows(topRow, bottomRow);
		shown = { top: shownIn(rows.top, top), bottom: shownIn(rows.bottom, bottom) };
	} else {
		return null;
	}
	// A pane is folded only beside an open one: with the other closed, the pane's row would be all there is of the panel.
	const folded = rows.top.length > 0 && rows.bottom.length > 0 ? (collapsed ?? null) : null;
	return { rows, shown, collapsed: folded, split: split ?? null };
}

/** The value kept for a layout: the default layout is not kept at all (null), and anything else whole, so that it does not move with the default. */
export function serializePanes(layout: PaneLayout): string | null {
	if (samePanes(layout, DEFAULT_PANES)) return null;
	return JSON.stringify({
		version: 2,
		rows: { top: [...layout.rows.top], bottom: [...layout.rows.bottom] },
		// The tab each pane shows keeps the names the first version wrote, which a page of that version reads as it did.
		...(layout.shown.top ? { top: layout.shown.top } : {}),
		...(layout.shown.bottom ? { bottom: layout.shown.bottom } : {}),
		...(layout.collapsed ? { collapsed: layout.collapsed } : {}),
		...(layout.split !== null ? { split: layout.split } : {}),
	});
}

const sameRow = (a: readonly PanelTab[], b: readonly PanelTab[]): boolean =>
	a.length === b.length && a.every((tab, i) => tab === b[i]);

export const samePanes = (a: PaneLayout, b: PaneLayout): boolean =>
	a.shown.top === b.shown.top &&
	a.shown.bottom === b.shown.bottom &&
	a.collapsed === b.collapsed &&
	a.split === b.split &&
	sameRow(a.rows.top, b.rows.top) &&
	sameRow(a.rows.bottom, b.rows.bottom);
