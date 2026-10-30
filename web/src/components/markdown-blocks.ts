import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * A streaming answer is Markdown that only ever grows at its end. Rendering it whole re-parses everything already
 * written for each token (micromark takes ~18 ms for 45 KB), so the text is cut into top-level blocks instead: a block
 * that has a successor cannot change any more, renders once and is skipped by `React.memo` from then on. Only the
 * last block is parsed again per update.
 */

/** Text shorter than this is one block: it re-renders in well under a millisecond, and most messages are this short. */
export const SPLIT_MIN_CHARS = 1200;

/** A streaming list, table or block quote is cut into chunks of about this many characters: a chunk that has a successor renders once. */
const CHUNK_CHARS = 1024;

/** A list, table or block quote shorter than this is one block: it has no chunk worth keeping. */
const GROUP_MIN_CHARS = 2 * CHUNK_CHARS;

/** The parser the page renders with (react-markdown's own pipeline: remark-parse and remark-gfm), used here only for block boundaries. */
const parser = unified().use(remarkParse).use(remarkGfm).freeze();

/** What the splitter has done: lets a test (and a benchmark) see that a long answer is not parsed from the top each time. */
export const splitStats = { parses: 0, parsedChars: 0 };

interface MdNode {
	type: string;
	children?: MdNode[];
	position?: { start: { offset?: number } };
	ordered?: boolean | null;
	start?: number | null;
	spread?: boolean | null;
	checked?: boolean | null;
}

/**
 * A list, table or block quote is one top-level node however long it is, so while it streams it would be parsed and
 * rendered whole for every token. It is cut into chunks of its children instead (list items, table rows, the blocks
 * of a quote): the page renders the element itself and puts the chunks that are complete into it as they were, once.
 */
export interface Group {
	/** The element the text is: `ul`/`ol` (a list), `table` or `blockquote`. */
	tag: "ul" | "ol" | "table" | "blockquote";
	/** The number an ordered list begins with, when it is not 1. */
	start?: number;
	/** An item of the list has a checkbox: the element carries a class for it. */
	task: boolean;
	/** Two items of the list, or two blocks of an item, are apart by a blank line: every item renders its text as paragraphs. */
	loose: boolean;
	/** A table's header row and delimiter row, which come before the first chunk and are read with every chunk of rows. */
	head: string;
	/** The children after `head`, cut in chunks. Joined with `head` they are the text of the block; all but the last cannot change any more. */
	chunks: string[];
}

/** A top-level block: Markdown text, or a long list, table or quote cut into chunks. */
export type Block = string | Group;

export interface Blocks {
	/** The text these blocks were cut from. */
	text: string;
	/** Top-level blocks in order; joined they are `text`. Between two of them the page renders the newline react-markdown puts between top-level nodes. */
	blocks: Block[];
	/** How many leading blocks cannot change while `text` only grows at its end. */
	frozen: number;
	/** Characters before the unfrozen part of the last block: where the next parse starts. */
	frozenChars: number;
	/** `blocks` came from parsing (it is not just short text) and can be built upon. */
	parsed: boolean;
	/** How long `text` was when it was last parsed: what came in after that may hold a block the blocks do not know of yet. */
	parsedLen: number;
	/**
	 * The text defines a link or a footnote. Those apply to the whole document, so a block before the definition (or the
	 * one holding it) cannot be rendered on its own: the text stays one block.
	 */
	whole: boolean;
}

const whole = (text: string): Blocks => ({
	text,
	blocks: [text],
	frozen: 0,
	frozenChars: 0,
	parsed: true,
	parsedLen: text.length,
	whole: true,
});

/** A definition (`[x]: url`, `[^1]: note`) anywhere in the tree, in a quote or a list item too. */
function defines(nodes: MdNode[]): boolean {
	const stack = [...nodes];
	for (let n = stack.pop(); n; n = stack.pop()) {
		if (n.type === "definition" || n.type === "footnoteDefinition") return true;
		if (n.children) stack.push(...n.children);
	}
	return false;
}

/** Where the line holding `offset` begins (CR, LF and CRLF all end a line, as in micromark). */
function lineStart(text: string, offset: number): number {
	let i = offset;
	while (i > 0) {
		const c = text.charCodeAt(i - 1);
		if (c === 10 || c === 13) break;
		i--;
	}
	return i;
}

/** True when `text` has a line break at or after `from`. */
function breaksAfter(text: string, from: number): boolean {
	return text.indexOf("\n", from) >= 0 || text.indexOf("\r", from) >= 0;
}

