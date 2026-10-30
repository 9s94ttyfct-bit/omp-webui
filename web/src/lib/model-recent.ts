/**
 * The models a person picked recently, newest first: the model picker lists them above the rest of the catalog, so the
 * few models someone switches between are one Enter away. Kept in this browser's localStorage (never synced: it is a
 * habit of this window, not a setting), and small: only the last few are remembered.
 */

const KEY = "ompw.recentModels";
/** How many picks are remembered: enough for the usual handful of models, short enough to read at a glance. */
export const RECENT_LIMIT = 6;

const listeners = new Set<(keys: readonly string[]) => void>();

/** Whether `value` is what this module writes: a short list of `provider/id` keys. */
function parse(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string").slice(0, RECENT_LIMIT) : [];
	} catch {
		return [];
	}
}

/** The models picked recently, newest first. */
export function recentModels(storage: Pick<Storage, "getItem"> = localStorage): string[] {
	return parse(storage.getItem(KEY));
}

/** Remember a pick: its model goes to the front, once. */
export function noteRecentModel(key: string, storage: Pick<Storage, "getItem" | "setItem"> = localStorage): string[] {
	const next = [key, ...recentModels(storage).filter((k) => k !== key)].slice(0, RECENT_LIMIT);
	storage.setItem(KEY, JSON.stringify(next));
	for (const listener of listeners) listener(next);
	return next;
}

/** Be told when a model was picked (another window, or this one). Returns the way to stop being told. */
export function onRecentModels(listener: (keys: readonly string[]) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
