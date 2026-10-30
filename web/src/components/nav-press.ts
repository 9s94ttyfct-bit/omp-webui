import type { PointerEvent as ReactPointerEvent } from "react";
import type { NavItemId, NavSurface } from "../lib/nav-layout.ts";

/**
 * The start of a drag of one item of the sidebar or the rail (#654): all of it that the first page carries. The element
 * that is pressed says what it is (`data-nav-item`, `data-nav-surface`); the controller that follows the pointer, finds the
 * drop, shows the drag (as attributes on the elements, so no component renders for it) and moves the item
 * (`nav-drag-controller.ts`) is a chunk fetched by the first press, so a page that nobody rearranges does not load it.
 */

/** What a press on an item carries to the controller. */
export interface Press {
	surface: NavSurface;
	id: NavItemId;
	x: number;
	y: number;
	pointerId: number;
}

/** `onPointerDown` of an item's element. */
export function startNavPress(e: ReactPointerEvent<HTMLElement>): void {
	// The primary button only, and not a modified press (a ⌘-click is not the start of a drag).
	if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
	const { navItem, navSurface } = e.currentTarget.dataset;
	if (!navItem || !navSurface) return;
	const press = {
		surface: navSurface as NavSurface,
		id: navItem as NavItemId,
		x: e.clientX,
		y: e.clientY,
		pointerId: e.pointerId,
	};
	// The controller is fetched by the first press; a press that ended before it arrived is a click, not a drag.
	let released = false;
	const release = () => {
		released = true;
	};
	window.addEventListener("pointerup", release, { once: true });
	window.addEventListener("pointercancel", release, { once: true });
	void import("./nav-drag-controller.ts").then((m) => {
		if (!released) m.beginDrag(press);
	});
}