const blankLine = /(?:^|[\n\r])[ \t]*[\n\r]/;

/**
 * Whether a blank line is in the text from the line `since` falls in on, or ends the text before `since`: the places a
 * list can become loose. A blank line apart two items makes every item of the list render as paragraphs, so the chunks
 * that were rendered before have to follow.
 */
function blankArrived(text: string, since: number): boolean {
	const line = lineStart(text, since);
	if (blankLine.test(text.slice(line))) return true;
	// What ends the text so far is a blank line, and the line after it has begun.
	if (text.length === since || line === 0 || text.slice(line, since).trim() !== "") return false;
	let end = line - 1;
	if (text.charCodeAt(end) === 10 && text.charCodeAt(end - 1) === 13) end--;
	return text.slice(lineStart(text, end), end).trim() === "";
}

/** Characters that must come in before the unfrozen text is parsed again (or a quarter of it, if that is more). */
const REPARSE_MIN_CHARS = 256;

/**
 * Whether `text`, grown from the text `kept` was cut from, is worth parsing again. Not parsing is always correct: the
 * last block is rendered from all the text after the frozen blocks, as the whole text renders it; it only delays
 * freezing the blocks that have ended since. So a parse waits for a line break (a block starts on a line of its own)
 * and for a quarter of the unfrozen text to have come in (a block thousands of lines long is not parsed again with
 * every line) unless a definition may have arrived, which changes the blocks before it; or the list the last block
 * cuts into chunks may have become loose, which changes how the chunks before it render.
 */
function worthParsing(text: string, kept: Blocks): boolean {
	const since = kept.parsedLen;
	// `]:` in what came in, or in the line it is still adding to: `[x]: url` is a definition the moment `url` has a character.
	if (text.indexOf("]:", Math.min(Math.max(0, since - 1), lineStart(text, text.length))) >= 0) return true;
	const last = kept.blocks[kept.frozen];
	if (
		typeof last === "object" &&
		last.loose === false &&
		(last.tag === "ul" || last.tag === "ol") &&
		blankArrived(text, since)
	)
		return true;
	return (
		text.length - since >= Math.max(REPARSE_MIN_CHARS, (since - kept.frozenChars) >> 2) && breaksAfter(text, since)
	);
}

/** The element a top-level node is when it is cut into chunks, if it is one that can be. */
function tagOf(node: MdNode | undefined): Group["tag"] | undefined {
	if (node?.type === "list") return node.ordered ? "ol" : "ul";
	if (node?.type === "table") return "table";
	if (node?.type === "blockquote") return "blockquote";
	return undefined;
}

/** An item of the list is a task: it has a checkbox. */
const hasTask = (node: MdNode): boolean =>
	node.type === "list" && !!node.children?.some((item) => typeof item.checked === "boolean");

/** mdast-util-to-hast's rule for a loose list: the list is spread, or an item is (an item of unknown spread is when it holds more than one block). */
const isLoose = (node: MdNode): boolean =>
	node.type === "list" &&
	(node.spread === true || !!node.children?.some((item) => item.spread ?? (item.children?.length ?? 0) > 1));

/**
 * The chunks the children of `node` (the text from `base` to `to` of `tail`) are cut in: a chunk ends where a child
 * begins once it has grown to `CHUNK_CHARS`. The last chunk is what remains, so there is always one, and it holds the
 * last child: a child is not complete before another follows it. A table's first child is its header row, and its first
 * row of the body begins the first chunk.
 */
function chunksOf(node: MdNode, tail: string, base: number, to: number): string[] {
	const chunks: string[] = [];
	let at = base;
	for (const child of node.children?.slice(node.type === "table" ? 2 : 1) ?? []) {
		const offset = child.position?.start.offset;
		if (offset === undefined) continue;
		const next = lineStart(tail, offset);
		if (next - at < CHUNK_CHARS) continue;
		chunks.push(tail.slice(at, next));
		at = next;
	}
	chunks.push(tail.slice(at, to));
	return chunks;
}

/** `node`, the top-level node that is the text of `tail` from `from` to `to`, as a group, when it is long enough to have complete chunks. */
function startGroup(node: MdNode | undefined, tail: string, from: number, to: number): Group | undefined {
	const tag = tagOf(node);
	if (!node || !tag) return undefined;
	let base = from;
	if (tag === "table") {
		const row = node.children?.[1]?.position?.start.offset;
		if (row === undefined) return undefined;
		base = lineStart(tail, row);
	}
	const chunks = chunksOf(node, tail, base, to);
	if (chunks.length < 2) return undefined;
	return {
		tag,
		start: tag === "ol" && typeof node.start === "number" && node.start !== 1 ? node.start : undefined,
		task: hasTask(node),
		loose: isLoose(node),
		head: tail.slice(from, base),
		chunks,
	};
}

