import { dropAt, hideDrag, land, type NavDrop, type Pressed, sameDrop, showDrag } from "./nav-drag.ts";
import type { Press } from "./nav-press.ts";

/**
 * Dragging an item of the sidebar or the rail (#654), the part that follows the pointer. A press that moves past
 * `DRAG_THRESHOLD` becomes a drag, and the pointer (a mouse, a pen, a finger: pointer events, so touch works in the app's
 * web view too) picks the item it would land before or after, or a group's end (an empty group, or the zone that hides).
 * A press that does not move is the item's own click, as before; a drag that lands swallows the click it would otherwise
 * become.
 *
 * It is a chunk of its own, fetched by the first press on an item (`nav-press.ts` starts it). The keyboard is Settings'
 * card (`components/NavLayoutSettings.tsx`): every move a drag makes has a control there, so the layout is arrangeable
 * without a pointer at all.
 */

/** How far the pointer moves before a press is a drag; below it, the click belongs to the item. */
const DRAG_THRESHOLD = 5;
/** How long after a drag the click it ends with is still swallowed: the browser sends it in the same breath as the pointer-up, so a click a person makes next is never this one. */
const SWALLOW_MS = 30;

let press: Press | null = null;
/** Where the pointer is over, once the press has become a drag; null while it has not (or is over nothing). */
let drop: NavDrop | null = null;
let dragging = false;
let installed = false;

function end(commit: boolean): void {
	const started: Pressed | null = press;
	const landed = drop;
	const was = dragging;
	press = null;
	drop = null;
	dragging = false;
	hideDrag();
	if (!started || !was) return;
	// A drag ends with a click on the item it started on: it must not open that page.
	const swallow = (e: Event) => {
		e.stopPropagation();
		e.preventDefault();
	};
	window.addEventListener("click", swallow, { capture: true, once: true });
	setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), SWALLOW_MS);
	if (commit && landed) land(started, landed);
}

function install(): void {
	if (installed) return;
	installed = true;
	window.addEventListener(
		"pointermove",
		(e) => {
			if (!press || e.pointerId !== press.pointerId) return;
			if (!dragging && Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD) return;
			// The text under the pointer is not selected while an item is dragged.
			e.preventDefault();
			const next = dropAt(press.surface, e.clientX, e.clientY);
			if (dragging && sameDrop(next, drop)) return;
			dragging = true;
			drop = next;
			showDrag(press, next);
		},
		{ passive: false },
	);
	window.addEventListener("pointerup", (e) => {
		if (press && e.pointerId === press.pointerId) end(true);
	});
	window.addEventListener("pointercancel", (e) => {
		if (press && e.pointerId === press.pointerId) end(false);
	});
	// Esc puts the item back where it was.
	window.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && dragging) end(false);
	});
}

/** A primary-button press on an item that is still down: it becomes a drag once the pointer has moved far enough. */
export function beginDrag(started: Press): void {
	install();
	press = started;
}
