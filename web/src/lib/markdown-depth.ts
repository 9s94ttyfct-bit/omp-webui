/**
 * How deeply a text nests, found before it is parsed. react-markdown converts the tree by recursion, so a reply (or a
 * summary, or a note) of a thousand `> ` or `- ` markers overflowed the stack: the page showed its Reload screen, and in
 * Chrome some 1,800 nested quotes crashed the whole renderer, again on every reload, because the text stays in the
 * conversation. Parsing such text is no better: nested lists, and image labels opened inside one another (`![a ![a ![a`),
 * take time that grows with the square of their depth (10 KB of `- ` took seconds, 13 KB of `![a ` ran the tab for more
 * than five). No text anyone writes nests anywhere near this: deeper than this is shown as it is written.
 */
export const MAX_NESTING = 100;

export interface Nesting {
	/** The text scanned. */
	text: string;
	/** Where the last line of it begins: a line that is still being written is read again from there. */
	resume: number;
	/** The deepest any line of it can nest, in block quotes and list items, or in link and image labels left open. */
	deepest: number;
	/** The code fence the text is inside at `resume` (its character and length), or null. */
	fence: { char: string; length: number } | null;
	/** Link and image labels open at `resume`: they are opened and closed within a paragraph. */
	open: number;
}

const SPACE = 32;
const TAB = 9;
const GT = 62;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const BACKSLASH = 92;
const CARET = 94;

const isBlank = (c: number) => c === SPACE || c === TAB;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isListMark = (c: number) => c === 45 || c === 42 || c === 43;

/**
 * An upper bound of the depth the line `text[from, to)` opens: a block quote or a list item (or a footnote definition) needs
 * a marker in front of its content, and a list item nested by indentation needs at least two columns of indent before its
 * marker. A line with no marker (a paragraph, a code line, however far indented) opens nothing; it only continues what is
 * open.
 */
function lineDepth(text: string, from: number, to: number): number {
	let markers = 0;
	let indent = 0;
	for (let i = from; i < to; i++) {
		const c = text.charCodeAt(i);
		if (c === SPACE) {
			if (markers === 0) indent++;
		} else if (c === TAB) {
			if (markers === 0) indent += 4;
		} else if (c === GT) markers++;
		else if (isListMark(c) && (i + 1 === to || isBlank(text.charCodeAt(i + 1)))) markers++;
		else if (isDigit(c)) {
			let j = i;
			while (j < to && isDigit(text.charCodeAt(j))) j++;
			const end = text.charCodeAt(j);
			if (j >= to || (end !== 46 && end !== 41) || (j + 1 < to && !isBlank(text.charCodeAt(j + 1)))) break;
			markers++;
			i = j;
		} else if (c === OPEN_BRACKET && text.charCodeAt(i + 1) === CARET) {
			// `[^note]: ` holds blocks, and its text can start on the same line.
			const close = text.indexOf("]:", i);
			if (close < 0 || close >= to || /\s/.test(text.slice(i, close))) break;
			markers++;
			i = close + 1;
		} else break;
	}
	return markers === 0 ? 0 : markers + (indent >> 1);
}

/** A code fence opened (`char`, at least `length` of it) or closed by the line `text[from, to)`; null when it is neither. */
function fenceOf(text: string, from: number, to: number): { char: string; length: number } | null {
	let i = from;
	while (i < to && i < from + 4 && text.charCodeAt(i) === SPACE) i++;
	if (i - from > 3) return null;
	const char = text[i];
	if (char !== "`" && char !== "~") return null;
	let length = 0;
	while (i + length < to && text[i + length] === char) length++;
	return length >= 3 ? { char, length } : null;
}

/** How the link and image labels of the line `text[from, to)` leave `open`; `deepest` is the most that were open at once. */
function labelDepth(text: string, from: number, to: number, open: number): { open: number; deepest: number } {
	let deepest = open;
	for (let i = from; i < to; i++) {
		const c = text.charCodeAt(i);
		if (c === BACKSLASH) i++;
		else if (c === OPEN_BRACKET) {
			open++;
			if (open > deepest) deepest = open;
		} else if (c === CLOSE_BRACKET && open > 0) open--;
	}
	return { open, deepest };
}

/**
 * Scan `text` for how deeply it nests. `prev` is the result for the text before it: text that grows at its end (a streaming
 * reply) is read again only from its last line.
 */
export function scanNesting(text: string, prev?: Nesting): Nesting {
	if (prev?.text === text) return prev;
	const grown = prev !== undefined && text.startsWith(prev.text);
	let deepest = grown ? prev.deepest : 0;
	let start = grown ? prev.resume : 0;
	let fence = grown ? prev.fence : null;
	let open = grown ? prev.open : 0;
	let resume = start;
	let fenceAtResume = fence;
	let openAtResume = open;
	while (start <= text.length) {
		resume = start;
		fenceAtResume = fence;
		openAtResume = open;
		let end = start;
		let blank = true;
		while (end < text.length) {
			const c = text.charCodeAt(end);
			if (c === 10 || c === 13) break;
			if (!isBlank(c)) blank = false;
			end++;
		}
		const marked = fenceOf(text, start, end);
		if (fence) {
			// Inside a fence everything is code, until a line of the same fence character at least as long ends it.
			if (
				marked &&
				marked.char === fence.char &&
				marked.length >= fence.length &&
				text.slice(start, end).trim().length === marked.length
			)
				fence = null;
		} else if (marked) {
			fence = marked;
			open = 0;
		} else if (blank) {
			open = 0;
		} else {
			const depth = lineDepth(text, start, end);
			if (depth > deepest) deepest = depth;
			const labels = labelDepth(text, start, end, open);
			open = labels.open;
			if (labels.deepest > deepest) deepest = labels.deepest;
		}
		if (end >= text.length) break;
		// CRLF is one line break.
		start = text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10 ? end + 2 : end + 1;
	}
	return { text, resume, deepest, fence: fenceAtResume, open: openAtResume };
}

/** Whether `text` nests deeper than it is rendered. */
export const nestsTooDeep = (nesting: Nesting): boolean => nesting.deepest > MAX_NESTING;