/** The group `open` went on being, as `node`, the node `tail` begins with after its head, says. */
function growGroup(open: Group, node: MdNode, tail: string, to: number): Group {
	return {
		...open,
		task: open.task || hasTask(node),
		loose: open.loose || isLoose(node),
		chunks: [...open.chunks.slice(0, -1), ...chunksOf(node, tail, open.head.length, to)],
	};
}

/**
 * Cut `text` into top-level blocks. `prev` is the result for the text before it: text that extends it is streaming, and
 * its blocks that were frozen are kept while only the rest is parsed again. Text that does not extend `prev`, or has no
 * `prev` (a finished message being shown, which is never parsed twice), is one block until it grows.
 *
 * A block is frozen once a block follows it. A later line cannot change an earlier block: a block ends where the next
 * one begins, and a line's role depends on the lines before it, never on those after the block it belongs to. The
 * exceptions are definitions (links and footnotes apply to the whole text), which `Blocks.whole` handles, and the
 * looseness of a list, which `Group.loose` follows.
 *
 * A long list, table or quote that is the last block is cut again, in chunks of its children, by the same rule: the
 * chunks before the last cannot change, and the next parse starts at the last one (a table's rows are read after its
 * head, the header and delimiter rows that began it).
 */
export function splitBlocks(text: string, prev?: Blocks): Blocks {
	if (prev?.text === text) return prev;
	const base = prev && text.startsWith(prev.text) ? prev : undefined;
	if (!base || text.length < SPLIT_MIN_CHARS)
		return { text, blocks: [text], frozen: 0, frozenChars: 0, parsed: false, parsedLen: 0, whole: false };
	if (base.whole) return whole(text);
	const kept = base.parsed ? base : undefined;
	const from = kept?.frozenChars ?? 0;
	const last = kept?.blocks[kept.frozen];
	const open = typeof last === "object" ? last : undefined;
	if (kept && !worthParsing(text, kept)) {
		const blocks = kept.blocks.slice(0, kept.frozen);
		const unfrozenText = text.slice(from);
		blocks.push(open ? { ...open, chunks: [...open.chunks.slice(0, -1), unfrozenText] } : unfrozenText);
		return { ...kept, text, blocks };
	}
	const head = open?.head ?? "";
	const tail = head || from ? head + text.slice(from) : text;
	splitStats.parses++;
	splitStats.parsedChars += tail.length;
	const nodes: MdNode[] = parser.parse(tail).children;
	if (defines(nodes)) return whole(text);
	// Where the top-level nodes of `tail` begin, line by line, and the node each span begins with (none when two begin on one line).
	const spans: { from: number; to: number; node?: MdNode }[] = [];
	let cut = 0;
	let first: MdNode | undefined = nodes[0];
	for (let i = 1; i < nodes.length; i++) {
		const offset = nodes[i].position?.start.offset;
		if (offset === undefined) continue;
		const at = lineStart(tail, offset);
		if (at <= cut) {
			first = undefined;
			continue;
		}
		spans.push({ from: cut, to: at, node: first });
		cut = at;
		first = nodes[i];
	}
	spans.push({ from: cut, to: tail.length, node: first });
	const blocks = kept ? kept.blocks.slice(0, kept.frozen) : [];
	for (const [i, span] of spans.entries()) {
		let block: Block | undefined;
		if (open && i === 0) {
			// The group goes on: this is the node its unfrozen chunk begins, with whatever has come in since.
			if (!span.node || tagOf(span.node) !== open.tag) return whole(text);
			block = growGroup(open, span.node, tail, span.to);
		} else if (i === spans.length - 1 && span.to - span.from >= GROUP_MIN_CHARS) {
			block = startGroup(span.node, tail, span.from, span.to);
		}
		blocks.push(block ?? tail.slice(span.from, span.to));
	}
	const end = blocks[blocks.length - 1];
	return {
		text,
		blocks,
		frozen: blocks.length - 1,
		// What a parse starts from: the last block, or the last chunk of it, is what can still change.
		frozenChars: text.length - (typeof end === "string" ? end : end.chunks[end.chunks.length - 1]).length,
		parsed: true,
		parsedLen: text.length,
		whole: false,
	};
}
