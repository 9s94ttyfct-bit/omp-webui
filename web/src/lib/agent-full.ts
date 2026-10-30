/**
 * The subagent full screen's switcher: the conversation's subagents in the order the Agents tab lists them (running
 * ones first by start time, the newest start on top, ties by id; see `agentRows`), moved through one at a time.
 */

/** The subagent `delta` places from `id`, or null past either end and when `id` is not listed. */
export function neighbour(rows: readonly { id: string }[], id: string, delta: -1 | 1): string | null {
	const at = rows.findIndex((r) => r.id === id);
	return at < 0 ? null : (rows[at + delta]?.id ?? null);
}

/** Which of how many `id` is (counting from 1), or null when it is not listed. */
export function positionOf(rows: readonly { id: string }[], id: string): { index: number; total: number } | null {
	const at = rows.findIndex((r) => r.id === id);
	return at < 0 ? null : { index: at + 1, total: rows.length };
}

/** The address parameter that marks a window opened for one subagent: it shows that and nothing else of the app. */
export const POPOUT_PARAM = "popout";

/** Whether an address's query (`location.search`) marks a window opened for one subagent. */
export function isPopOut(search: string): boolean {
	return new URLSearchParams(search).has(POPOUT_PARAM);
}

/** The address of a window for a subagent: the app's own address, flagged, with the route (`hashOf` of its full screen). */
export function popOutHref(origin: string, hash: string): string {
	return `${origin}/?${POPOUT_PARAM}${hash}`;
}

/** The full screen of a subagent is up over the page: the shell under it is hidden, and its own shortcuts must not act. */
export function agentFullOpen(): boolean {
	return document.documentElement.hasAttribute("data-agent-full");
}

/**
 * Whether a key pressed in a text field is the field's, not the full screen's: the arrows move its caret, and a printable
 * key is a character (Option+L is `¬` on a US Mac, `@` on a German one, `ł` on a Polish one).
 */
export function fieldKeepsKey(key: string): boolean {
	return key.length === 1 || key.startsWith("Arrow");
}
