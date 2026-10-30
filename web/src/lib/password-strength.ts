/**
 * Password strength estimate for the export password (Settings > Move to another computer).
 *
 * A small zxcvbn-style estimator: find patterns (dictionary words with l33t/reversal/case variants, sequences,
 * repeats, keyboard walks, dates) and brute-force spans, then take the decomposition with the fewest guesses by
 * dynamic programming. Score thresholds are zxcvbn's. Deliberate differences from zxcvbn: the "growing sequence"
 * constant is 1000 (zxcvbn: 10000), a separator between two matches costs a factor 2 instead of a brute-force match
 * (so passphrases are not punished for their dashes), and brute-force cardinality counts non-ASCII characters as 100
 * (CJK ideographs 3000). No DOM and no Node APIs; every table is built on first use, nothing runs at import time.
 */

export type StrengthReason =
	| "short" // fewer than 12 characters (8 is the hard floor enforced elsewhere)
	| "common" // is, or is nearly, a very common password
	| "word" // built on dictionary words (l33t, capitalised first letter, trailing digits/!)
	| "sequence" // abc, 1234, 9876
	| "keyboard" // qwerty, asdf, 1qaz2wsx, numeric keypad walks
	| "repeat" // aaaa, abcabc, 123123
	| "date" // a year (1900-2099) or a date like 19/04/1990, 190490
	| "singleKind"; // only letters, or only digits (no mix at all)

export interface Strength {
	/** zxcvbn-like score: 0 very weak, 1 weak, 2 fair, 3 strong, 4 very strong. */
	score: 0 | 1 | 2 | 3 | 4;
	/** log10 of the estimated number of guesses. */
	guessesLog10: number;
	/** Why it is weak, most important first, no duplicates, at most 3. Empty when score >= 3 and nothing noteworthy. */
	reasons: StrengthReason[];
}

const MAX_CHARS = 256;
const SHORT_BELOW = 12;
const REFERENCE_YEAR = 2025;
const MAX_DELTA = 5;
const LOG_GROWTH = 3;
const LOG_SEPARATOR = Math.log10(2);
const LOG_MIN_MULTI = Math.log10(50);
const LOG_WIDE = Math.log10(100);
const LOG_IDEOGRAPH = Math.log10(3000);
/** Guesses charged for a word of the suggestion list, whatever its rank in the common list (a lower bound of the list size). */
const PASSPHRASE_RANK = 512;
const SEPARATORS = " -_.";
const SCORE_BOUNDS = [1e3, 1e6, 1e8, 1e10].map((g) => Math.log10(g + 5));
const REASON_ORDER: readonly StrengthReason[] = [
	"common",
	"repeat",
	"keyboard",
	"sequence",
	"date",
	"word",
	"singleKind",
];
/** Cardinality of ASCII digits, lowercase, uppercase, symbols. */
const CARDINALITY = [10, 26, 26, 33];
const LEET: Record<string, string> = {
	"4": "a",
	"@": "a",
	"8": "b",
	"(": "c",
	"{": "c",
	"[": "c",
	"<": "c",
	"3": "e",
	"6": "g",
	"9": "g",
	"1": "i",
	"!": "i",
	"|": "l",
	"0": "o",
	$: "s",
	"5": "s",
	"+": "t",
	"7": "t",
	"2": "z",
};
const DATE_SPLITS: Record<number, number[][]> = {
	4: [
		[1, 2],
		[2, 3],
	],
	5: [
		[1, 3],
		[2, 3],
	],
	6: [
		[1, 2],
		[2, 4],
		[4, 5],
	],
	7: [
		[1, 3],
		[2, 3],
		[4, 5],
		[4, 6],
	],
	8: [
		[2, 4],
		[4, 6],
	],
};

interface Match {
	i: number;
	j: number;
	reason: StrengthReason;
	/** log10 of the guesses this pattern costs. */
	log: number;
	/** Dictionary matches only: the entry is in the common-password list. */
	common?: boolean;
}

/** Best way found to cover a prefix with `l` matches. */
interface Cell {
	l: number;
	/** Product (as log10) of the guesses of the matches used. */
	logPi: number;
	/** The last step is a brute-force span. */
	brute: boolean;
	/** Characters covered before the last step, and the match count there. */
	from: number;
	fromL: number;
	match: Match | null;
}

interface Analysis {
	log: number;
	/** The cheapest decomposition. */
	matches: Match[];
	/** Every pattern found, whether or not the cheapest decomposition uses it. */
	all: Match[];
}

interface Entry {
	rank: number;
	common: boolean;
}

interface Dictionary {
	map: Map<string, Entry>;
	maxLen: number;
}

interface Key {
	r: number;
	x: number;
	shift: boolean;
}

interface Board {
	keys: Map<string, Key>;
	/** Cross-row neighbours may be exactly one column away (keypad) instead of strictly closer (staggered rows). */
	grid: boolean;
	starts: number;
	degree: number;
}

let dictionaryCache: Dictionary | undefined;
let passphraseCache: string[] | undefined;
let boardsCache: Board[] | undefined;
let logFactCache: number[] | undefined;
let bruteLogCache: number[] | undefined;

/** The words `suggestPassphrase` draws from: sorted, 4-8 lowercase letters, none a prefix of another. */
export function getPassphraseWords(): readonly string[] {
	passphraseCache ??= PASSPHRASE_WORDS.join(" ").split(" ");
	return passphraseCache;
}

