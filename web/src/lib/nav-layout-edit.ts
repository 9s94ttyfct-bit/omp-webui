import {
	defaultNavLayout,
	NAV_GROUPS,
	type NavGroup,
	type NavItemId,
	type NavLayout,
	type NavSurface,
	navLayout,
	setNavLayout,
} from "./nav-layout.ts";

/**
 * Arranging the bars (#654): the moves a drag, the keyboard controls of Settings and Reset make. They are not part of
 * drawing the bars, so the first page does not carry them: the drag's chunk and the Settings card import this.
 */

/** Where an item sits now: the group and the index in it (null when this layout does not name it). */
export function findNavItem(
	layout: NavLayout,
	surface: NavSurface,
	id: NavItemId,
): { group: NavGroup; index: number } | null {
	for (const group of NAV_GROUPS) {
		const index = layout[surface][group].indexOf(id);
		if (index >= 0) return { group, index };
	}
	return null;
}

/** Where an item should go: a group, and a place in it (`undefined` or past its end: last). */
export interface NavTarget {
	group: NavGroup;
	index?: number;
}

/** The layout with one item moved (`surface` only; the other surface is the same object). */
export function withNavItemMoved(layout: NavLayout, surface: NavSurface, id: NavItemId, target: NavTarget): NavLayout {
	const from = findNavItem(layout, surface, id);
	const next = { ...layout[surface] };
	if (from) next[from.group] = next[from.group].filter((other) => other !== id);
	const list = [...next[target.group]];
	const at = target.index === undefined ? list.length : Math.max(0, Math.min(list.length, target.index));
	list.splice(at, 0, id);
	next[target.group] = list;
	return { ...layout, [surface]: next };
}

/** Move one item and remember it (what a drag or a control does). */
export function moveNavItem(surface: NavSurface, id: NavItemId, target: NavTarget): void {
	setNavLayout(withNavItemMoved(navLayout(), surface, id, target));
}

/** One step within its group: up, or down. A move that would leave the group does nothing. */
export function nudgeNavItem(surface: NavSurface, id: NavItemId, step: -1 | 1): void {
	const layout = navLayout();
	const at = findNavItem(layout, surface, id);
	if (!at) return;
	const index = at.index + step;
	if (index < 0 || index >= layout[surface][at.group].length) return;
	moveNavItem(surface, id, { group: at.group, index });
}

/** Back to the default arrangement (both bars). */
export function resetNavLayout(): void {
	setNavLayout(defaultNavLayout());
}
