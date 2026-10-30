import { type RefObject, useLayoutEffect } from "react";

/**
 * A strip of tabs that stays on one line: labels are shown on every tab while they fit; when they do not, the
 * inactive tabs shrink to their icon (the strip gets `data-compact`, which the tabs' CSS reads); when that is too wide
 * the active tab loses its label too (`data-compact="icons"`); only when even that is too wide does it scroll sideways,
 * and then the active tab is kept in view. A vertical wheel over the strip scrolls it sideways, since its scrollbar is
 * hidden.
 *
 * With `compact` off the labels stay (a strip of tabs that are labelled whatever their number, like the phone's sheet): it
 * only scrolls, and keeps the active tab in view.
 *
 * `fitKey` changes whenever the tabs' content does (labels, counts); a resize of the strip is watched here.
 */
export function useFittingTabStrip(
	strip: RefObject<HTMLElement | null>,
	activeKey: string,
	fitKey: string,
	compact = true,
): void {
	// Before paint, so a change of the counts or of the language never shows a frame of overflow.
	// biome-ignore lint/correctness/useExhaustiveDependencies: fitKey/activeKey are the triggers, not values read here.
	useLayoutEffect(() => {
		const el = strip.current;
		if (!el) return;
		const fit = () => {
			// Measure with every label showing: that is the width that decides whether they all fit.
			el.removeAttribute("data-compact");
			if (compact) {
				if (el.scrollWidth > el.clientWidth) el.setAttribute("data-compact", "");
				if (el.scrollWidth > el.clientWidth) el.setAttribute("data-compact", "icons");
			}
			revealActive(el);
		};
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(el);
		return () => observer.disconnect();
	}, [strip, activeKey, fitKey, compact]);

	useLayoutEffect(() => {
		const el = strip.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			// A touchpad's own sideways swipe already scrolls it; a mouse wheel only turns vertically.
			if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
			const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
			const before = el.scrollLeft;
			el.scrollLeft += e.deltaY * unit;
			if (el.scrollLeft !== before) e.preventDefault();
		};
		// Not React's `onWheel`: that listener is passive and cannot cancel the page's own scrolling.
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [strip]);
}

/** Scroll the strip, and only the strip, so that its active tab is wholly visible. */
function revealActive(strip: HTMLElement): void {
	const active = strip.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
	if (!active || strip.scrollWidth <= strip.clientWidth) return;
	const bar = strip.getBoundingClientRect();
	const tab = active.getBoundingClientRect();
	// The strip's own padding (it keeps focus rings from being clipped) is the margin left around the tab.
	const pad = Number.parseFloat(getComputedStyle(strip).paddingLeft) || 0;
	if (tab.left < bar.left + pad) strip.scrollLeft += tab.left - bar.left - pad;
	else if (tab.right > bar.right - pad) strip.scrollLeft += tab.right - bar.right + pad;
}