/** `words` (default 5) unrelated common words joined by "-"; uses only the injected randomInt (unbiased in [0, n)). */
export function suggestPassphrase(randomInt: (n: number) => number, words = 5): string {
	const pool = getPassphraseWords().slice();
	if (!Number.isInteger(words) || words < 1 || words > pool.length) {
		throw new RangeError(`words must be an integer in [1, ${pool.length}]`);
	}
	// Partial Fisher-Yates: distinct words, exactly one draw per word.
	for (let k = 0; k < words; k++) {
		const j = k + randomInt(pool.length - k);
		const picked = pool[j] as string;
		pool[j] = pool[k] as string;
		pool[k] = picked;
	}
	return pool.slice(0, words).join("-");
}

export function estimateStrength(password: string): Strength {
	// A cut in the middle of a surrogate pair at the very end cannot change a score of an input this long.
	const text = (password.length > MAX_CHARS * 4 ? password.slice(0, MAX_CHARS * 4) : password).normalize("NFKC");
	const all = Array.from(text);
	const short = all.length < SHORT_BELOW;
	if (all.length === 0) return { score: 0, guessesLog10: 0, reasons: ["short"] };
	const chars = all.length > MAX_CHARS ? all.slice(0, MAX_CHARS) : all;
	const best = analyze(chars);
	let score = 0;
	for (const bound of SCORE_BOUNDS) if (best.log >= bound) score++;
	const reasons: StrengthReason[] = [];
	if (score <= 2) reasons.push(...weaknesses(chars, best, text));
	const kept = short ? reasons.slice(0, 2) : reasons.slice(0, 3);
	if (short) kept.push("short");
	return { score: score as Strength["score"], guessesLog10: best.log, reasons: kept };
}

/** Weak-pattern reasons in priority order, without "short". */
function weaknesses(chars: string[], best: Analysis, text: string): StrengthReason[] {
	const n = chars.length;
	const found = new Set<StrengthReason>();
	const swallowers: Match[] = [];
	for (const m of best.matches) {
		const common = m.reason === "word" && m.common && (m.j - m.i + 1) * 5 >= n * 3;
		found.add(common ? "common" : m.reason);
		if (common) swallowers.push(m);
	}
	// A walk or sequence inside a common password is not in the cheapest decomposition but is still worth a hint.
	for (const m of best.all) {
		if (m.reason !== "word" && m.j - m.i >= 3 && swallowers.some((s) => s.i <= m.i && m.j <= s.j)) found.add(m.reason);
	}
	if (/^[A-Za-z]+$/.test(text) || /^\d+$/.test(text)) found.add("singleKind");
	return REASON_ORDER.filter((r) => found.has(r));
}

function dictionary(): Dictionary {
	if (dictionaryCache) return dictionaryCache;
	const map = new Map<string, Entry>();
	COMMON_PASSWORDS.split(" ").forEach((w, k) => {
		if (!map.has(w)) map.set(w, { rank: k + 1, common: true });
	});
	COMMON_WORDS.split(" ").forEach((w, k) => {
		const e = map.get(w);
		if (!e) map.set(w, { rank: k + 1, common: false });
		else if (k + 1 < e.rank) e.rank = k + 1;
	});
	for (const w of getPassphraseWords()) {
		map.set(w, { rank: PASSPHRASE_RANK, common: map.get(w)?.common ?? false });
	}
	let maxLen = 0;
	for (const w of map.keys()) maxLen = Math.max(maxLen, Array.from(w).length);
	dictionaryCache = { map, maxLen };
	return dictionaryCache;
}

function binom(n: number, k: number): number {
	let r = 1;
	for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
	return r;
}

/** C(n,1) + ... + C(n,k). */
function sumBinom(n: number, k: number): number {
	let s = 0;
	for (let i = 1; i <= k; i++) s += binom(n, i);
	return s;
}

function logAdd(a: number, b: number): number {
	const hi = Math.max(a, b);
	return hi + Math.log10(1 + 10 ** (Math.min(a, b) - hi));
}

function logFact(l: number): number {
	if (!logFactCache) {
		logFactCache = [0];
		for (let i = 1; i <= MAX_CHARS + 1; i++) logFactCache.push((logFactCache[i - 1] as number) + Math.log10(i));
	}
	return logFactCache[l] as number;
}

/** 0 digit, 1 lowercase, 2 uppercase, 3 other ASCII, 4 any other character, 5 CJK ideograph. */
function kindOf(c: string): number {
	const code = c.codePointAt(0) ?? 0;
	if (code < 128) {
		if (code >= 48 && code <= 57) return 0;
		if (code >= 97 && code <= 122) return 1;
		if (code >= 65 && code <= 90) return 2;
		return 3;
	}
	const ideograph =
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0x20000 && code <= 0x2fa1f);
	return ideograph ? 5 : 4;
}

function caseVariants(token: string): number {
	if (token === token.toLowerCase()) return 1;
	if (/^[A-Z][^A-Z]+$/.test(token) || /^[^A-Z]+[A-Z]$/.test(token) || /^[^a-z]+$/.test(token)) return 2;
	let upper = 0;
	let lower = 0;
	for (const c of token) {
		if (c >= "A" && c <= "Z") upper++;
		else if (c >= "a" && c <= "z") lower++;
	}
	return Math.max(2, sumBinom(upper + lower, Math.min(upper, lower)));
}

/** Variants of a l33t token: for every substituted character, the ways of choosing which ones were substituted. */
function leetVariants(token: string, oneAs: string): number {
	let f = 1;
	const seen = new Set<string>();
	for (const c of token) {
		const sub = LEET[c];
		if (!sub || seen.has(c)) continue;
		seen.add(c);
		const letter = c === "1" ? oneAs : sub;
		let s = 0;
		let u = 0;
		for (const d of token) {
			if (d === c) s++;
			else if (d === letter) u++;
		}
		f *= s === 0 || u === 0 ? 2 : sumBinom(s + u, Math.min(s, u));
	}
	return f;
}

