/**
 * The fuzzy match behind every search in the app: Settings, the conversations in the sidebar and the model picker.
 *
 * A query matches a text when its letters appear in the text in that order (a subsequence), and the score says how much
 * the match looks like what a person meant:
 *
 *  - the start of a word beats a letter inside one (`son` finds *Sonnet* before *Personally*);
 *  - letters in a row beat letters apart (`hai` finds *Haiku* well and *H·a·i* badly);
 *  - the start of the text beats the middle (`set` finds *Settings* before *Reset layout*).
 *
 * Case and diacritics are folded, so `cafe` finds *Café* and `RESET` finds *Reset*. Chinese has no spaces: a run of
 * Chinese characters is one word, whose first character is its start, so `设置` finds *设置页面* and every character of
 * the match that follows the first earns the letters-in-a-row bonus.
 *
 * A query with several words (spaces, or `-`, `_`, `/`, `.` between them) matches when each word does, in any place;
 * the scores add up. `claude-4` and `claude 4` are the same query.
 *
 * The score is deliberately made of whole numbers and a fixed order of bonuses, so that a ranking is the same on every
 * machine and a test can say what it expects. It is not a distance: only its order, and which characters matched, are
 * the API.
 */

/** Where a match put the characters it matched, and how good it is; higher is better. */
export interface FuzzyMatch {
	/** A match with no characters is 0; every match of a character is at least 1. */
	score: number;
	/** For each matched character, where it is in the text (code-unit indices: what `slice` wants). */
	positions: number[];
}

/** Characters that end a word. A match right after one is at the start of the next word. */
const SEPARATOR = new Set(" \t\n\r\f\v-_/\\.,:;·|()[]{}<>\"'`~!?@#$%^&*+=");

/** What a word of the query may be split on besides whitespace. */
const WORD_BREAK = /[\s\-_/\\.,:;·|()[\]{}<>"'`~!?@#$%^&*+=]+/;

/** One character of the text, folded, and where it came from. */
interface Folded {
	/** The folded text: lowercase, without diacritics or combining marks. */
	text: string;
	/** For each folded character, its index in the original text (the start of a surrogate pair). */
	at: number[];
	/** For each folded character, whether it starts a word in the original text. */
	start: boolean[];
}

const MARKS = /\p{M}/gu;
const LOWER = /\p{Ll}|\p{Nd}/u;
const UPPER = /\p{Lu}/u;

/**
 * The text as it is compared: lowercased and stripped of diacritics, keeping the index and the word starts of the
 * original, so that what matched can be shown in the text a person reads.
 */
function fold(text: string): Folded {
	const out: Folded = { text: "", at: [], start: [] };
	let afterSeparator = true;
	let previous = "";
	for (let i = 0; i < text.length; ) {
		const code = text.codePointAt(i) ?? 0;
		const char = String.fromCodePoint(code);
		const width = char.length;
		// A letter with a diacritic written as two code points (`e` + combining acute) folds to the letter alone.
		const base = char.normalize("NFD").replace(MARKS, "").toLowerCase();
		const startsWord = afterSeparator || (LOWER.test(previous) && UPPER.test(char));
		for (const one of base) {
			out.text += one;
			out.at.push(i);
			out.start.push(startsWord);
		}
		afterSeparator = SEPARATOR.has(char);
		previous = char;
		i += width;
	}
	return out;
}

/** The words of a query, folded: an empty query has none. */
function words(query: string): string[] {
	return query
		.split(WORD_BREAK)
		.map((word) => fold(word).text)
		.filter((word) => word !== "");
}

const BASE = 1;
const WORD_START = 5;
/** More than `WORD_START`: a word typed in a row reads better than its letters each starting a word of their own. */
const IN_A_ROW = 7;
/** Taken off once for a word matched away from the start of the text, and for each character skipped (up to `GAP_CAP`). */
const GAP = 1;
const GAP_CAP = 3;
const PREFIX = 8;
const WHOLE = 20;

/** Options of `fuzzyMatch`. */
export interface FuzzyOptions {
	/**
	 * The most characters a match may skip between two letters of a word of the query (not before its first letter).
	 * Without it letters may be as far apart as the text is long, so that a short word is "found" in any sentence that
	 * has its letters in order: `theme` in *Keep the Mac awake while a conversation works*. `ntfctns` finds
	 * *Notifications* with at most 2 skipped between letters.
	 */
	maxSkip?: number;
}

/**
 * Where the letters of `word` go in `text`: the earliest alignment (the first letter's earliest place, then each next
 * letter's earliest place that is within `maxSkip` of the one before), or null when there is none.
 */
function align(word: string, text: Folded, maxSkip: number): number[] | null {
	const chars = [...word];
	const n = text.text.length;
	const at: number[] = [];
	if (maxSkip === Number.POSITIVE_INFINITY) {
		// No limit: the earliest place of each letter after the one before always works when any alignment does.
		let from = 0;
		for (const char of chars) {
			let found = -1;
			for (let i = from; i < n; i++) {
				if (text.text[i] === char) {
					found = i;
					break;
				}
			}
			if (found < 0) return null;
			at.push(found);
			from = found + 1;
		}
		return at;
	}
	// A limit makes the earliest place of a letter not always the one that works: try the places in order. The places
	// (letter, the one before it) that led nowhere are kept, so that none is tried twice.
	const dead = new Set<number>();
	const place = (i: number, last: number): boolean => {
		if (i === chars.length) return true;
		const key = i * (n + 1) + last + 1;
		if (dead.has(key)) return false;
		const to = i === 0 ? n - 1 : Math.min(n - 1, last + 1 + maxSkip);
		for (let p = last + 1; p <= to; p++) {
			if (text.text[p] !== chars[i]) continue;
			at.push(p);
			if (place(i + 1, p)) return true;
			at.pop();
		}
		dead.add(key);
		return false;
	};
	return place(0, -1) ? at : null;
}

/**
 * One word of the query against the folded text: its earliest match, scored. Null when the text has no such alignment.
 */
function matchWord(word: string, text: Folded, maxSkip: number): { score: number; at: number[] } | null {
	const at = align(word, text, maxSkip);
	if (!at) return null;
	let score = 0;
	let last = -1;
	for (const found of at) {
		score += BASE;
		if (text.start[found]) score += WORD_START;
		// The letters-in-a-row bonus for a word of one character is a match at the start, which `PREFIX` rewards.
		if (last >= 0) score += found === last + 1 ? IN_A_ROW : -Math.min(GAP_CAP, found - last - 1) * GAP;
		last = found;
	}
	// The first word matched at the very start of the text (a word that starts at 0 is already worth a word start).
	if (at[0] === 0) score += PREFIX;
	if (word === text.text) score += WHOLE;
	return { score: Math.max(1, score), at };
}

/**
 * How well `text` answers `query`, with where the matched characters are; null when it does not. An empty query
 * matches every text with a score of 0 and no characters (a search that has nothing typed in it filters nothing).
 */
export function fuzzyMatch(
	query: string,
	text: string,
	{ maxSkip = Number.POSITIVE_INFINITY }: FuzzyOptions = {},
): FuzzyMatch | null {
	const parts = words(query);
	if (parts.length === 0) return { score: 0, positions: [] };
	const folded = fold(text);
	let score = 0;
	const positions: number[] = [];
	for (const word of parts) {
		const found = matchWord(word, folded, maxSkip);
		if (!found) return null;
		score += found.score;
		for (const i of found.at) positions.push(folded.at[i] as number);
	}
	// Two words that matched in the same place (a query that repeats a word) are one place, shown once.
	return { score, positions: [...new Set(positions)].sort((a, b) => a - b) };
}
