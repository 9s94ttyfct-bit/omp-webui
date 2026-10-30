/**
 * Whether a tool card is open: what the reader chose by hand (`chosen`: true/false, or null for no choice yet), else
 * open exactly while the tool runs, so its output is seen as it streams and the card folds away once it is done.
 * The same rule as a thinking block's. A hand-made choice wins for good, in either direction.
 */
export function toolOpen(chosen: boolean | null, running: boolean): boolean {
	return chosen ?? running;
}

/**
 * The part of a running tool's output to show: the newest `limit` characters, behind an ellipsis when older text is cut.
 * What a finished card shows is the start of the output; a running one is read for what it printed last.
 */
export function outputTail(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `…\n${text.slice(text.length - limit)}`;
}

/** Whether a scrolled box (a running tool's output) is at its end, within a few pixels, so new output should be followed. */
export function atEnd(box: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
	return box.scrollHeight - box.scrollTop - box.clientHeight <= 24;
}
