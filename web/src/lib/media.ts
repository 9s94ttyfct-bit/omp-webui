import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

/** Where the chat's side panel is a sheet over the conversation instead of a column beside it (Tailwind's `max-lg`). */
export const PANEL_SHEET_QUERY = "(width < 64rem)";

/**
 * Whether a CSS media query matches right now; re-renders when that changes. A render to a string (a unit test) asks
 * `matchMedia` too: there is no page it could be told differently by.
 */
export function useMediaQuery(query: string): boolean {
	const subscribe = useCallback(
		(onChange: () => void) => {
			const list = matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		[query],
	);
	const matches = () => matchMedia(query).matches;
	return useSyncExternalStore(subscribe, matches, matches);
}

/**
 * Whether an element is narrower than `px`, for layouts that depend on the room a column has (beside a sidebar
 * and a side panel) rather than on the window. Measured before the first paint, so there is no flash of the wide
 * layout. Pass the element held in state (`ref={setEl}`), so it is observed again if it is ever replaced.
 */
export function useNarrowerThan(el: HTMLElement | null, px: number): boolean {
	const [narrow, setNarrow] = useState(false);
	useLayoutEffect(() => {
		if (!el) return;
		const measure = () => setNarrow(el.clientWidth < px);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [el, px]);
	return narrow;
}

/** Room a fuller form must have to spare before it comes back from its compact one (`useFitSteps`, `useCrampedRow`). */
const SPARE_PX = 12;

/**
 * The width a one-row flex `row` needs for what it shows now: to the end of its last item, with its padding, plus what
 * each shortened text (`data-fit-min`, a width in pixels) lacks of that readable minimum. Such a text ends in an ellipsis
 * while it is narrower than its words; it is too short once it is narrower than the minimum too (or than its words, when
 * they take less). Measured to the fraction of a pixel: a name short of its width by a fraction already ends in "…".
 */
function rowNeed(row: HTMLElement): number {
	const box = row.getBoundingClientRect();
	const style = getComputedStyle(row);
	let end = box.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
	for (const item of row.children) {
		// Not laid out (`display: none`): it takes no room.
		if (item.getClientRects().length === 0) continue;
		const r = item.getBoundingClientRect();
		end = Math.max(end, r.right + Number.parseFloat(getComputedStyle(item).marginRight));
	}
	let need = end - box.left + Number.parseFloat(style.paddingRight) + Number.parseFloat(style.borderRightWidth);
	for (const text of row.querySelectorAll<HTMLElement>("[data-fit-min]")) {
		// Not laid out at all; one squeezed to nothing is laid out, and short of its minimum by all of it.
		if (text.getClientRects().length === 0) continue;
		const width = text.getBoundingClientRect().width;
		const words = document.createRange();
		words.selectNodeContents(text);
		need += Math.max(0, Math.min(Number(text.dataset.fitMin), words.getBoundingClientRect().width) - width);
	}
	return need;
}

/**
 * How many of `steps` ways of making room a one-row flex `row` takes to fit the room it has: the row's own order of what
 * gives way (an item put in the header's menu, a name shortened, a quota written shorter), the least needed first. The
 * caller draws the row with the first that many taken; each makes it narrower, so they are taken one at a time until
 * what it shows fits (`rowNeed`), and given back one at a time once the room is there for the form before.
 *
 * The room a form needs is learnt when it is drawn and does not fit, as the forms after it say nothing of it. That form
 * comes back only with `SPARE_PX` to spare, so a width right at the edge does not tip it back and forth; and should it
 * not fit after all (what it holds grew meanwhile), it gives way again before the browser paints. `reset` names what
 * the row holds (which items it has, the names it shows): when it changes, what each form needed is unknown again, and
 * the row starts again from its fullest form, also before a paint.
 *
 * Measured after each render, and again when the row's width changes, when anything in it changes (a figure, a chip
 * that arrives with its data) and when a font has loaded. Pass the element held in state (`ref={setRow}`). `settled`
 * is told the steps taken each time a measure leaves them as they are: what the rest of the page shows of the row's
 * steps (a menu of what it left out) follows that, and not each form the row goes through on its way to it.
 */
export function useFitSteps(
	row: HTMLElement | null,
	steps: number,
	reset: string,
	settled?: (taken: number) => void,
): number {
	const [taken, setTaken] = useState(0);
	/** The steps asked for last; the state follows it. */
	const asked = useRef(0);
	/** The steps the row shows: until a render has drawn what was asked for, measuring it says nothing of that. */
	const drawn = useRef(0);
	/** What the row needed with that many steps taken, when it was last drawn so and did not fit. */
	const needs = useRef<number[]>([]);
	const level = Math.min(taken, steps);
	const check = useRef(() => {});
	check.current = () => {
		const k = Math.min(asked.current, steps);
		if (!row?.isConnected || k !== drawn.current) return;
		const room = row.getBoundingClientRect().width;
		const need = rowNeed(row);
		let next = k;
		if (need > room + 0.01) {
			needs.current[k] = need;
			if (k < steps) next = k + 1;
		} else if (k > 0) {
			const before = needs.current[k - 1];
			if (before !== undefined && before + SPARE_PX <= room) next = k - 1;
		}
		if (next === k) {
			settled?.(k);
			return;
		}
		asked.current = next;
		setTaken(next);
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: `reset` is the trigger; what the row holds has changed.
	useLayoutEffect(() => {
		needs.current = [];
		if (asked.current === 0) return;
		asked.current = 0;
		setTaken(0);
	}, [reset]);
	// After every render: what it drew is measured, and the next step taken (or given back) before the browser paints.
	useLayoutEffect(() => {
		drawn.current = level;
		check.current();
	});
	useLayoutEffect(() => {
		if (!row) return;
		// What the page changes without a render of the row's own (its width, a chip's data, a font) is laid out in the frame
		// it came in. The row's own size does not depend on what it shows, so a resize observer is not told of it again.
		const again = () => flushSync(() => check.current());
		const resized = new ResizeObserver(again);
		resized.observe(row);
		const edited = new MutationObserver(again);
		edited.observe(row, { childList: true, subtree: true, characterData: true });
		const fonts = () => {
			needs.current = [];
			asked.current = 0;
			flushSync(() => {
				setTaken(0);
				check.current();
			});
		};
		document.fonts?.addEventListener("loadingdone", fonts);
		return () => {
			resized.disconnect();
			edited.disconnect();
			document.fonts?.removeEventListener("loadingdone", fonts);
		};
	}, [row]);
	return level;
}

/**
 * Whether a row of controls has too little room for its fuller form, and so shows its compact one: `attribute` is set on
 * the row (the row's CSS answers it with icons only, or with some controls behind "⋯").
 *
 * The question is put to the fuller form itself. With `attribute` off for a moment, `cramped(row, compact)` says whether
 * that form fits (its controls on one line, a name whole); `compact` is the form shown now, for a caller that holds on to
 * it in some state. That is all in one task, and what the row shows afterwards is set back before the browser paints, so
 * the fuller form is never on screen when it is not the one chosen. What it answers depends on the room and on the
 * content, never on the form that is shown, so the two forms do not take turns; and coming back to the fuller form takes
 * `SPARE_PX` of room to spare, so a width right at the edge does not tip it either.
 *
 * Asked before the first paint, and again when the row's width changes, when anything in it changes (a label, a control
 * that arrives with its chunk) and when a font has loaded, as each changes what the fuller form needs. Pass the element
 * held in state (`ref={setRow}`), so it is observed again if it is ever replaced.
 */
export function useCrampedRow(
	row: HTMLElement | null,
	attribute: string,
	cramped: (row: HTMLElement, compact: boolean) => boolean,
): boolean {
	const [compact, setCompact] = useState(false);
	/** What the last answer was; the state follows it. */
	const was = useRef(false);
	// The question is not part of what is observed: a caller's new function does not start the observers again.
	const ask = useRef(cramped);
	ask.current = cramped;
	useLayoutEffect(() => {
		if (!row) return;
		const measure = (sync: boolean) => {
			const shown = row.hasAttribute(attribute);
			row.removeAttribute(attribute);
			row.style.marginRight = was.current ? `${SPARE_PX}px` : "";
			const next = ask.current(row, was.current);
			row.style.marginRight = "";
			if (shown) row.setAttribute(attribute, "");
			if (next === was.current) return;
			was.current = next;
			// What arrives with the page's own changes (a chunk lands, a label is set) is laid out in the frame it came in. Not
			// from a resize observer's callback: a change of the row's size made there is one it reports again, as an error.
			if (sync) flushSync(() => setCompact(next));
			else setCompact(next);
		};
		measure(false);
		const resized = new ResizeObserver(() => measure(false));
		resized.observe(row);
		const again = () => measure(true);
		const edited = new MutationObserver(again);
		edited.observe(row, { childList: true, subtree: true, characterData: true });
		document.fonts?.addEventListener("loadingdone", again);
		return () => {
			resized.disconnect();
			edited.disconnect();
			document.fonts?.removeEventListener("loadingdone", again);
		};
	}, [row, attribute]);
	return compact;
}
