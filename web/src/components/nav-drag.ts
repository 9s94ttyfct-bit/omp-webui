import type { NavGroup, NavItemId, NavSurface } from "../lib/nav-layout.ts";
import { navLayout } from "../lib/nav-layout.ts";
import { moveNavItem } from "../lib/nav-layout-edit.ts";

/**
 * Where a dragged item of the sidebar or the rail would land, how the drag shows, and landing it (#654). The bars mark
 * their items and groups with `data-nav-*` attributes; the pointer's position is read against them, and the drag is drawn
 * by setting attributes on those same elements (`data-dragging`, `data-drop`, `data-over`, and `data-nav-dragging` on
 * the page's root, which the bars' classes answer): no component renders on a pointer move. Part of the drag's lazy chunk
 * (`nav-drag-controller.ts`).
 */

/** The item that was pressed. */
export interface Pressed {
	surface: NavSurface;
	id: NavItemId;
}

/** Where a drop would land: before or after one item of a group, or at the end of a group (`id` null). */
export interface NavDrop {
	surface: NavSurface;
	group: NavGroup;
	id: NavItemId | null;
	after: boolean;
}

export function sameDrop(a: NavDrop | null, b: NavDrop | null): boolean {
	return a?.group === b?.group && a?.id === b?.id && a?.after === b?.after;
}

/** The item under the pointer and which half of it, else the group's box it is over (the end of that group). */
export function dropAt(surface: NavSurface, x: number, y: number): NavDrop | null {
	const stack = document.elementsFromPoint(x, y).filter((el): el is HTMLElement => el instanceof HTMLElement);
	for (const el of stack) {
		const id = el.dataset.navItem as NavItemId | undefined;
		const group = el.dataset.navGroup as NavGroup | undefined;
		if (!id || !group || el.dataset.navSurface !== surface) continue;
		const box = el.getBoundingClientRect();
		return { surface, group, id, after: y >= box.top + box.height / 2 };
	}
	for (const el of stack) {
		const group = el.dataset.navGroupBox as NavGroup | undefined;
		if (!group || el.dataset.navSurface !== surface) continue;
		return { surface, group, id: null, after: true };
	}
	return null;
}

function itemElement(surface: NavSurface, id: NavItemId): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[data-nav-surface="${surface}"][data-nav-item="${id}"]`);
}

function boxElement(surface: NavSurface, group: NavGroup): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[data-nav-surface="${surface}"][data-nav-group-box="${group}"]`);
}

/** The elements the drag has marked, so that the next mark (or the end) can clear them. */
let marked: HTMLElement[] = [];

function clearMarks(): void {
	for (const el of marked) {
		delete el.dataset.dragging;
		delete el.dataset.drop;
		delete el.dataset.over;
	}
	marked = [];
}

/** Show the drag: the dragged item dimmed, the place it would land marked. */
export function showDrag(dragged: Pressed, drop: NavDrop | null): void {
	clearMarks();
	document.documentElement.dataset.navDragging = dragged.surface;
	const item = itemElement(dragged.surface, dragged.id);
	if (item) {
		item.dataset.dragging = "true";
		marked.push(item);
	}
	if (!drop) return;
	if (drop.id === null) {
		const box = boxElement(drop.surface, drop.group);
		if (box) {
			box.dataset.over = "true";
			marked.push(box);
		}
	} else if (drop.id !== dragged.id) {
		const target = itemElement(drop.surface, drop.id);
		if (target) {
			target.dataset.drop = drop.after ? "after" : "before";
			marked.push(target);
		}
	}
}

/** The drag is over: nothing is marked any more. */
export function hideDrag(): void {
	clearMarks();
	delete document.documentElement.dataset.navDragging;
}

/** Where the dragged item goes in the layout, once the pointer is released over `landed`. */
export function land(started: Pressed, landed: NavDrop): void {
	if (landed.id === started.id) return;
	// The place is counted without the dragged item, which is the list `moveNavItem` inserts into.
	const rest = navLayout()[started.surface][landed.group].filter((id) => id !== started.id);
	const at = landed.id === null ? -1 : rest.indexOf(landed.id);
	const index = at < 0 ? rest.length : landed.after ? at + 1 : at;
	moveNavItem(started.surface, started.id, { group: landed.group, index });
}
