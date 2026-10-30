/**
 * Whether the reader's hand is scrolling a view: the wheel, a finger on a touch screen, the keys that scroll, or a press
 * on the scrollbar. The page brings more history in only for such a reader, and only for a while after the last of it.
 *
 * What is not that must not bring anything in: the scroll that follows a focus (a Tab onto "Show later messages"), a
 * `scrollIntoView`, a find, a jump to a search hit, a click on a button. They bring the button they are after into the
 * view, and what is brought in above it then takes it out of the view again, a page further down, before it is reached.
 */

/** How long after the last input the hand is taken to be on the scroll: a flick keeps scrolling for a second or two. */
const HAND_MS = 2500;
/** The keys that scroll a view. */
const SCROLL_KEYS: Record<string, true> = {
	PageUp: true,
	PageDown: true,
	Home: true,
	End: true,
	ArrowUp: true,
	ArrowDown: true,
	" ": true,
};
/** Keys of a field belong to the field (the caret moves). */
const FIELDS: Record<string, true> = { INPUT: true, TEXTAREA: true, SELECT: true };

/** Which way the hand scrolls: up (toward the first messages), down, or not known (the scrollbar, a drag with no way). */
export type Heading = "up" | "down" | null;

/** A key that scrolls `view`: pressed in it, or on the page (where focus rests after a click on a message), not in a field. */
function scrollsView(view: HTMLElement, e: KeyboardEvent): boolean {
	if (SCROLL_KEYS[e.key] !== true || e.altKey || e.defaultPrevented) return false;
	const target = e.target;
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable || FIELDS[target.tagName] === true) return false;
	const resting = target === document.body || target === view;
	// Space on a button or a link presses it, it does not scroll.
	if (e.key === " ") return resting;
	return resting || view.contains(target);
}

/** The way a scroll key goes. */
function headingOf(e: KeyboardEvent): Heading {
	if (e.key === "Home" || e.key === "PageUp" || e.key === "ArrowUp") return "up";
	return e.key === " " && e.shiftKey ? "up" : "down";
}

/** What `watchHandScroll` watches with. */
export interface HandScroll {
	stop(): void;
	/** The way the hand last went, while it is on the scroll: the page brings in what lies that way, not what lies behind. */
	heading(): Heading;
}

/**
 * Calls `onChange(true, heading)` when the hand starts scrolling `view`, `onChange(false, null)` once it has been off it for
 * a while, and `onChange(true, heading)` again when the hand, still on the scroll, turns the other way.
 */
export function watchHandScroll(
	view: HTMLElement,
	onChange: (scrolling: boolean, heading: Heading) => void,
): HandScroll {
	let scrolling = false;
	let heading: Heading = null;
	let timer = 0;
	/** The pointer is down on the view itself: the scrollbar, whose drag sends no input while it goes on. */
	let pressed = false;
	const set = (next: boolean) => {
		if (next === scrolling) return;
		scrolling = next;
		if (!next) heading = null;
		onChange(next, heading);
	};
	const touch = (toward?: Heading) => {
		const was = heading;
		if (toward !== undefined) heading = toward;
		if (scrolling && heading !== was) onChange(true, heading);
		set(true);
		window.clearTimeout(timer);
		if (!pressed) timer = window.setTimeout(() => set(false), HAND_MS);
	};
	const down = (e: PointerEvent) => {
		if (e.target !== view) return;
		pressed = true;
		touch(null);
	};
	const up = () => {
		if (!pressed) return;
		pressed = false;
		touch();
	};
	const key = (e: KeyboardEvent) => {
		if (scrollsView(view, e)) touch(headingOf(e));
	};
	const wheel = (e: WheelEvent) => touch(e.deltaY === 0 ? undefined : e.deltaY < 0 ? "up" : "down");
	/** A finger has moved on the view in this touch: a tap on a button is not a scroll, and its end does not start the flick. */
	let dragged = false;
	let fingerY = 0;
	const start = (e: TouchEvent) => {
		fingerY = e.touches[0]?.clientY ?? 0;
	};
	const drag = (e: TouchEvent) => {
		dragged = true;
		const y = e.touches[0]?.clientY ?? fingerY;
		// The finger going down drags the content down: the reader goes toward the first messages.
		touch(y === fingerY ? undefined : y > fingerY ? "up" : "down");
		fingerY = y;
	};
	const lift = () => {
		if (!dragged) return;
		dragged = false;
		touch();
	};
	view.addEventListener("touchstart", start, { passive: true });
	view.addEventListener("touchmove", drag, { passive: true });
	view.addEventListener("touchend", lift, { passive: true });
	view.addEventListener("touchcancel", lift, { passive: true });
	view.addEventListener("wheel", wheel, { passive: true });
	view.addEventListener("pointerdown", down, { passive: true });
	const onWindow = ["pointerup", "pointercancel", "mouseup", "blur"] as const;
	for (const type of onWindow) window.addEventListener(type, up, { passive: true });
	document.addEventListener("keydown", key, { passive: true });
	return {
		stop() {
			window.clearTimeout(timer);
			view.removeEventListener("touchstart", start);
			view.removeEventListener("touchmove", drag);
			view.removeEventListener("touchend", lift);
			view.removeEventListener("touchcancel", lift);
			view.removeEventListener("wheel", wheel);
			view.removeEventListener("pointerdown", down);
			for (const type of onWindow) window.removeEventListener(type, up);
			document.removeEventListener("keydown", key);
		},
		heading: () => heading,
	};
}
