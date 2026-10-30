/**
 * Keeping the message the reader is looking at where it is while history is put above it.
 *
 * Earlier messages are shown (or a page of history is brought in) above the reader, and what is above them changes size
 * for a while after it is drawn: a code block is highlighted, a tool card settles, a block of steps is laid out. Moving
 * the scroll position by the height that was added, once, is wrong by whatever happens after, and by whatever else in
 * the page changed height above the reader meanwhile (a button row that came or went). So the reader's place is a message
 * (the first one that has any of it in the view) and how far from the top of the view it is: put back after the change,
 * and again whenever the page above it changes size, for a short while.
 */

/** The message at the top of the view, and where its top is, from the view's top. */
export interface EntryAnchor {
	id: string;
	top: number;
}

const SELECTOR = "[data-entry-id]";

/** The first message that has any of it below the top of the view, or null when none is drawn. */
export function entryAnchor(view: HTMLElement): EntryAnchor | null {
	const viewTop = view.getBoundingClientRect().top;
	for (const el of view.querySelectorAll<HTMLElement>(SELECTOR)) {
		const box = el.getBoundingClientRect();
		if (box.height > 0 && box.bottom > viewTop + 1) return { id: el.dataset.entryId ?? "", top: box.top - viewTop };
	}
	return null;
}

/** Scroll the view so that the anchor's message is where it was. False when that message is not drawn. */
export function placeEntryAnchor(view: HTMLElement, anchor: EntryAnchor): boolean {
	const el = view.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(anchor.id)}"]`);
	if (!el) return false;
	const shift = el.getBoundingClientRect().top - view.getBoundingClientRect().top - anchor.top;
	if (shift !== 0) view.scrollTop += shift;
	return true;
}

/** How long the place is held after history was put above it. */
const HOLD_MS = 2000;

/**
 * Holds the reader's place for a short while after history was put above it: whenever `content` changes size and the
 * reader has not scrolled since, the anchor's message is put back; when the reader scrolls, the place to hold is the
 * one they scrolled to.
 */
export class AnchorHold {
	private anchor: EntryAnchor | null = null;
	private view: HTMLElement | null = null;
	/** Where the view was scrolled to when the anchor was taken: a different position means the reader moved. */
	private scrolledTo = 0;
	private until = 0;
	private observer: ResizeObserver | null = null;

	/** Hold `anchor` (the place of the message it names in `view`) while `content` changes size. */
	arm(view: HTMLElement, content: HTMLElement, anchor: EntryAnchor): void {
		this.stop();
		if (typeof ResizeObserver === "undefined") return;
		this.view = view;
		this.anchor = anchor;
		this.scrolledTo = view.scrollTop;
		this.until = performance.now() + HOLD_MS;
		this.observer = new ResizeObserver(() => this.settle());
		this.observer.observe(content);
		view.addEventListener("scroll", this.onScroll, { passive: true });
	}

	stop(): void {
		this.observer?.disconnect();
		this.observer = null;
		this.view?.removeEventListener("scroll", this.onScroll);
		this.view = null;
		this.anchor = null;
	}

	private readonly onScroll = (): void => {
		const view = this.view;
		if (!view) return;
		if (performance.now() > this.until) {
			this.stop();
			return;
		}
		// Our own correction: the position is the one we set. Anything else is the reader.
		if (view.scrollTop === this.scrolledTo) return;
		this.anchor = entryAnchor(view);
		this.scrolledTo = view.scrollTop;
	};

	private settle(): void {
		const view = this.view;
		if (!view || !this.anchor) return;
		if (performance.now() > this.until) {
			this.stop();
			return;
		}
		if (view.scrollTop !== this.scrolledTo) {
			// The reader moved since the place was taken: it is theirs now, and nothing is put back.
			this.anchor = entryAnchor(view);
			this.scrolledTo = view.scrollTop;
			return;
		}
		if (placeEntryAnchor(view, this.anchor)) this.scrolledTo = view.scrollTop;
	}
}