function dictionaryMatches(chars: string[], lower: string[], out: Match[]): void {
	const { map, maxLen } = dictionary();
	const n = chars.length;
	for (let i = 0; i < n; i++) {
		let tok = "";
		let rev = "";
		let leetA = "";
		let leetB = "";
		let subs = 0;
		let letters = false;
		let wide = false;
		for (let j = i; j < n && j - i < maxLen; j++) {
			const c = lower[j] as string;
			const sub = LEET[c];
			tok += c;
			rev = c + rev;
			leetA += sub ?? c;
			leetB += c === "1" ? "l" : (sub ?? c);
			if (sub) subs++;
			if (c >= "a" && c <= "z") letters = true;
			else if (c.charCodeAt(0) > 127) wide = true;
			const len = j - i + 1;
			if (len < (wide ? 2 : 3)) continue;
			const push = (e: Entry, extra: number) => {
				const orig = chars.slice(i, j + 1).join("");
				out.push({ i, j, reason: "word", common: e.common, log: Math.log10(e.rank * caseVariants(orig)) + extra });
			};
			const plain = map.get(tok);
			if (plain) push(plain, 0);
			const reversed = len >= 4 && rev !== tok ? map.get(rev) : undefined;
			if (reversed) push(reversed, Math.log10(2));
			if (subs > 0 && letters) {
				const a = leetA !== tok ? map.get(leetA) : undefined;
				if (a) push(a, Math.log10(leetVariants(tok, "i")));
				const b = leetB !== leetA && leetB !== tok ? map.get(leetB) : undefined;
				if (b) push(b, Math.log10(leetVariants(tok, "l")));
			}
		}
	}
}

function sequenceMatches(chars: string[], kinds: Uint8Array, out: Match[]): void {
	const n = chars.length;
	const code = (k: number) => (chars[k] as string).charCodeAt(0);
	let i = 0;
	while (i < n - 1) {
		const kind = kinds[i] as number;
		const delta = code(i + 1) - code(i);
		if (kind > 2 || kinds[i + 1] !== kind || delta === 0 || Math.abs(delta) > MAX_DELTA) {
			i++;
			continue;
		}
		let j = i + 1;
		while (j + 1 < n && kinds[j + 1] === kind && code(j + 1) - code(j) === delta) j++;
		const len = j - i + 1;
		if (len >= 3) {
			const first = chars[i] as string;
			let base = 26;
			if ("aAzZ019".includes(first)) base = 4;
			else if (kind === 0) base = 10;
			if (delta < 0) base *= 2;
			out.push({ i, j, reason: "sequence", log: Math.log10(base * len) });
		}
		i = j;
	}
}

function boards(): Board[] {
	if (boardsCache) return boardsCache;
	const build = (rows: Array<[string, number, string?]>, grid: boolean): Board => {
		const keys = new Map<string, Key>();
		let starts = 0;
		rows.forEach(([plain, offset, shifted], r) => {
			Array.from(plain).forEach((c, k) => {
				keys.set(c, { r, x: offset + k, shift: false });
				const s = shifted?.[k];
				if (s) keys.set(s, { r, x: offset + k, shift: true });
				starts++;
			});
		});
		const board: Board = { keys, grid, starts, degree: 0 };
		let links = 0;
		for (const [c, a] of keys) {
			if (a.shift) continue;
			for (const [d, b] of keys) if (!b.shift && c !== d && direction(board, a, b)) links++;
		}
		board.degree = links / starts;
		return board;
	};
	boardsCache = [
		build(
			[
				["`1234567890-=", 0.5, "~!@#$%^&*()_+"],
				["qwertyuiop[]\\", 2, "QWERTYUIOP{}|"],
				["asdfghjkl;'", 2.25, 'ASDFGHJKL:"'],
				["zxcvbnm,./", 2.75, "ZXCVBNM<>?"],
			],
			false,
		),
		build(
			[
				["/*-", 1],
				["789+", 0],
				["456", 0],
				["123", 0],
				["0.", 0.5],
			],
			true,
		),
	];
	return boardsCache;
}

/** "" when the two keys are not neighbours, else a label of the direction from a to b. */
function direction(board: Board, a: Key, b: Key): string {
	const dy = b.r - a.r;
	const dx = b.x - a.x;
	if (dy === 0) return Math.abs(dx) === 1 ? `0${Math.sign(dx)}` : "";
	if (Math.abs(dy) !== 1) return "";
	const near = board.grid ? Math.abs(dx) <= 1 : Math.abs(dx) < 1;
	return near ? `${dy}${Math.sign(dx)}` : "";
}

function keyboardMatches(chars: string[], out: Match[]): void {
	const n = chars.length;
	for (const board of boards()) {
		let i = 0;
		while (i < n - 1) {
			let prev = board.keys.get(chars[i] as string);
			let j = i + 1;
			let turns = 0;
			let last = "";
			let shifted = prev?.shift ? 1 : 0;
			while (prev && j < n) {
				const cur = board.keys.get(chars[j] as string);
				const dir = cur ? direction(board, prev, cur) : "";
				if (!cur || !dir) break;
				if (dir !== last) {
					turns++;
					last = dir;
				}
				if (cur.shift) shifted++;
				prev = cur;
				j++;
			}
			if (j - i >= 3) out.push({ i, j: j - 1, reason: "keyboard", log: spatialLog(j - i, turns, shifted, board) });
			i = prev ? j : i + 1;
		}
	}
}

