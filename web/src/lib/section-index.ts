import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A card of a long page: the element, the title its heading names it by, and a key that stays with the element.
 */
export interface IndexEntry {
	el: HTMLElement;
	title: string;
	key: number;
}

const keys = new WeakMap<HTMLElement, number>();
let lastKey = 0;
function keyOf(el: HTMLElement): number {
	let key = keys.get(el);
	if (key === undefined) {
		key = ++lastKey;
		keys.set(el, key);
	}
	return key;
}

/** How far under the top of the scroller a card's start counts as being read (a little more than a heading's margin). */
const READING_LINE = 96;
/**
 * A card with less than this much of itself left under the reading line is being left: the next card is the one read.
 * Without it a tall card that had scrolled nearly out of view stayed marked while the reader was on the cards after it.
 */
const TAIL = 64;
/**
 * A card that has scrolled up out of the page, and has less than this share of the scroller's height left under the
 * reading line, is being left as well. In a tall window (1080 px) the part of a card that is still in view at the top
 * is a few hundred pixels, and the reader is on what is below it: the next cards, whole, and the one after.
 */
const LEFT_SHARE = 0.3;
/** How far a card may drift on the screen and still be the one the reader chose. */
const DRIFT = 8;

/**
 * The cards of `root`: its direct `<section>` children that have an `<h2>`, in page order. A card whose heading is a
 * whole sentence names a short label for the index in `data-index-title`: a sentence as a chip ran off a phone's width.
 */
function collect(root: HTMLElement): IndexEntry[] {
	const entries: IndexEntry[] = [];
	for (const el of root.querySelectorAll<HTMLElement>(":scope > section")) {
		const title = el.dataset.indexTitle?.trim() || el.querySelector("h2")?.textContent?.trim();
		if (title) entries.push({ el, title, key: keyOf(el) });
	}
	return entries;
}

function same(a: IndexEntry[], b: IndexEntry[]): boolean {
	return a.length === b.length && a.every((e, i) => e.el === b[i].el && e.title === b[i].title);
}

/**
 * An index of a long page of cards, for jumping between them and seeing where you are: the cards are found in the page
 * (so a card that appears, goes away or is retitled by the language shows up in the index without being listed twice),
 * the current one is the last card that starts above the reading line (the last one at the very end of the page), and
 * `go` brings one to the top.
 *
 * A card chosen with `go` keeps the mark while the page stays where the reader put it: a card near the end of the page
 * cannot always reach the top, and the reading line would pick the one after it. The mark goes back to the page's own
 * line as soon as the reader moves the page away from the card they chose.
 */
export function useSectionIndex(root: HTMLElement | null, scroller: HTMLElement | null) {
	const [entries, setEntries] = useState<IndexEntry[]>([]);
	const [current, setCurrent] = useState<HTMLElement | null>(null);
	/** The card the reader chose and where it sat on the screen when they chose it. */
	const pinned = useRef<{ el: HTMLElement; top: number } | null>(null);

	useEffect(() => {
		if (!root) return;
		const read = () =>
			setEntries((before) => {
				const now = collect(root);
				return same(before, now) ? before : now;
			});
		read();
		const observer = new MutationObserver(read);
		observer.observe(root, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["data-index-title"],
		});
		return () => observer.disconnect();
	}, [root]);

	useEffect(() => {
		if (!scroller || !root || !entries.length) return;
		let frame = 0;
		/** Where a card sits on the screen, counted from the top of the scroller. */
		const topOf = (el: HTMLElement) => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
		/** The card the page is on: the one the reader chose (while the page stays where they put it), else the last
		 * card that starts above the reading line. */
		const measure = () => {
			frame = 0;
			const held = pinned.current;
			if (held && entries.some((e) => e.el === held.el)) {
				if (Math.abs(topOf(held.el) - held.top) <= DRIFT) {
					setCurrent(held.el);
					return;
				}
				pinned.current = null;
			}
			const box = scroller.getBoundingClientRect();
			const line = box.top + READING_LINE;
			let at = 0;
			for (const [i, e] of entries.entries()) {
				if (e.el.getBoundingClientRect().top > line) break;
				at = i;
			}
			if (at + 1 < entries.length) {
				const rect = entries[at].el.getBoundingClientRect();
				const room = rect.top < box.top ? Math.max(TAIL, scroller.clientHeight * LEFT_SHARE) : TAIL;
				if (rect.bottom < line + room) at++;
			}
			const found = entries[at].el;
			const atEnd = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
			setCurrent(atEnd ? (entries.at(-1)?.el ?? found) : found);
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		measure();
		scroller.addEventListener("scroll", schedule, { passive: true });
		// The page grows and shrinks (a card loads, the window is resized): the reading line meets another card.
		const observer = new ResizeObserver(schedule);
		observer.observe(scroller);
		observer.observe(root);
		return () => {
			cancelAnimationFrame(frame);
			scroller.removeEventListener("scroll", schedule);
			observer.disconnect();
		};
	}, [scroller, root, entries]);

	const go = useCallback(
		(entry: IndexEntry) => {
			// The jump is immediate: the page is thousands of pixels long, and a long glide over it is neither quick
			// nor where the reader asked to be.
			entry.el.scrollIntoView({ behavior: "auto", block: "start" });
			pinned.current = {
				el: entry.el,
				top: entry.el.getBoundingClientRect().top - (scroller?.getBoundingClientRect().top ?? 0),
			};
			setCurrent(entry.el);
		},
		[scroller],
	);

	return { entries, current, go };
}
