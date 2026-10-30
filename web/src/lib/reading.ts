/**
 * Where a reader was in a conversation, kept for the history entry they left it on: Back reopens the conversation
 * with the messages that were shown and the message at the top of the view where it was, not at the end with only the
 * latest ones. Every history entry the page makes has an id in its state; the reading is kept under it, in memory
 * (a page loaded anew starts from the end, as opening a conversation does).
 */

/** The messages a transcript shows, by the keys of the first and the last (null: from the first, through the last). */
export interface ReadingWindow {
	from: string | null;
	to: string | null;
}

export interface Reading {
	window: ReadingWindow;
	/**
	 * The message at the top of the view and how far its top is from the top of the view (negative: above it); null when
	 * the reader was at the end, which they follow.
	 */
	anchor: { segment: string; top: number } | null;
}

/** The most readings kept: the oldest go first. */
const MAX_READINGS = 100;
const STATE_KEY = "ompwEntry";

const readings = new Map<string, Reading>();
/** The history entry the page is on, when it has an id. */
let current: string | null = null;
/** What reads the conversation on screen: set by the chat page while it is mounted. */
let reader: (() => Reading | null) | null = null;

/** A new id for a history entry. Not `crypto.randomUUID`: a page served over plain http on a LAN has no secure context. */
export function newEntryId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The state to give a history entry that has this id. */
export function entryState(id: string): Record<string, string> {
	return { [STATE_KEY]: id };
}

/** The id in a history entry's state; null for an entry made by anything else (the page's first, a link). */
export function entryIdOf(state: unknown): string | null {
	const id = typeof state === "object" && state !== null ? (state as Record<string, unknown>)[STATE_KEY] : undefined;
	return typeof id === "string" ? id : null;
}

/** The page is on the history entry with this id (null: one without). */
export function enterEntry(id: string | null): void {
	current = id;
}

/** The chat page that is mounted says how to read where its reader is; returns what takes it back. */
export function registerReader(read: () => Reading | null): () => void {
	reader = read;
	return () => {
		if (reader === read) reader = null;
	};
}

/** The page is about to leave its history entry: keep where the reader is for when they come back to it. */
export function keepReading(): void {
	const reading = reader?.() ?? null;
	if (current === null || reading === null) return;
	readings.delete(current);
	readings.set(current, reading);
	const oldest = readings.keys().next().value;
	if (readings.size > MAX_READINGS && oldest !== undefined) readings.delete(oldest);
}

/** What was kept for a history entry. */
export function readingOf(id: string | null): Reading | undefined {
	return id === null ? undefined : readings.get(id);
}

/**
 * The message at the top of a transcript's view, for `Reading.anchor`; null when nothing is drawn. The pages above the
 * view are passed by their own boxes: a message inside a page the browser skips has no box until the page is drawn.
 */
export function readAnchor(view: HTMLElement): Reading["anchor"] {
	const top = view.getBoundingClientRect().top;
	for (const page of view.querySelectorAll<HTMLElement>("[data-page]")) {
		if (page.getBoundingClientRect().bottom <= top + 1) continue;
		for (const segment of page.querySelectorAll<HTMLElement>("[data-segment]")) {
			const box = segment.getBoundingClientRect();
			if (box.bottom > top + 1) return { segment: segment.dataset.segment ?? "", top: box.top - top };
		}
	}
	return null;
}

/** Scroll a transcript's view so that the message is where it was; false when the message is not drawn. */
export function placeAnchor(view: HTMLElement, anchor: { segment: string; top: number }): boolean {
	const segment = view.querySelector<HTMLElement>(`[data-segment="${CSS.escape(anchor.segment)}"]`);
	if (!segment) return false;
	view.scrollTop += segment.getBoundingClientRect().top - view.getBoundingClientRect().top - anchor.top;
	return true;
}
