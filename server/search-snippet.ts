/**
 * Snippets of a search hit. The page marks what matched by the two control characters around it (`web/src/components/
 * Palette.tsx` reads them). FTS5's `snippet()` puts them around a trigram match; a 1-2 character query is a substring
 * scan (trigram search needs 3 characters), and `shortSnippet` makes the same kind of snippet for it.
 */

export const SNIPPET_OPEN = "\u0002";
export const SNIPPET_CLOSE = "\u0003";
/** Characters of text before the first match that a short query's snippet starts, and how long it is. */
export const SHORT_BEFORE = 40;
export const SHORT_LENGTH = 120;

/**
 * What SQLite's `lower()` does: A-Z only. The scan chose its rows with it (`instr(lower(text), lower(?))`), so the
 * snippet finds the matches the same way, and the indices of the text stay those of its lower-case.
 */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) | 32));

/**
 * The snippet of a hit of a short query: the `SHORT_LENGTH` characters of text that start `SHORT_BEFORE` before the
 * first match (`start`, 1-based, from `substr(text, max(1, instr(…) - SHORT_BEFORE), SHORT_LENGTH)`), with every match
 * in them marked, and `…` where the text goes on past either end (`total` is the text's length in characters).
 */
export function shortSnippet(window: string, query: string, start: number, total: number): string {
	const text = window.replaceAll(SNIPPET_OPEN, "").replaceAll(SNIPPET_CLOSE, "");
	const haystack = asciiLower(text);
	const needle = asciiLower(query);
	let out = "";
	let at = 0;
	for (let i = haystack.indexOf(needle); needle && i >= 0; i = haystack.indexOf(needle, at)) {
		out += `${text.slice(at, i)}${SNIPPET_OPEN}${text.slice(i, i + needle.length)}${SNIPPET_CLOSE}`;
		at = i + needle.length;
	}
	out += text.slice(at);
	const reachesEnd = start - 1 + [...window].length >= total;
	return `${start > 1 ? "…" : ""}${out}${reachesEnd ? "" : "…"}`;
}
