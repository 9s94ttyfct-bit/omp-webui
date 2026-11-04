/**
 * Dragging a conversation's row of the sidebar onto a project's row (`[data-project-drop]`) puts it in that project. The
 * keyboard's way is the row's menu (Move to project); this is the pointer's, with a mouse, a pen or a finger:
 *
 * - a mouse or a pen drags once it has moved `MOUSE_START` pixels with its button down;
 * - a finger drags after it has rested `TOUCH_HOLD_MS` on the row (a finger that moves before that scrolls the list, as it
 *   always did), and the list then does not scroll under it until it is lifted.
 *
 * While it drags, a label with the conversation's name follows the pointer, the project under it is marked
 * (`data-drop-over`), and `html[data-session-dragging]` is set; the click that ends a drag is not a click on the row. Escape
 * or a cancelled pointer drops nothing.
 */

const MOUSE_START = 5;
const TOUCH_HOLD_MS = 450;
/** A finger that moves this far before its hold is up is scrolling, not dragging. */
const TOUCH_SLOP = 8;
/** How long after a drag ends the click it makes is swallowed. */
const SWALLOW_MS = 50;

export interface SessionDrop {
	/** The dragged conversation's file (the row's `data-file`). */
	file: string;
	/** The project it was dropped on (its row's `data-project-drop`). */
	project: string;
}

/** Start following a press on a conversation's row: a drag once it is one, nothing at all otherwise. */
export function startSessionPress(
	e: PointerEvent,
	file: string,
	label: string,
	onDrop: (drop: SessionDrop) => void,
): void {
	if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
	const touch = e.pointerType === "touch";
	const pointer = e.pointerId;
	const from = { x: e.clientX, y: e.clientY };
	let dragging = false;
	let ghost: HTMLElement | null = null;
	let over: HTMLElement | null = null;
	let hold: number | undefined;

	const mark = (target: HTMLElement | null) => {
		if (target === over) return;
		over?.removeAttribute("data-drop-over");
		over = target;
		over?.setAttribute("data-drop-over", "true");
	};
	const targetAt = (x: number, y: number): HTMLElement | null => {
		for (const el of document.elementsFromPoint(x, y)) {
			const drop = el instanceof HTMLElement ? el.closest<HTMLElement>("[data-project-drop]") : null;
			if (drop) return drop;
		}
		return null;
	};
	const begin = (x: number, y: number) => {
		dragging = true;
		ghost = document.createElement("div");
		ghost.textContent = label;
		ghost.setAttribute("data-testid", "session-drag-ghost");
		ghost.setAttribute("aria-hidden", "true");
		ghost.className =
			"pointer-events-none fixed top-0 left-0 z-[100] max-w-56 truncate rounded-lg border border-border bg-surface px-2.5 py-1 text-sm shadow-xl";
		document.body.append(ghost);
		document.documentElement.setAttribute("data-session-dragging", "true");
		move(x, y);
	};
	const move = (x: number, y: number) => {
		if (ghost) ghost.style.transform = `translate(${x + 12}px, ${y + 8}px)`;
		mark(targetAt(x, y));
	};
	const onMove = (ev: PointerEvent) => {
		if (ev.pointerId !== pointer) return;
		// The press was let go before this module arrived (the sidebar fetches it on the press): there is nothing to drag.
		if (!touch && ev.buttons === 0) return end(false);
		const far = Math.hypot(ev.clientX - from.x, ev.clientY - from.y);
		if (!dragging) {
			if (touch) {
				if (far > TOUCH_SLOP) end(false);
				return;
			}
			if (far < MOUSE_START) return;
			begin(ev.clientX, ev.clientY);
		}
		ev.preventDefault();
		move(ev.clientX, ev.clientY);
	};
	// While a finger drags, the list must not scroll under it.
	const onTouchMove = (ev: TouchEvent) => {
		if (dragging) ev.preventDefault();
	};
	const onUp = (ev: PointerEvent) => {
		if (ev.pointerId !== pointer) return;
		if (dragging) mark(targetAt(ev.clientX, ev.clientY));
		end(true);
	};
	const onCancel = (ev: PointerEvent) => {
		if (ev.pointerId === pointer) end(false);
	};
	const onKey = (ev: KeyboardEvent) => {
		if (ev.key !== "Escape" || !dragging) return;
		ev.preventDefault();
		ev.stopPropagation();
		end(false);
	};
	// A finger held on a row asks for the system's menu: not while it drags.
	const onMenu = (ev: Event) => {
		if (dragging) ev.preventDefault();
	};
	const swallow = (ev: Event) => {
		ev.preventDefault();
		ev.stopPropagation();
	};
	function end(drop: boolean) {
		clearTimeout(hold);
		window.removeEventListener("pointermove", onMove);
		window.removeEventListener("pointerup", onUp);
		window.removeEventListener("pointercancel", onCancel);
		window.removeEventListener("keydown", onKey, true);
		window.removeEventListener("touchmove", onTouchMove);
		window.removeEventListener("contextmenu", onMenu, true);
		if (!dragging) return;
		const project = over?.dataset.projectDrop;
		mark(null);
		ghost?.remove();
		document.documentElement.removeAttribute("data-session-dragging");
		// The click the release makes lands on whatever is under it (the row, a project's button): it is the drag's, not theirs.
		window.addEventListener("click", swallow, true);
		setTimeout(() => window.removeEventListener("click", swallow, true), SWALLOW_MS);
		if (drop && project) onDrop({ file, project });
	}

	window.addEventListener("pointermove", onMove, { passive: false });
	window.addEventListener("pointerup", onUp);
	window.addEventListener("pointercancel", onCancel);
	window.addEventListener("keydown", onKey, true);
	window.addEventListener("touchmove", onTouchMove, { passive: false });
	window.addEventListener("contextmenu", onMenu, true);
	if (touch) hold = window.setTimeout(() => begin(from.x, from.y), TOUCH_HOLD_MS);
}