function spatialLog(len: number, turns: number, shifted: number, board: Board): number {
	let g = 0;
	for (let i = 2; i <= len; i++) {
		const t = Math.min(turns, i - 1);
		for (let j = 1; j <= t; j++) g += binom(i - 1, j - 1) * board.starts * board.degree ** j;
	}
	if (shifted > 0) {
		const unshifted = len - shifted;
		g *= unshifted === 0 ? 2 : sumBinom(len, Math.min(shifted, unshifted));
	}
	return Math.log10(Math.max(g, 1));
}

/** The year of a day/month/year triple in some order, or undefined when no order makes a date. */
function dateYear(parts: [string, string, string]): number | undefined {
	const [a, b, c] = parts.map(Number) as [number, number, number];
	const year = (v: number, digits: number): number | undefined => {
		if (digits === 4) return v >= 1000 && v <= 2050 ? v : undefined;
		if (digits === 2) return v < 50 ? 2000 + v : 1900 + v;
		return undefined;
	};
	const dm = (x: number, y: number) =>
		(x >= 1 && x <= 31 && y >= 1 && y <= 12) || (y >= 1 && y <= 31 && x >= 1 && x <= 12);
	const options: number[] = [];
	const last = year(c, parts[2].length);
	if (last !== undefined && dm(a, b)) options.push(last);
	const first = year(a, parts[0].length);
	if (first !== undefined && dm(b, c)) options.push(first);
	if (options.length === 0) return undefined;
	return options.reduce((x, y) => (Math.abs(x - REFERENCE_YEAR) <= Math.abs(y - REFERENCE_YEAR) ? x : y));
}

function dateMatches(chars: string[], kinds: Uint8Array, out: Match[]): void {
	const n = chars.length;
	const yearSpace = (y: number) => Math.max(Math.abs(y - REFERENCE_YEAR), 20);
	for (let i = 0; i < n; i++) {
		if (kinds[i] !== 0) continue;
		for (let len = 4; len <= 10 && i + len <= n; len++) {
			const token = chars.slice(i, i + len).join("");
			if (len === 4 && /^(19|20)\d\d$/.test(token)) {
				out.push({ i, j: i + 3, reason: "date", log: Math.log10(yearSpace(Number(token))) });
			}
			let year: number | undefined;
			let separated = false;
			if (len <= 8 && /^\d+$/.test(token)) {
				for (const [p, q] of DATE_SPLITS[len] ?? []) {
					const y = dateYear([token.slice(0, p), token.slice(p, q), token.slice(q)]);
					if (y !== undefined && (year === undefined || yearSpace(y) < yearSpace(year))) year = y;
				}
			} else if (len >= 6) {
				const m = /^(\d{1,4})([\s/\\_.-])(\d{1,4})\2(\d{1,4})$/.exec(token);
				if (m) {
					year = dateYear([m[1] as string, m[3] as string, m[4] as string]);
					separated = true;
				}
			}
			if (year !== undefined) {
				out.push({ i, j: i + len - 1, reason: "date", log: Math.log10(yearSpace(year) * 365 * (separated ? 4 : 1)) });
			}
		}
	}
}

function repeatMatches(chars: string[], out: Match[]): void {
	const n = chars.length;
	const same = (a: number, b: number, len: number) => {
		for (let k = 0; k < len; k++) if (chars[a + k] !== chars[b + k]) return false;
		return true;
	};
	let i = 0;
	while (i < n - 1) {
		let bestB = 0;
		let bestC = 0;
		for (let b = 1; b * 2 <= n - i; b++) {
			let c = 1;
			while (i + (c + 1) * b <= n && same(i, i + c * b, b)) c++;
			if (c >= 2 && b * c > bestB * bestC) {
				bestB = b;
				bestC = c;
			}
		}
		if (bestC >= 2 && bestB * bestC >= 3) {
			const cover = bestB * bestC;
			const base = analyze(chars.slice(i, i + bestB));
			out.push({ i, j: i + cover - 1, reason: "repeat", log: base.log + Math.log10(bestC) });
			i += cover;
		} else {
			i++;
		}
	}
}

/** log10 of the brute-force cost of a span with these character counts. */
function bruteLog(mask: number, ascii: number, wide: number, ideographs: number): number {
	if (!bruteLogCache) {
		bruteLogCache = [];
		for (let m = 0; m < 16; m++) {
			let card = 0;
			for (let k = 0; k < 4; k++) if (m & (1 << k)) card += CARDINALITY[k] as number;
			bruteLogCache.push(Math.log10(card || 1));
		}
	}
	return ascii * (bruteLogCache[mask] as number) + wide * LOG_WIDE + ideographs * LOG_IDEOGRAPH;
}

/**
 * Drops cells that a cell with fewer matches and no more guesses beats whatever follows. A brute-force cell may be
 * beaten by any such cell; any other cell only by one that is not brute-force, because brute-force cannot follow
 * brute-force.
 */
function pruneDominated(layer: Map<number, Cell>): void {
	let minAny = Number.POSITIVE_INFINITY;
	let minOpen = Number.POSITIVE_INFINITY;
	for (const cell of [...layer.values()].sort((a, b) => a.l - b.l)) {
		if (cell.logPi >= (cell.brute ? minAny : minOpen)) layer.delete(cell.l);
		else {
			minAny = Math.min(minAny, cell.logPi);
			if (!cell.brute) minOpen = Math.min(minOpen, cell.logPi);
		}
	}
}

function offer(
	layer: Map<number, Cell>,
	l: number,
	logPi: number,
	brute: boolean,
	from: number,
	fromL: number,
	match: Match | null,
): void {
	const cur = layer.get(l);
	if (cur === undefined || logPi < cur.logPi) layer.set(l, { l, logPi, brute, from, fromL, match });
}

