import { BarChart3, Brain, type LucideIcon, Network, ScanEye, Settings, SquareTerminal } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { MessageKey } from "../i18n/index.ts";

/**
 * Which pages the sidebar and the rail offer, and where (#654): one list (`NAV_ITEMS`) that the sidebar, the rail and the
 * command palette's *Go to* all read, and a layout of it per surface that the person arranges — in the top group, the
 * bottom group, or out of sight — and that is remembered on this device (localStorage, not the server's preference store:
 * the rail of a phone is not the rail of a desktop).
 *
 * The defaults are what the two surfaces shipped with, plus the guard: every page in the bottom group, none on top. A page
 * is offered once per surface (never in two groups), and a person who wants one on top drags it there or chooses it in
 * Settings. A page that came through the tunnel does not get the guard's item, as Settings does not.
 *
 * The Questions page is not among them (#693): a conversation's questions are a tab of its right panel, which opens the
 * page of every conversation's; a stored layout that names it is read without it.
 */

export const NAV_ITEM_IDS = ["agents", "usage", "memory", "cli", "settings", "guard"] as const;
/** An item is named as the page it opens (`View.kind`). */
export type NavItemId = (typeof NAV_ITEM_IDS)[number];

export interface NavItem {
	id: NavItemId;
	/** Its name; a first-page string (the sidebar and the rail are the first page, and the palette reuses them). */
	labelKey: MessageKey;
	icon: LucideIcon;
	/** Not offered to a page that is not on this computer: the guard is a setting of this Mac (as its Settings card is). */
	remoteHidden?: boolean;
}

/** Every page a surface may offer, in the order the palette lists them. */
export const NAV_ITEMS: readonly NavItem[] = [
	{ id: "agents", labelKey: "shell.sidebarNavAgents", icon: Network },
	{ id: "usage", labelKey: "shell.sidebarNavUsage", icon: BarChart3 },
	{ id: "memory", labelKey: "shell.sidebarNavMemory", icon: Brain },
	{ id: "cli", labelKey: "shell.sidebarNavCli", icon: SquareTerminal },
	{ id: "settings", labelKey: "shell.sidebarNavSettings", icon: Settings },
	// The guard's own sign is an eye (a reviewer looking at each call): the shields are the permission modes (C1).
	{ id: "guard", labelKey: "shell.sidebarNavGuard", icon: ScanEye, remoteHidden: true },
];

const BY_ID = new Map(NAV_ITEMS.map((item) => [item.id, item]));

export function isNavItemId(value: unknown): value is NavItemId {
	return typeof value === "string" && BY_ID.has(value as NavItemId);
}

/** The two surfaces, each arranged on its own. */
export type NavSurface = "sidebar" | "rail";
export const NAV_SURFACES = ["sidebar", "rail"] as const;

export type NavGroup = "top" | "bottom" | "hidden";
export const NAV_GROUPS = ["top", "bottom", "hidden"] as const;

/** One surface: the items of each group, in the order they are shown (`hidden` keeps the order too, for Show). */
export type NavSurfaceLayout = Record<NavGroup, NavItemId[]>;
export interface NavLayout {
	sidebar: NavSurfaceLayout;
	rail: NavSurfaceLayout;
}

/** Where each surface puts its items until the person says otherwise: the pages at the foot, as they were, and the guard with them. */
function defaults(): NavLayout {
	const surface = (): NavSurfaceLayout => ({
		top: [],
		bottom: ["agents", "usage", "memory", "cli", "settings", "guard"],
		hidden: [],
	});
	return { sidebar: surface(), rail: surface() };
}

/** The layout of a surface nobody has arranged yet (a copy: the caller may keep it). */
export function defaultNavLayout(): NavLayout {
	return defaults();
}

/** localStorage key (device-local: the layout of this browser, or of this app on this Mac). */
export const NAV_LAYOUT_KEY = "ompw.navLayout";
/** The shape of what is written: read again when the items or the grouping change (an older copy is migrated, not refused). */
export const NAV_LAYOUT_VERSION = 1;

function surfaceOf(raw: unknown, surface: NavSurface): NavSurfaceLayout {
	const base = defaults()[surface];
	const out: NavSurfaceLayout = { top: [], bottom: [], hidden: [] };
	const seen = new Set<NavItemId>();
	if (raw && typeof raw === "object") {
		for (const group of NAV_GROUPS) {
			const list = (raw as Record<string, unknown>)[group];
			if (!Array.isArray(list)) continue;
			for (const value of list) {
				// An item this version does not know (removed, or written by a newer one) and a repeat are left out.
				if (!isNavItemId(value) || seen.has(value)) continue;
				seen.add(value);
				out[group].push(value);
			}
		}
	}
	// An item the stored copy does not name at all (added since it was written, or its group was lost) goes where the
	// default puts it: a new page is not invisible to someone who arranged the bar once.
	for (const group of NAV_GROUPS) {
		for (const id of base[group]) {
			if (seen.has(id)) continue;
			seen.add(id);
			out[group].push(id);
		}
	}
	return out;
}

/**
 * What a stored layout says, as this version reads it: unknown items and repeats dropped, items it does not name put in
 * their default group, an unreadable copy taken as the defaults. Never throws (a private window, a hand-edited value).
 */
export function parseNavLayout(raw: string | null | undefined): NavLayout {
	if (!raw) return defaults();
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return defaults();
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return defaults();
	const stored = value as Record<string, unknown>;
	return { sidebar: surfaceOf(stored.sidebar, "sidebar"), rail: surfaceOf(stored.rail, "rail") };
}

/** What is written for a layout. */
export function serializeNavLayout(layout: NavLayout): string {
	return JSON.stringify({ v: NAV_LAYOUT_VERSION, sidebar: layout.sidebar, rail: layout.rail });
}

function storage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		// A browser that refuses storage (some private modes) still shows the default layout for this page.
		return null;
	}
}

const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function subscribeNavLayout(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

let current: NavLayout = parseNavLayout(storage()?.getItem(NAV_LAYOUT_KEY) ?? null);

/** The layout now in force. */
export function navLayout(): NavLayout {
	return current;
}

/** Remember a layout here: on this device, for this page and the next visit. */
export function setNavLayout(next: NavLayout): void {
	current = next;
	try {
		storage()?.setItem(NAV_LAYOUT_KEY, serializeNavLayout(next));
	} catch {
		// Full or refused storage: the layout still applies until reload.
	}
	emit();
}

/** Another page of this origin arranged the bars: show what localStorage holds now. */
export function reloadNavLayout(): void {
	const next = parseNavLayout(storage()?.getItem(NAV_LAYOUT_KEY) ?? null);
	current = next;
	emit();
}

// Another tab changed it (`storage` does not fire in the tab that wrote it).
if (typeof window !== "undefined") {
	window.addEventListener("storage", (e) => {
		if (e.key !== null && e.key !== NAV_LAYOUT_KEY) return;
		reloadNavLayout();
	});
}

/** The layout, re-rendering when it is arranged (in this page or another one of this origin). */
export function useNavLayout(): NavLayout {
	return useSyncExternalStore(subscribeNavLayout, navLayout, navLayout);
}

/** The items of one group of a surface, ready to draw: a page that is not this computer's gets no guard item. */
export function navItemsIn(
	layout: NavLayout,
	surface: NavSurface,
	group: NavGroup,
	options: { remote: boolean },
): NavItem[] {
	const out: NavItem[] = [];
	for (const id of layout[surface][group]) {
		const item = BY_ID.get(id);
		if (!item) continue;
		if (options.remote && item.remoteHidden) continue;
		out.push(item);
	}
	return out;
}
