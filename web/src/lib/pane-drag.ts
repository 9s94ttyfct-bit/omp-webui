import type { PaneId, PaneLayout, PanelTab } from "@shared/panes.ts";
import { type PointerEvent as ReactPointerEvent, useSyncExternalStore } from "react";
import { currentPanes, place, setPanes } from "./panel-panes.ts";

/**
 * Moving a tab of the side panel by dragging it: along its row, to the other pane's row, or to the edge of a pane that has no
 * tab (the closed pane's drop zone). Pointer events and not HTML5 drag and drop, which a touch screen does not start and the
 * macOS app's web view does not finish reliably. A press that does not move `DRAG_START` px stays a click; Escape cancels.
 * Where a drop would put the tab is read from the page's own boxes (`[data-pane-row]`, its `[data-pane-tab]`s and
 * `[data-pane-zone]`) at every move, so that a row that grows or scrolls is followed.
 */

/** How far, in px, the pointer goes with the button down before a press on a tab is a drag. */
export const DRAG_START = 5;

export interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** A pane's tab row as the page has it: the row's box and the boxes of its tabs, left to right. */
export interface RowGeometry {
	pane: PaneId;
	box: Box;
	tabs: readonly Box[];
}

/** The strip of a closed pane's edge that a tab can be dropped on to open the pane (only drawn while a tab is dragged). */
export interface ZoneGeometry {
	pane: PaneId;
	box: Box;
}

export interface DropTarget {
	pane: PaneId;
	/** Where in the pane's row the tab would go (see `place`); 0 for a zone. */
	slot: number;
	/** The insertion marker between two tabs: its place in px of the viewport. Null for a zone, which is its own mark. */
	marker: { x: number; top: number; bottom: number } | null;
}

export interface TabDrag {
	tab: PanelTab;
	/** The pointer, in px of the viewport. */
	x: number;
	y: number;
	/** What a drop here would do, or null where it would do nothing (outside the rows, or the tab where it already is). */
	target: DropTarget | null;
}

/** The slot of a row (counted as `place` does) that a pointer at `x` is over, for tabs whose centres are `centres`, left to right. */
export function slotAt(centres: readonly number[], x: number): number {
	return centres.filter((c) => x > c).length;
}

/** Where the marker for `slot` stands in a row whose tabs are `tabs`: between the tabs on either side of it. */
function markerAt(tabs: readonly Box[], slot: number): DropTarget["marker"] {
	const before = tabs[slot - 1];
	const after = tabs[slot];
	const first = tabs[0];
	if (!first) return null;
	const x = before && after ? (before.right + after.left) / 2 : before ? before.right + 1 : first.left - 1;
	const edge = after ?? before ?? first;
	return { x, top: edge.top, bottom: edge.bottom };
}

/**
 * What dropping `tab` at the pointer (`x`, `y`) would do. A zone is the edge of a pane that has no tab: the top one ends at
 * its lower edge and takes everything above (the way off the top of the panel), the bottom one starts at its upper edge and
 * takes everything below. A row is where the pointer is inside its box, and the slot is the gap the pointer is in. Null for
 * a drop that changes nothing.
 */
export function dropTargetAt(
	layout: PaneLayout,
	tab: PanelTab,
	x: number,
	y: number,
	rows: readonly RowGeometry[],
	zones: readonly ZoneGeometry[],
): DropTarget | null {
	for (const { pane, box } of zones) {
		if (x < box.left || x > box.right || (pane === "top" ? y > box.bottom : y < box.top)) continue;
		return { pane, slot: 0, marker: null };
	}
	for (const { pane, box, tabs } of rows) {
		if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
		const slot = slotAt(
			tabs.map((b) => (b.left + b.right) / 2),
			x,
		);
		if (place(layout, tab, pane, slot) === layout) return null;
		return { pane, slot, marker: markerAt(tabs, slot) };
	}
	return null;
}

function readBoxes(): { rows: RowGeometry[]; zones: ZoneGeometry[] } {
	const box = (el: Element): Box => {
		const { left, top, right, bottom } = el.getBoundingClientRect();
		return { left, top, right, bottom };
	};
	const rows = [...document.querySelectorAll<HTMLElement>("[data-pane-row]")].map((el) => ({
		pane: el.dataset.paneRow as PaneId,
		box: box(el),
		tabs: [...el.querySelectorAll("[data-pane-tab]")].map(box),
	}));
	const zones = [...document.querySelectorAll<HTMLElement>("[data-pane-zone]")].map((el) => ({
		pane: el.dataset.paneZone as PaneId,
		box: box(el),
	}));
	return { rows, zones };
}