/** The cheapest way to cover chars with matches and brute-force spans (zxcvbn's most_guessable_match_sequence). */
function analyze(chars: string[]): Analysis {
	const n = chars.length;
	const kinds = Uint8Array.from(chars, kindOf);
	const all: Match[] = [];
	dictionaryMatches(
		chars,
		chars.map((c) => c.toLowerCase()),
		all,
	);
	sequenceMatches(chars, kinds, all);
	keyboardMatches(chars, all);
	dateMatches(chars, kinds, all);
	repeatMatches(chars, all);
	const byEnd: Match[][] = Array.from({ length: n }, () => []);
	for (const m of all) {
		// A pattern inside a longer password costs at least as much as a guess of the same shape on its own.
		if (m.j - m.i + 1 < n) m.log = Math.max(m.log, m.i === m.j ? 1 : LOG_MIN_MULTI);
		(byEnd[m.j] as Match[]).push(m);
	}
	// counts[p * 6 + kind]: characters of that kind among the first p.
	const counts = new Int32Array((n + 1) * 6);
	for (let p = 0; p < n; p++) {
		counts.copyWithin((p + 1) * 6, p * 6, p * 6 + 6);
		counts[(p + 1) * 6 + (kinds[p] as number)]++;
	}
	const isSeparator = (k: number) => SEPARATORS.includes(chars[k] as string);
	const layers: Array<Map<number, Cell>> = [
		new Map([[0, { l: 0, logPi: 0, brute: false, from: -1, fromL: 0, match: null }]]),
	];
	// A brute-force span cannot follow another one, so it only starts where some decomposition ends in a match.
	const starts = [0];
	for (let k = 0; k < n; k++) {
		const layer = new Map<number, Cell>();
		for (const m of byEnd[k] as Match[]) {
			for (const cell of (layers[m.i] as Map<number, Cell>).values()) {
				offer(layer, cell.l + 1, cell.logPi + m.log, false, m.i, cell.l, m);
			}
		}
		for (const i of starts) {
			const count = (kind: number) => (counts[(k + 1) * 6 + kind] as number) - (counts[i * 6 + kind] as number);
			let mask = 0;
			let ascii = 0;
			for (let kind = 0; kind < 4; kind++) {
				const c = count(kind);
				if (c > 0) mask |= 1 << kind;
				ascii += c;
			}
			const cost = bruteLog(mask, ascii, count(4), count(5));
			for (const cell of (layers[i] as Map<number, Cell>).values()) {
				if (!cell.brute) offer(layer, cell.l + 1, cell.logPi + cost, true, i, cell.l, null);
			}
		}
		if (k >= 1 && k <= n - 2 && isSeparator(k) && !isSeparator(k - 1) && !isSeparator(k + 1)) {
			for (const cell of (layers[k] as Map<number, Cell>).values()) {
				if (!cell.brute) offer(layer, cell.l, cell.logPi + LOG_SEPARATOR, false, k, cell.l, null);
			}
		}
		pruneDominated(layer);
		layers.push(layer);
		for (const cell of layer.values()) {
			if (!cell.brute) {
				starts.push(k + 1);
				break;
			}
		}
	}
	let bestL = 0;
	let bestLog = Number.POSITIVE_INFINITY;
	for (const cell of (layers[n] as Map<number, Cell>).values()) {
		const g = logAdd(logFact(cell.l) + cell.logPi, (cell.l - 1) * LOG_GROWTH);
		if (g < bestLog) {
			bestLog = g;
			bestL = cell.l;
		}
	}
	const matches: Match[] = [];
	for (let pos = n, l = bestL; pos > 0; ) {
		const cell = (layers[pos] as Map<number, Cell>).get(l) as Cell;
		if (cell.match) matches.push(cell.match);
		pos = cell.from;
		l = cell.fromL;
	}
	matches.reverse();
	return { log: bestLog, matches, all };
}

