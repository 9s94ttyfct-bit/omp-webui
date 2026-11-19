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

/** The query as a pattern that matches it in any case, for every script: `lower()` of SQLite folds A-Z only (#229). */
const caseInsensitive = (query: string): RegExp => new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");

/**
 * The snippet of a hit of a short query: the `SHORT_LENGTH` characters of text that start `SHORT_BEFORE` before the
 * first match (`start`, 1-based, from `substr(text, max(1, instr(…) - SHORT_BEFORE), SHORT_LENGTH)`), with every match
 * in them marked, and `…` where the text goes on past either end (`total` is the text's length in characters).
 */
export function shortSnippet(window: string, query: string, start: number, total: number): string {
	const text = window.replaceAll(SNIPPET_OPEN, "").replaceAll(SNIPPET_CLOSE, "");
	let out = "";
	let at = 0;
	if (query !== "") {
		for (const m of text.matchAll(caseInsensitive(query))) {
			if (m[0] === "") continue;
			out += `${text.slice(at, m.index)}${SNIPPET_OPEN}${m[0]}${SNIPPET_CLOSE}`;
			at = m.index + m[0].length;
		}
	}
	out += text.slice(at);
	const reachesEnd = start - 1 + [...window].length >= total;
	return `${start > 1 ? "…" : ""}${out}${reachesEnd ? "" : "…"}`;
}