// ------------------------------------------------------------------ the drag in progress

let drag: TabDrag | null = null;
const listeners = new Set<() => void>();

function subscribe(l: () => void) {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
}

function setDrag(next: TabDrag | null): void {
	drag = next;
	for (const l of listeners) l();
}

/** A part of the drag now on its way (null when there is none), for a component that draws only that part. */
export function useTabDrag<T>(select: (d: TabDrag | null) => T): T {
	return useSyncExternalStore(subscribe, () => select(drag));
}

interface Press {
	tab: PanelTab;
	pointerId: number;
	x: number;
	y: number;
	/** The pointer has gone far enough: this is a drag, and the click that ends it is not a click. */
	dragging: boolean;
	/** Escape: nothing more is drawn or done, and the press ends with the button. */
	cancelled: boolean;
}

let press: Press | null = null;

const swallowClick = (e: Event) => {
	e.stopImmediatePropagation();
	e.preventDefault();
};

/** The page's own look of a drag: the grabbing cursor everywhere and no text selected on the way (`html[data-pane-drag]` in index.css). */
function setDragLook(on: boolean): void {
	if (on) document.documentElement.setAttribute("data-pane-drag", "");
	else document.documentElement.removeAttribute("data-pane-drag");
}

function onMove(e: PointerEvent): void {
	if (!press || e.pointerId !== press.pointerId || press.cancelled) return;
	if (!press.dragging) {
		if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_START) return;
		press.dragging = true;
		setDragLook(true);
		// The button comes up over the tab it went down on, or over another element: either way its click is not wanted.
		window.addEventListener("click", swallowClick, true);
	}
	const { rows, zones } = readBoxes();
	setDrag({
		tab: press.tab,
		x: e.clientX,
		y: e.clientY,
		target: dropTargetAt(currentPanes(), press.tab, e.clientX, e.clientY, rows, zones),
	});
}

function onKey(e: KeyboardEvent): void {
	if (e.key !== "Escape" || !press?.dragging || press.cancelled) return;
	e.preventDefault();
	e.stopPropagation();
	press.cancelled = true;
	setDragLook(false);
	setDrag(null);
}

function finish(e: PointerEvent): void {
	if (!press || e.pointerId !== press.pointerId) return;
	const done = press;
	const target = e.type === "pointerup" && !done.cancelled ? (drag?.target ?? null) : null;
	press = null;
	window.removeEventListener("pointermove", onMove);
	window.removeEventListener("pointerup", finish);
	window.removeEventListener("pointercancel", finish);
	window.removeEventListener("keydown", onKey, true);
	window.removeEventListener("blur", cancelOnBlur);
	setDragLook(false);
	setDrag(null);
	if (done.dragging) {
		// The click that follows the button coming up is the next task's first event: it is gone after that.
		setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);
	}
	if (target) setPanes(place(currentPanes(), done.tab, target.pane, target.slot));
}

/** The window lost focus with the button down: the button may come up somewhere that never tells the page. */
function cancelOnBlur(): void {
	if (!press) return;
	finish(new PointerEvent("pointercancel", { pointerId: press.pointerId }));
}

/**
 * The button went down on `tab`'s trigger. Nothing happens until the pointer has moved `DRAG_START`; the press is the tab's
 * own (it picks it, as a click does) until then, and a drag picks it too, since the trigger does that when the button goes down.
 */
export function beginTabDrag(e: ReactPointerEvent, tab: PanelTab): void {
	// The primary button of the primary pointer (a second finger, the wheel and the right button have their own meaning), and
	// not Ctrl, which makes a click on a Mac the right button.
	if (press || e.button !== 0 || !e.isPrimary || e.ctrlKey) return;
	press = { tab, pointerId: e.pointerId, x: e.clientX, y: e.clientY, dragging: false, cancelled: false };
	window.addEventListener("pointermove", onMove);
	window.addEventListener("pointerup", finish);
	window.addEventListener("pointercancel", finish);
	window.addEventListener("keydown", onKey, true);
	window.addEventListener("blur", cancelOnBlur);
}