/** Very common passwords (leaked-list style), most common first. Walks like "qwerty" are also found by the keyboard matcher. */
const COMMON_PASSWORDS = [
	"123456 password 12345678 qwerty 123456789 12345 1234 1234567 密码 你好 我爱你 dragon 123123 baseball abc123",
	"football monkey letmein shadow master qwertyuiop 123321 mustang 1234567890 michael 654321 superman",
	"1qaz2wsx 121212 qazwsx 123qwe trustno1 jordan jennifer zxcvbnm asdfgh hunter buster soccer harley",
	"batman andrew tigger sunshine iloveyou charlie robert thomas hockey ranger daniel starwars 112233",
	"george computer michelle jessica pepper zxcvbn 11111111 131313 freedom pass maggie 159753 ginger",
	"princess joshua cheese amanda summer love ashley nicole chelsea biteme matthew access yankees",
	"987654321 dallas austin thunder taylor matrix william corvette hello martin heather secret merlin",
	"diamond 1234qwer gfhjkm hammer silver anna brandon welcome jackson passw0rd football1 qwerty123",
	"password1 password123 admin admin123 login root toor test test123 guest default changeme letmein1",
	"iloveyou1 qwerty1 abc12345 monkey1 dragon1 master1 sunshine1 princess1 welcome1 shadow1 superman1",
	"baseball1 lovely whatever 1q2w3e4r 1q2w3e 1q2w3e4r5t 1qazxsw2 q1w2e3r4 zaq12wsx qwer1234 asdf1234",
	"asdfghjkl asdfasdf qwertyui zxcvbnm1 123abc abcd1234 abcdef abcdefg abcdefgh abc123456 a1b2c3",
	"a1b2c3d4 11223344 12341234 123454321 1234554321 123456a 12345678910 password12 password2 passwords",
	"passphrase letmein123 iloveu iloveyou2 ilovegod mypassword mypass sunshine123 lovers loveme babygirl",
	"bubbles cookie flower tinkerbell snoopy samantha purple orange yellow rainbow butterfly angel angels",
	"heaven forever friends family monster cowboy cowboys eagles lakers yankee redsox warrior ninja",
	"pirate wizard knight tiger lion panther falcon phoenix viking spartan titan legend champion winner",
	"player gamer gaming master123 killer1 hunter1 shadow12 qwertyuio asdfghj zxcvbn1 qweasd qweasdzxc",
	"qweqwe qwe123 qwerty12 qwerty1234 qwerty12345 1qaz1qaz 1qaz2wsx3edc 1qazxsw23edc 2wsx3edc 3edc4rfv",
	"zaq1zaq1 zxcasd asdzxc poiuytrewq lkjhgfdsa mnbvcxz 098765 0987654321 987654 87654321 7654321 123654",
	"123456789a 123456abc 1234abcd abcd123 abc1234 abc111 aaa111 1212121212 12121212 123123123 321321",
	"321654 456456 456789 789456 789456123 147258 147258369 159357 951753 741852963 852456 963852741",
	"101010 202020 303030 696969 123789 112233445566 13579 135790 246810 24680 1357924680 1020304050",
	"10203040 102030 123457 1234567891 12345678912 123456654321 1478963 14789632 14725836 12345600",
	"0123456789 1q1q1q1q 00001111 11112222 aabbcc aabbccdd aabb1122 abcabc abab1234 lovelove love123",
	"love1234 loveyou iloveyou123 ilovehim iloveher ilovemom ilovedad iloveu2 loveyou2 lover1 lover123",
	"mylove mylife myself mypassword1 mypassword123 password01 password11 password12345 password1234",
	"passw0rd1 pa55word pa55w0rd p4ssword secret123 secret1 secrets sesame opensesame letmein2 trust123",
	"whatever1 nothing something anything everything blessed blessing jesus jesus1 god1234 godisgood",
	"godbless christ church faith hope peace happy happy123 smile smile123 sunny sunnyday sunshine12",
	"sunflower flowers rose1234 roses daisy lily jasmine violet pretty beauty lovely123 sweet sweety",
	"sweetie sweetheart honey honey123 baby baby123 babydoll babyboy girl girls boys boy123 princess123",
	"queen king kingkong prince prince123 master1234 michael1 jordan23 jordan1 jessica1 jennifer1 ashley1",
	"michelle1 amanda1 daniel1 andrew1 joshua1 matthew1 thomas1 robert1 william1 charlie1 tigger1 buster1",
	"soccer1 hockey1 harley1 ranger1 batman1 monkey12 dragon12 summer1 summer12 winter1 spring1 autumn1",
	"fall2020 january february march april june july august september october november december starwars1",
	"pokemon naruto minecraft fortnite pikachu mario zelda sonic skywalker hello123 hello1 hello12345",
	"hellohello welcome123 welcome12 welcome2 welcomeback goodluck goodbye letsgo letmeinnow trustme",
	"changeit changeme1 newpass newpass1 newpassword temp temp123 temppass tempass testing testing123",
	"tester demo demo123 sample admin1 admin12 admin1234 administrator administrator1 root123 rootroot",
	"user user123 username userpass login123 logon logmein pass123 pass1234 pass12345 pass1 qazwsxedc",
	"qazwsx123 zaqxsw 1234zxcv 1234asdf 1234qwerty 12qwaszx qwaszx 123qweasd 123qweasdzxc q1w2e3",
	"q1w2e3r4t5 qwe12345 qweqweqwe iamgod iamtheone ihateyou ilikeit ilikepie ilovepizza pizza coffee",
	"chocolate banana cherry apple orange1 lemon mango peach pepper1 burger fries candy sugar cookies",
	"muffin pancake waffle pasta",
].join(" ");

