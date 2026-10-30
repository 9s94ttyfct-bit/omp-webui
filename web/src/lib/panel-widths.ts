import { PREF } from "@shared/prefs.ts";
import { useMemo, useSyncExternalStore } from "react";
import { useApp } from "../store/app.ts";
import { PANEL_SHEET_QUERY, useMediaQuery } from "./media.ts";
import { setPref } from "./prefs.ts";

/**
 * The widths of the left sidebar and the chat's right side panel. Each is remembered (a preference: localStorage, read
 * when this module loads, before the first render, so the layout never jumps, and kept by the server so that another
 * port finds it) and bounded: by its own min and max, and by the room the conversation column keeps. Phone layouts
 * (sidebar as a drawer, the panel as a sheet) do not use them.
 */

export type PanelKind = "sidebar" | "panel";

/** Below this window width the sidebar is a drawer (Tailwind's `max-[900px]`). */
export const DRAWER_MAX_WIDTH = 900;
/** The strip that stays where the sidebar was when it is put away, in a window wide enough for the sidebar to be a column. */
export const RAIL_WIDTH = 48;
/** The least width the conversation column keeps beside a sidebar and a side panel: room for the composer's controls. */
export const CHAT_MIN = 480;

export const LIMITS: Record<PanelKind, { min: number; max: number; def: number }> = {
	sidebar: { min: 200, max: 480, def: 288 },
	// Wide enough for every tab of a pane to show its label (nine since the Issues tab, #653).
	panel: { min: 280, max: 720, def: 400 },
};

const KEYS = { sidebar: PREF.sidebarWidth, panel: PREF.panelWidth } as const;

type Stored = Record<PanelKind, number | null>;

function readStored(kind: PanelKind): number | null {
	try {
		const n = Number(localStorage.getItem(KEYS[kind]));
		return Number.isFinite(n) && n > 0 ? n : null;
	} catch {
		return null;
	}
}

let stored: Stored = { sidebar: readStored("sidebar"), panel: readStored("panel") };
const listeners = new Set<() => void>();

function emit() {
	for (const l of listeners) l();
}

function subscribeStored(l: () => void) {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
}

/**
 * Remember a width (null forgets it, back to the default). `persist: false` only draws it: a drag shows every width on
 * its way and keeps the one it ends on (`commitStoredWidth`), instead of writing the file a dozen times a second.
 */
export function setStoredWidth(kind: PanelKind, px: number | null, persist = true) {
	const next = px === null ? null : Math.round(px);
	if (stored[kind] === next) return;
	stored = { ...stored, [kind]: next };
	if (persist) commitStoredWidth(kind);
	emit();
}

/** Keep the width now drawn: in localStorage, and on the server shortly. */
export function commitStoredWidth(kind: PanelKind) {
	const px = stored[kind];
	try {
		setPref(KEYS[kind], px === null ? null : String(px));
	} catch {
		// Private mode or a full quota: the width still applies until reload.
	}
}

/** Another page chose the widths: show what localStorage now holds. */
export function reloadStoredWidths() {
	const next: Stored = { sidebar: readStored("sidebar"), panel: readStored("panel") };
	if (next.sidebar === stored.sidebar && next.panel === stored.panel) return;
	stored = next;
	emit();
}

/** Back to the default size, for both. */
export function resetAllWidths() {
	setStoredWidth("sidebar", null);
	setStoredWidth("panel", null);
}

