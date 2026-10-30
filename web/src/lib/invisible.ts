/**
 * Characters that change what text looks like, or that do not look like anything, shown as what they are. A tool approval
 * is the one place a person decides on text they read: a right-to-left override (U+202E) makes `echo ok ;tnatropmi/~ fr- mr`
 * read as `echo ok rm -rf ~/important;`, and zero-width characters, escapes and no-break spaces make two commands that
 * look the same different. Everything that is not a plain letter, digit, symbol, space, tab or line break becomes a marker.
 */

/** Controls and format characters (bidi, zero-width, joiners, BOM, tags), line and paragraph separators, spaces other than U+0020, variation selectors. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]|[\u180B-\u180D]|[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/gu;

/** The names people know the common ones by. */
const NAMES: Record<number, string> = {
	0: "NUL",
	7: "BEL",
	8: "BS",
	11: "VT",
	12: "FF",
	13: "CR",
	27: "ESC",
	127: "DEL",
	133: "NEL",
	160: "NBSP",
	173: "SHY",
	1564: "ALM",
	6158: "MVS",
	8232: "LS",
	8233: "PS",
	8203: "ZWSP",
	8204: "ZWNJ",
	8205: "ZWJ",
	8206: "LRM",
	8207: "RLM",
	8234: "LRE",
	8235: "RLE",
	8236: "PDF",
	8237: "LRO",
	8238: "RLO",
	8239: "NNBSP",
	8288: "WJ",
	8294: "LRI",
	8295: "RLI",
	8296: "FSI",
	8297: "PDI",
	65279: "BOM",
};

/** A piece of text: plain, or one invisible character. */
export type Piece = string | { code: number };

/** `U+202E`, as the Unicode notation writes it. */
export const codePoint = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

/** The marker of one character: its code point, and its name where there is one. */
export function marker(code: number): string {
	const name = Object.hasOwn(NAMES, code) ? NAMES[code] : undefined;
	return `⟨${codePoint(code)}${name ? ` ${name}` : ""}⟩`;
}

/** `text` in plain pieces and invisible characters. A space, a tab and a line break are text. */
export function pieces(text: string): Piece[] {
	const out: Piece[] = [];
	let from = 0;
	for (const match of text.matchAll(INVISIBLE)) {
		const char = match[0];
		if (char === " " || char === "\t" || char === "\n") continue;
		const at = match.index;
		if (at > from) out.push(text.slice(from, at));
		out.push({ code: char.codePointAt(0) ?? 0 });
		from = at + char.length;
	}
	if (from < text.length) out.push(text.slice(from));
	return out;
}

/** `text` with each invisible character written out, for places that take a string (a label, an announcement). */
export function revealed(text: string): string {
	return pieces(text)
		.map((p) => (typeof p === "string" ? p : marker(p.code)))
		.join("");
}