/** Common English words and names, most common first (the index is the guess rank). */
const COMMON_WORDS = [
	"the and for are but not you all any can had her was one our out day get has him his how man new now",
	"old see two way who boy did its let put say she too use that with have this will your from they know",
	"want been good much some time very when come here just like long make many more only over such take",
	"than them well were what about after again also back because before being between both came could",
	"each even every first found give going great help high home house into keep kind last left life",
	"little look made might most move must name need never next night other own part people place read",
	"right same seem should show side since small still tell their then there these thing think those",
	"three through turn under until upon water went where which while work world would write year years",
	"young hello love welcome secret password admin login master dragon monkey shadow sunshine princess",
	"football baseball soccer hockey tennis golf summer winter spring autumn fall january february march",
	"april may june july august october december monday tuesday thursday friday saturday sunday morning",
	"evening today tomorrow weekend holiday birthday easter red blue green yellow orange purple pink",
	"black white brown gray grey silver gold golden violet indigo cyan magenta crimson scarlet maroon",
	"navy teal beige ivory four five six seven eight nine ten eleven twelve twenty thirty forty fifty",
	"hundred thousand million billion zero second third half double single dog cat bird fish horse cow",
	"pig sheep goat duck chicken rabbit mouse rat bear wolf fox deer lion tiger elephant snake frog",
	"turtle spider bee ant fly eagle hawk owl parrot penguin dolphin whale shark octopus crab lobster",
	"shrimp squirrel kitten puppy pony leopard cheetah zebra giraffe camel kangaroo koala panda gorilla",
	"hippo rhino buffalo coyote beaver otter badger raccoon bat lizard dinosaur unicorn phoenix wizard",
	"witch ghost monster zombie vampire angel devil demon fairy giant dwarf elf pirate knight king queen",
	"prince lord lady sir soldier warrior hunter ranger ninja samurai viking spartan trojan roman greek",
	"egypt china japan india russia france germany spain italy canada mexico brazil america europe asia",
	"africa london paris berlin rome tokyo beijing moscow madrid dubai sydney boston chicago dallas",
	"houston miami denver seattle austin vegas orlando atlanta detroit texas florida nevada oregon",
	"arizona ohio alaska hawaii york jersey carolina virginia georgia colorado montana utah idaho kansas",
	"iowa maine vermont mother father brother sister son daughter wife husband baby child children kid",
	"kids family friend friends uncle aunt cousin grandma grandpa parents mom dad mommy daddy lover",
	"darling honey sweetie buddy partner team club group gang crew party band music song songs dance",
	"movie movies film game games play player toy toys ball card cards chess poker bingo lucky luck magic",
	"dream dreams wish hope faith trust peace freedom justice truth honor glory power strong super mega",
	"ultra hero heroes legend legends champion winner victory success happy sad angry crazy funny silly",
	"cool hot cold warm wild free fast slow quick smart clever brave bold proud sweet sour bitter spicy",
	"tasty fresh clean dirty empty full open close light dark bright shiny soft hard heavy easy simple",
	"real true false wrong best better worst bad nice fine pretty lovely handsome ugly tall short big",
	"large huge tiny round square flat sharp smooth rough thick thin wide narrow deep shallow woman men",
	"women person girl guy human body head face eye eyes ear nose mouth lip teeth tooth tongue neck",
	"shoulder arm hand finger thumb chest heart leg knee foot feet toe skin hair beard blood bone brain",
	"mind soul spirit voice breath death birth age moment minute hour week month decade century future",
	"past present room kitchen bedroom bathroom garden yard door window floor wall roof ceiling stairs",
	"table chair sofa couch bed desk lamp mirror clock picture frame carpet curtain pillow blanket shelf",
	"drawer closet box bag basket bucket bottle glass cup plate bowl spoon fork knife pan pot oven stove",
	"fridge sink bath shower toilet soap towel brush comb razor food bread butter cheese milk egg eggs",
	"meat beef pork rice pasta noodle soup salad sandwich burger pizza fries chips pie cake cookie candy",
	"sugar salt pepper jam juice coffee tea beer wine soda cola apple banana lemon lime cherry grape",
	"berry peach pear plum melon mango coconut tomato potato carrot onion garlic corn bean peas pea nut",
	"peanut almond walnut taco burrito sushi steak bacon sausage ham turkey lunch dinner snack meal feast",
	"car cars truck bus train plane jet boat ship yacht bike bicycle motor engine wheel tire road street",
	"avenue highway bridge tunnel city town village country state nation earth planet moon sun star stars",
	"sky cloud clouds rain snow wind storm thunder fire flame smoke ice frost fog mist sea ocean beach",
	"shore wave waves river lake pond creek stream island mountain hill valley canyon desert forest",
	"jungle field meadow park farm ranch cave rock stone sand dust mud clay metal iron steel copper",
	"bronze diamond crystal pearl ruby emerald sapphire opal amber coral jade tree trees leaf leaves",
	"flower flowers rose lily daisy tulip orchid grass bush plant seed root branch wood oak pine maple",
	"cedar birch willow palm bamboo cactus moss fern computer laptop phone mobile tablet screen monitor",
	"keyboard printer camera video audio radio speaker cable wire battery button switch signal web site",
	"page link email mail text chat code system server data file folder disk drive memory chip robot",
	"cyber online upload update start stop pause record save load reset backup delete search find click",
	"scroll type enter escape shift space tab school class doctor nurse lawyer judge police pilot driver",
	"farmer baker cook chef waiter writer author poet artist singer actor dancer coach boss worker clerk",
	"banker trader dealer agent book books paper pen pencil ink letter note notes story poem novel diary",
	"news math art french german word words number names title topic idea ideas plan plans goal goals",
	"task job career market money cash coin price cost sale bank credit debt tax wealth rich poor sport",
	"sports score win lose draw match race run runner walk jump swim dive climb ride skate ski surf hunt",
	"shoot throw catch kick punch fight boxing karate rugby talk speak ask answer call shout cry laugh",
	"smile sing hear listen watch feel touch smell taste eat drink sleep wake learn teach study paint",
	"build create design fix break cut push pull lift carry hold drop send bring buy sell pay trade leave",
	"stay arrive return exit begin end finish wait hurry rest hurt heal kill live die born grow change",
	"shake wash bake mix pour fill north south east west down front top bottom middle center inside above",
	"below near far upward james john robert david joseph thomas mary linda susan sarah karen daniel mark",
	"donald steven paul andrew joshua kevin brian george edward ronald jason ryan jacob gary eric larry",
	"justin scott samuel frank jack dennis jerry tyler aaron henry adam nathan peter kyle walter harold",
	"carl arthur gerald roger keith jeremy terry sean albert joe ethan jesse willie billy bryan bruce",
	"jordan ralph roy noah dylan eugene wayne alan juan louis randy philip harry bobby johnny logan nancy",
	"lisa betty sandra ashley emily donna carol amanda laura sharon amy angela helen anna brenda pamela",
	"nicole emma rachel janet ruth maria diane julie joyce olivia kelly lauren joan evelyn judith megan",
	"cheryl andrea hannah martha gloria teresa sara janice jean alice doris julia judy grace denise",
	"sophia marie diana alexis kayla chris matt dave steve tom jim bob tim ben sam max alex nick dan andy",
	"tony kate katie jenny jessie sally molly polly lucy chloe zoe mia ella ava luna nina rita rosa tina",
	"tracy wendy always often maybe almost enough quite rather really slowly alone apart away around",
	"along across among beside behind beyond during except toward within crypto google amazon linux",
	"ubuntu iphone sony xbox steam naruto marvel disney batman hulk thor joker avatar matrix rocky alpha",
	"beta gamma delta omega sigma theta zeta lambda orion apollo atlas zeus odin venus mars saturn pluto",
	"uranus galaxy cosmos nova comet meteor orbit rocket troubadour troubador hotel",
].join(" ");