export interface Layout {
	/** The widths to draw: what is remembered, kept inside the bounds and the chat column's room. */
	width: Record<PanelKind, number>;
	/** The widest each can be right now (the other one counted at its drawn width). */
	max: Record<PanelKind, number>;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Pure layout math: which of the two sit beside the conversation at window width `vw`, and how wide they can be. */
export function computeLayout(vw: number, visible: Record<PanelKind, boolean>, remembered: Stored): Layout {
	const { sidebar: S, panel: P } = LIMITS;
	const room = vw - CHAT_MIN;
	let s = clamp(remembered.sidebar ?? S.def, S.min, S.max);
	let p = clamp(remembered.panel ?? P.def, P.min, P.max);
	// A narrower window takes the room from the panel first, then from the sidebar; widening it gives it back.
	if (visible.sidebar && visible.panel && s + p > room) {
		p = Math.max(P.min, room - s);
		s = Math.max(S.min, Math.min(s, room - p));
	} else if (visible.sidebar && s > room) {
		s = Math.max(S.min, room);
	} else if (visible.panel && p > room) {
		p = Math.max(P.min, room);
	}
	return {
		width: { sidebar: s, panel: p },
		max: {
			sidebar: clamp(room - (visible.panel ? p : 0), S.min, S.max),
			panel: clamp(room - (visible.sidebar ? s : 0), P.min, P.max),
		},
	};
}

function subscribeResize(onChange: () => void) {
	window.addEventListener("resize", onChange);
	return () => window.removeEventListener("resize", onChange);
}

/** The window width the page's columns share: the rail, where the sidebar is put away, is not theirs. */
function sharedWidth(vw: number, sidebarOpen: boolean): number {
	return vw > DRAWER_MAX_WIDTH && !sidebarOpen ? vw - RAIL_WIDTH : vw;
}

function visibility(vw: number, sidebarOpen: boolean, panelOpen: boolean, chat: boolean): Record<PanelKind, boolean> {
	return {
		sidebar: sidebarOpen && vw > DRAWER_MAX_WIDTH,
		panel: panelOpen && chat && !matchMedia(PANEL_SHEET_QUERY).matches,
	};
}

/** The current layout, outside React (a drag reads it on every move). */
export function currentLayout(): Layout {
	const s = useApp.getState();
	const vw = window.innerWidth;
	return computeLayout(
		sharedWidth(vw, s.sidebarOpen),
		visibility(vw, s.sidebarOpen, s.panelOpen, s.view.kind === "chat"),
		stored,
	);
}

/** The current layout; re-renders when a width is remembered, the window resizes, or a panel opens or closes. */
export function useLayout(): Layout {
	const remembered = useSyncExternalStore(subscribeStored, () => stored);
	const vw = useSyncExternalStore(subscribeResize, () => window.innerWidth);
	const sidebarOpen = useApp((s) => s.sidebarOpen);
	const panelOpen = useApp((s) => s.panelOpen);
	const chat = useApp((s) => s.view.kind === "chat");
	return useMemo(
		() => computeLayout(sharedWidth(vw, sidebarOpen), visibility(vw, sidebarOpen, panelOpen, chat), remembered),
		[vw, sidebarOpen, panelOpen, chat, remembered],
	);
}

/** The width of the toast stack (Toasts' `w-[min(21.5rem,…)]`) and the gap it keeps from the window's edge, in px. */
const TOAST_STACK = 344 + 8;

export interface ToastPlace {
	/** How far the stack stands from the window's right edge: the width of what covers it there. */
	inset: number;
	/** The stack stands over the sheet, at the bottom of the window: there is no room beside the sheet for it. */
	overSheet: boolean;
}

/**
 * Where the toast stack goes so that it does not cover the side panel, whose first row has the Stop button a toast
 * raised by a Stop must leave free. Beside the conversation the panel is a column and the stack stands left of it; as a
 * sheet over the conversation it is as wide as the sheet if the window has the room for the stack beside it (a tablet),
 * else the stack goes over the sheet, at the bottom of the window, below the rows the sheet opens on (a phone), where
 * the conversation's composer is not to be kept clear of: the sheet covers it.
 */
export function useToastPlace(): ToastPlace {
	const { width } = useLayout();
	const vw = useSyncExternalStore(subscribeResize, () => window.innerWidth);
	const panelOpen = useApp((s) => s.panelOpen);
	const chat = useApp((s) => s.view.kind === "chat");
	const sheet = useMediaQuery(PANEL_SHEET_QUERY);
	if (!panelOpen || !chat) return { inset: 0, overSheet: false };
	if (!sheet) return { inset: width.panel, overSheet: false };
	// The sheet's width: RightPanel's `w-[min(25rem,calc(100vw-3rem))]`.
	const inset = Math.min(400, vw - 48);
	return vw - inset >= TOAST_STACK ? { inset, overSheet: false } : { inset: 0, overSheet: true };
}
