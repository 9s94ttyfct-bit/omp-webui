/**
 * What the reader chose by hand for a tool card (true: open, false: folded), by tool call id. A card forgets its own
 * state when it is drawn anew, which happens when its message moves from the live stream to the saved transcript and
 * when its row leaves the running turn's window and comes back; the choice must outlive that. Tool call ids are unique
 * (omp's own), so one map serves every conversation. Only the latest `MAX_CHOICES` are kept.
 */
export const MAX_CHOICES = 200;

const choices = new Map<string, boolean>();

export function toolChoice(id: string): boolean | null {
	return choices.get(id) ?? null;
}

export function rememberToolChoice(id: string, open: boolean): void {
	// Re-inserted, so a card chosen again counts as the newest.
	choices.delete(id);
	choices.set(id, open);
	if (choices.size > MAX_CHOICES) {
		const oldest = choices.keys().next();
		if (!oldest.done) choices.delete(oldest.value);
	}
}