/** Easy-to-spell words for suggestPassphrase: sorted, 4-8 lowercase letters, none a prefix of or one edit from another. */
const PASSPHRASE_WORDS = [
	"acorn acre alder almond alpine amber anchor anvil apex apple apricot apron archer arena aroma arrow",
	"artist aspen aster atlas atom autumn avocado azure badge bagel bagpipe baker balloon bamboo banana",
	"banjo banner barber barley basil basket bayou beacon beaver beetle bench berry berth bicycle biplane",
	"biscuit bishop blade blizzard bloom blossom bluebell bobcat bobsled bolt bonnet bonus boots border",
	"bottle boulder bounty brambles branch brass breeze briar brick bridge brook brush bubble bucket",
	"buckle buffalo bugle burrow bushel butter button cabana cabbage cabin cadet cairn calico camel",
	"camera candle candor canopy canvas canyon capsule carafe caramel cardinal carousel carpet carrot",
	"carton cashew cashier casino cavern cedar celery cellar chapel cheddar cheetah cherub chess chicken",
	"chimney chisel chorus chowder cinema circle cistern citron citrus clay cleat clock cloud clover",
	"coaster cobalt cobbler cobweb coconut cocoon coffee column comb comet compass copper copse coral",
	"cork cornet cottage cotton cradle crane crater crayon creamy creek crest crouton crowbar crown",
	"crystal cuckoo cucumber curlew cymbal cypress daffodil dagger dahlia daisy dancer decoy desert",
	"dewdrop diamond dill dinghy dingo dock dolphin domino donkey dormouse dory drake drum duffel dune",
	"dusk dynamo eagle earthen eclipse egret elbow emerald engine epoch ermine fable fabric fairway",
	"falcon faucet feather fender fern ferret fiddle field fiesta figure finale firefly fjord flagon",
	"flame flamingo flannel flask fleece flint florin flower fluffy flute foal forest forge fortress",
	"fossil fountain foxglove fresco fudge gadget gaiter galaxy gallop garage garden garnet gazelle gecko",
	"gentle gerbil geyser ginger giraffe gizmo glacier glen glider glove gnome goldfish gondola goose",
	"gopher gosling gourd granite gravel gravity grotto guitar gull gumdrop haddock hammer hammock",
	"hamster harbor harness harp harvest hawk haystack hazel hearth hedge heirloom helmet hermit heron",
	"hickory hinge hippo hobby hollow honey horizon hotel hound hunter husky hutch icing igloo iguana",
	"indigo inkwell inlet iris ivory jackal jacket jaguar jasmine jasper jelly jetty jewel jigsaw jockey",
	"journal jukebox jungle kangaroo kayak kelp kernel kestrel kettle kiln kitten kiwi knapsack knight",
	"knoll koala lacewing lagoon lamp lantern larch lariat lasso lathe lavender lawn ledger lemon lemur",
	"lentil leopard library lichen lilac lily limbo linen lintel llama loaf lobster lodestar lodge",
	"lollipop lotus lunar lupine lynx macaw mackerel magnet magpie mammoth manatee mango mantis mantle",
	"maple marble maroon marsh mascot mason meadow medal mellow merlin mesa mesquite meteor millet mink",
	"minnow mist mocha mohair mortar mosaic moth muffin mulch mule muskrat mustard myrtle nacho napkin",
	"needle nickel nimbus nomad noodle nugget nutmeg oatmeal oboe ocean octopus olive onion onyx orange",
	"orbit orchard orchid oriole osprey ostrich outback outpost oven oxbow oyster paddle palace panther",
	"pantry papaya paper paprika parade parlor pasta pasture patio pavilion peach peacock peanut pebble",
	"pelican peony pepper pewter pheasant piano picnic pigeon pilgrim pillow pilot pinecone pinto pixel",
	"plaid planet plank plateau plow pluck pocket polka pollen poncho pond poppy porch porridge portal",
	"potato pottery prairie pretzel prism puma pumpkin puzzle pylon quail quartz quest quince quiver",
	"rabbit raccoon radar radish rafter raisin rambler rapids rattle raven ravine reef relic rhubarb",
	"ribbon ripple river robin rodeo rosemary rotor rowan rowboat ruby rudder rustic sachet saffron sage",
	"sailor salad salmon salsa sandbar sapling sapphire sardine satin sawmill scallop scone scooter",
	"scroll seabird seagull seashell shale shamrock shelf shovel shrub shuttle sierra signal sinew sketch",
	"skillet skylark slate sled slipper sloth smelt snipe snorkel snowman sofa sorbet spaniel sparrow",
	"spatula spider sponge spool sprint spruce squirrel stable starling stencil stew stirrup stork",
	"sturgeon summit sundae sundial sunrise sunset swallow swan sweater syrup tablet tadpole tarot teacup",
	"teal teapot tepee terrace thimble thistle thunder thyme ticket tiger timber tinsel toast tomato",
	"tonic topaz tornado tortoise toucan tractor trapeze trawler trellis trophy trout trowel trumpet",
	"tulle tumble tundra tunnel turbine turnip turret tuxedo twig ukulele umbrella unicorn utensil vacuum",
	"vanilla velcro vellum velvet verbena vessel village violin vista vole vortex voyage waffle wagon",
	"walker walnut walrus wander wapiti warbler warren watch wetland wharf wheat whippet whisk wicker",
	"wildcat windmill window windsock winter wombat woodland yarn yogurt yonder zebra zenith zephyr",
	"zipper",
];
