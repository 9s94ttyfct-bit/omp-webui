/**
 * The front matter of a Markdown file: the YAML block between a first line `---` and the next `---` (or `...`), which
 * static-site generators, notes apps and agents' skill files put on top. The Markdown editor (`components/md/`) shows it as a
 * compact table of its top-level keys instead of as text, and renders the rest as Markdown.
 *
 * This is not a YAML parser, by choice: the table names each top-level key and what it holds, in a form a person reads. A
 * plain value is shown without its quotes; a list (`[a, b]` or `- a` lines) as its items joined by commas; anything else
 * (a nested map, a block scalar `|` or `>`) as its lines, as written. Nothing of it is evaluated (no tags, no anchors).
 */

export interface FrontMatterRow {
	key: string;
	value: string;
}

export interface FrontMatter {
	/** The rows of the table, in the order the keys are written; null when the text has no front matter. */
	rows: FrontMatterRow[] | null;
	/** The text after the front matter (the whole text when there is none). */
	body: string;
	/** The lines the front matter takes, its two fences included (0 when there is none). */
	lines: number;
}

const OPEN = /^---[ \t]*$/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
/** A top-level key: not indented, not a list item or a comment; the value is what follows the colon. */
const KEY = /^([^\s#-][^:]*?|"[^"]*"|'[^']*'):(?:[ \t]+(.*))?$/;

/** A scalar as a person reads it: quotes taken off, a trailing comment dropped. */
function scalar(raw: string): string {
	const text = raw.trim();
	if (text.length >= 2 && ((text[0] === '"' && text.endsWith('"')) || (text[0] === "'" && text.endsWith("'")))) {
		const inner = text.slice(1, -1);
		return text[0] === "'" ? inner.replaceAll("''", "'") : inner.replace(/\\(["\\])/g, "$1");
	}
	// ` #` starts a comment outside quotes.
	const comment = text.search(/\s#/);
	return (comment < 0 ? text : text.slice(0, comment)).trim();
}

/** `[a, "b", c]` as `a, b, c`. */
function flowList(raw: string): string {
	return raw
		.trim()
		.slice(1, -1)
		.split(",")
		.map(scalar)
		.filter((item) => item !== "")
		.join(", ");
}

function valueText(inline: string, block: string[]): string {
	const first = inline.trim();
	if (first !== "" && !/^[|>][+-]?\d*$/.test(first) && !(first.startsWith("&") || first.startsWith("!"))) {
		return first.startsWith("[") && first.endsWith("]") ? flowList(first) : scalar(first);
	}
	const lines = block.filter((line) => line.trim() !== "");
	if (lines.length > 0 && lines.every((line) => /^\s*-(?:\s|$)/.test(line))) {
		return lines.map((line) => scalar(line.replace(/^\s*-\s?/, ""))).join(", ");
	}
	// A nested map or a block scalar: its lines as they are written, without the indentation they share.
	const indent = Math.min(...lines.map((line) => line.length - line.trimStart().length));
	return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
}

/** The front matter of `text`, if it begins with one; otherwise no rows and the whole text as the body. */
export function splitFrontMatter(text: string): FrontMatter {
	const none: FrontMatter = { rows: null, body: text, lines: 0 };
	// A byte order mark may come before the fence.
	const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	const all = text.slice(start).split(/\r?\n/);
	if (all.length < 2 || !OPEN.test(all[0] ?? "")) return none;
	const end = all.findIndex((line, i) => i > 0 && CLOSE.test(line));
	if (end < 0) return none;
	const inner = all.slice(1, end);
	const keys: { key: string; inline: string; block: string[] }[] = [];
	for (const line of inner) {
		const last = keys.at(-1);
		if (/^\s*#/.test(line) && last === undefined) continue;
		const m = /^\S/.test(line) ? KEY.exec(line) : null;
		if (m) keys.push({ key: scalar(m[1] ?? ""), inline: m[2] ?? "", block: [] });
		else last?.block.push(line);
	}
	// What the fences hold is not front matter of keys (a horizontal rule and a paragraph, say): the text is Markdown.
	if (keys.length === 0 && inner.some((line) => line.trim() !== "")) return none;
	const rows = keys.map(({ key, inline, block }) => ({ key, value: valueText(inline, block) }));
	// The body starts after the line break that ends the closing fence (a file may end with the fence and no break).
	let offset = text.length;
	let seen = 0;
	for (const br of text.slice(start).matchAll(/\r?\n/g)) {
		if (seen++ === end) {
			offset = start + br.index + br[0].length;
			break;
		}
	}
	return { rows, body: text.slice(offset), lines: end + 1 };
}
