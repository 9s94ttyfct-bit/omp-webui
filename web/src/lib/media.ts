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

/** Room a fuller form must have to spare before it comes back from its compact one (`useNarrowerThanContent`, `useCrampedRow`). */
const SPARE_PX = 12;

/**
 * `useNarrowerThan` for a header whose wider form can need more than `px`: narrow too while `el` cannot hold what `tools`
 * (the wider form's controls) take plus `reserve` (the room its title keeps). `tools` is only there while the wider form is
 * shown (pass the element held in state, or null): its width is remembered from then, since the narrower form says nothing
 * of what the wider one needs, and the wider form comes back only with `SPARE_PX` of room to spare, so that a width right
 * at the edge does not tip it back and forth.
 */
export function useNarrowerThanContent(
	el: HTMLElement | null,
	px: number,
	tools: HTMLElement | null,
	reserve: number,
): boolean {
	const [narrow, setNarrow] = useState(false);
	const need = useRef(0);
	const was = useRef(false);
	useLayoutEffect(() => {
		if (!el) return;
		const measure = () => {
			if (tools?.isConnected) need.current = tools.offsetWidth + reserve;
			const room = el.clientWidth;
			const next = room < px || room < need.current + (was.current ? SPARE_PX : 0);
			if (next === was.current) return;
			was.current = next;
			setNarrow(next);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		if (tools) observer.observe(tools);
		return () => observer.disconnect();
	}, [el, px, tools, reserve]);
	return narrow;
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
