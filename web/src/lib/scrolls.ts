import { useCallback, useState } from "react";

/**
 * Whether a box scrolls: its content is taller or wider than the box. Kept current as the box or what is in it changes
 * (a streaming tool output grows, a pane is resized). A box that scrolls takes `tabIndex={0}`, so it can be reached and
 * scrolled from the keyboard (axe: scrollable-region-focusable; Safari and Firefox do not make such a box focusable on
 * their own); one that does not scroll is no stop on the way.
 */
export function useScrolls<T extends HTMLElement>(): [(el: T | null) => () => void, boolean] {
	const [scrolls, setScrolls] = useState(false);
	const ref = useCallback((el: T | null) => {
		if (!el) return () => {};
		let frame = 0;
		const measure = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() =>
				setScrolls(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1),
			);
		};
		const resize = new ResizeObserver(measure);
		const watch = () => {
			resize.disconnect();
			resize.observe(el);
			for (const child of el.children) resize.observe(child);
			measure();
		};
		// Content that grows inside a box of fixed height does not resize the box: its children and its text are watched too.
		const mutation = new MutationObserver(watch);
		mutation.observe(el, { childList: true, subtree: true, characterData: true });
		watch();
		return () => {
			cancelAnimationFrame(frame);
			resize.disconnect();
			mutation.disconnect();
		};
	}, []);
	return [ref, scrolls];
}
