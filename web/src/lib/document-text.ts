import { DOCUMENT_LIMITS } from "@shared/attachment.ts";
import { unzipSync } from "fflate";

/**
 * The text of PDF and Word documents (#697), apart from the libraries that open a PDF (`lib/pdf.ts`) and the browser: what
 * a `.docx` says in its `word/document.xml`, which pages of a PDF have no text of their own, and how the pages' text is
 * written into the message within its limits. A lazy chunk: the first page does not carry the zip reader.
 */

/** Why a document could not be read; the page words it (`documentFailureText`). */
export type DocumentError = "tooLarge" | "encrypted" | "damaged" | "oldWord";

/** The decompressed size one `.docx` body may have: a zip can declare a thousandfold of what it holds. */
const MAX_XML_BYTES = 64 * 1024 * 1024;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The UTF-8 length of `text`, which is what a message weighs. */
export const utf8Bytes = (text: string): number => encoder.encode(text).length;

/** The longest start of `text` that is at most `max` bytes of UTF-8, never ending inside a character. */
export function cutToBytes(text: string, max: number): string {
	if (max <= 0) return "";
	const bytes = encoder.encode(text);
	if (bytes.length <= max) return text;
	// A character cut by the limit decodes as the replacement character, which is not the text's.
	return decoder.decode(bytes.subarray(0, max)).replace(/\uFFFD$/, "");
}

// ------------------------------------------------------------------ Word

const ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** `&lt;`, `&#65;` and `&#x41;` as the characters they stand for; anything else is left as it is. */
export function decodeXml(text: string): string {
	return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g, (whole, dec, hex, name) => {
		if (name) return ENTITIES[name] ?? whole;
		const code = dec ? Number(dec) : Number.parseInt(hex, 16);
		return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});
}

/** The tags of a paragraph's text and of the tables around it; `(?=…)` keeps `<w:tabs>`, `<w:tblPr>` and `<w:tcPr>` out. */
const TAG = /<w:(t|tab|br|cr|p|tc|tr|tbl)(?=[\s/>])[^>]*>|<\/w:(p|tc|tr|tbl)>/g;

interface Table {
	/** The rows done, each as its cells' text with " | " between. */
	rows: string[];
	cells: string[];
	/** The paragraphs of the cell being read. */
	paragraphs: string[];
}

/**
 * The text of a Word document body (`word/document.xml`) as lines: a paragraph is a line, an empty one marks a break, and a
 * table is a line for each row with its cells between " | " (a table inside a cell is flattened into that cell). Only the
 * words of the body: headers, footers, notes, comments and deleted text are not in it.
 */
export function docxText(xml: string): string {
	// A text box is written twice (for newer and older readers); the second is not another box. Tab stops (`<w:tabs>`) are
	// of the paragraph's properties, and are not tab characters.
	const body = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, "").replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, "");
	const lines: string[] = [];
	const tables: Table[] = [];
	let paragraph = "";

	const endParagraph = () => {
		const text = paragraph.replace(/[ \t]+$/gm, "");
		paragraph = "";
		const table = tables.at(-1);
		if (table) table.paragraphs.push(text);
		else lines.push(text);
	};
	const endCell = () => {
		const table = tables.at(-1);
		if (!table) return;
		table.cells.push(
			table.paragraphs
				.filter((p) => p.trim() !== "")
				.join(" ")
				.trim(),
		);
		table.paragraphs = [];
	};
	const endRow = () => {
		const table = tables.at(-1);
		if (!table) return;
		if (table.cells.some((c) => c !== "")) table.rows.push(table.cells.join(" | "));
		table.cells = [];
	};
	const endTable = () => {
		const table = tables.pop();
		if (!table) return;
		const outer = tables.at(-1);
		if (outer) {
			if (table.rows.length) outer.paragraphs.push(table.rows.join("; "));
		} else {
			lines.push(...table.rows);
		}
	};

	TAG.lastIndex = 0;
	for (let m = TAG.exec(body); m; m = TAG.exec(body)) {
		const closing = m[2];
		const selfClosing = m[0].endsWith("/>");
		if (closing) {
			if (closing === "p") endParagraph();
			else if (closing === "tc") endCell();
			else if (closing === "tr") endRow();
			else endTable();
			continue;
		}
		switch (m[1]) {
			case "t": {
				if (selfClosing) break;
				const end = body.indexOf("</w:t>", TAG.lastIndex);
				if (end < 0) return finish(lines);
				paragraph += decodeXml(body.slice(TAG.lastIndex, end));
				TAG.lastIndex = end + "</w:t>".length;
				break;
			}
			case "tab":
				paragraph += "\t";
				break;
			case "br":
			case "cr":
				paragraph += "\n";
				break;
			case "p":
				if (selfClosing) endParagraph();
				break;
			case "tc":
				if (selfClosing) tables.at(-1)?.cells.push("");
				break;
			case "tbl":
				tables.push({ rows: [], cells: [], paragraphs: [] });
				break;
			// `<w:tr>` opens a row: its cells start empty already.
		}
	}
	return finish(lines);
}

/** The lines as text: no more than one empty line in a row, none at either end. */
function finish(lines: readonly string[]): string {
	const out: string[] = [];
	for (const line of lines) {
		if (line.trim() === "" && (out.length === 0 || out.at(-1) === "")) continue;
		out.push(line.trim() === "" ? "" : line);
	}
	while (out.at(-1) === "") out.pop();
	return out.join("\n");
}

/** The magic of an OLE compound file: an old `.doc`, or a `.docx` that is encrypted (Word wraps those in one). */
const OLE = [0xd0, 0xcf, 0x11, 0xe0];
/** The magic of a zip's first entry. */
const ZIP = [0x50, 0x4b, 0x03, 0x04];

const startsWith = (bytes: Uint8Array, magic: readonly number[]) => magic.every((b, i) => bytes[i] === b);

/** The text of a `.docx` file's bytes, or why it cannot be read. */
export function readDocx(bytes: Uint8Array): { text: string } | { error: DocumentError } {
	if (startsWith(bytes, OLE)) return { error: "oldWord" };
	if (!startsWith(bytes, ZIP)) return { error: "damaged" };
	let tooBig = false;
	let entries: Record<string, Uint8Array>;
	try {
		// Only the body is inflated, and only when it says it is of a size that can be.
		entries = unzipSync(bytes, {
			filter: (file) => {
				if (file.name !== "word/document.xml") return false;
				tooBig = file.originalSize > MAX_XML_BYTES;
				return !tooBig;
			},
		});
	} catch {
		return { error: "damaged" };
	}
	if (tooBig) return { error: "tooLarge" };
	const xml = entries["word/document.xml"];
	if (!xml) return { error: "damaged" };
	return { text: docxText(decoder.decode(xml)) };
}

// ------------------------------------------------------------------ PDF

/** What `getTextContent` of a PDF page lists: runs of text, and marks that hold none. */
export type PdfTextItem = { str?: string; hasEOL?: boolean };

/** A page's text as lines: the runs joined where the PDF says a line ends, trailing spaces and runs of empty lines gone. */
export function pageText(items: readonly PdfTextItem[]): string {
	let raw = "";
	for (const item of items) {
		if (typeof item.str !== "string") continue;
		raw += item.str;
		if (item.hasEOL) raw += "\n";
	}
	return (
		raw
			// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed.
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
			.replace(/[ \t]+$/gm, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	);
}

/** Whether a page has no text worth sending (a scan, or a page that is a picture): too few letters and digits. */
export function isScanned(text: string): boolean {
	return (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < DOCUMENT_LIMITS.scannedBelowChars;
}

/** The pages (counted from 1) among `texts` that have no text, in order. */
export function scannedPages(texts: readonly string[]): number[] {
	const out: number[] = [];
	texts.forEach((text, i) => {
		if (isScanned(text)) out.push(i + 1);
	});
	return out;
}

/**
 * The bytes kept back from the text budget for the lines that open the document's text: what the pages leave out is said
 * in them, so they are written after the pages that fit are known.
 */
const FRAME_BYTES = 768;

/** The smallest text budget a PDF is read for: under it not even a page's start would go in beside what says what was left out. */
export const MIN_TEXT_BUDGET = FRAME_BYTES + 256;

/** `1`, `1–3` or `1, 4–6, 9` for page numbers in order. */
export function pageRanges(pages: readonly number[]): string {
	const parts: string[] = [];
	for (let i = 0; i < pages.length; ) {
		let j = i;
		while (pages[j + 1] === (pages[j] as number) + 1) j++;
		parts.push(j > i ? `${pages[i]}–${pages[j]}` : `${pages[i]}`);
		i = j + 1;
	}
	return parts.join(", ");
}

export interface PdfMessage {
	/** What goes into the message as the document's text. */
	text: string;
	/** Its weight in the message. */
	bytes: number;
	/** The pages the text has, from the first on: the others are left out. */
	included: number;
	/** The pages after those, which the text says were left out (the page limit, or the text budget). */
	leftOut: number;
	/** Pages of the text that have no text of their own and come as pictures. */
	pictured: number;
	/** Pages of the text that have no text of their own and come as neither. */
	bare: number;
	/** The last page's text was cut where the text budget ended. */
	cut: boolean;
}

/**
 * The text a PDF becomes in the message: a line that says what it is and what was left out, then each page after a marker.
 * A page with no text of its own is a note that it comes as a picture (`pictures` are the pages that did) or, when it did
 * not, whatever little text it has. `texts` are the first pages' text (at most `DOCUMENT_LIMITS.textPages`), `pages` all the
 * pages of the file; pages go in while they fit within `budget` bytes, the first of them cut if it alone does not, and the
 * rest are left out.
 */
export function pdfMessage(input: {
	pages: number;
	texts: readonly string[];
	pictures: readonly number[];
	budget: number;
}): PdfMessage {
	const { pages, texts } = input;
	const pictured = new Set(input.pictures);
	const room = Math.max(0, input.budget - FRAME_BYTES);
	const blocks: string[] = [];
	const withPicture: number[] = [];
	const bare: number[] = [];
	let used = 0;
	let cut = false;
	for (const [i, text] of texts.entries()) {
		const n = i + 1;
		const scanned = isScanned(text);
		const body = !scanned
			? text
			: pictured.has(n)
				? "[no text on this page; it is attached as an image]"
				: text || "[no text on this page, and no image of it is attached]";
		const block = `--- page ${n} ---\n${body}`;
		const bytes = utf8Bytes(block) + 1;
		if (used + bytes > room) {
			// Page 1 may be longer than the whole budget: its start goes in, which is better than nothing.
			if (blocks.length === 0) {
				blocks.push(cutToBytes(block, room));
				cut = true;
				if (scanned) (pictured.has(n) ? withPicture : bare).push(n);
			}
			break;
		}
		blocks.push(block);
		used += bytes;
		if (scanned) (pictured.has(n) ? withPicture : bare).push(n);
	}
	const included = blocks.length;
	const leftOut = Math.max(0, pages - included);
	const lines = [`PDF, ${pages} ${pages === 1 ? "page" : "pages"}.`];
	if (leftOut > 0) {
		const rest = Array.from({ length: leftOut }, (_, k) => included + 1 + k);
		// Pages past the page limit were never read; the others were read and did not fit.
		const why =
			included === texts.length ? `limit of ${DOCUMENT_LIMITS.textPages} pages` : "limit of the text a message carries";
		lines.push(`Left out (${why}): ${rest.length === 1 ? "page" : "pages"} ${pageRanges(rest)}.`);
	}
	if (cut) lines.push(`Cut short (limit of the text a message carries): page ${included}.`);
	if (withPicture.length) lines.push(`Pages with no text, attached as images: ${pageRanges(withPicture)}.`);
	if (bare.length) lines.push(`Pages with little or no text, no image attached: ${pageRanges(bare)}.`);
	const text = `${lines.join("\n")}\n\n${blocks.join("\n")}`;
	return { text, bytes: utf8Bytes(text), included, leftOut, pictured: withPicture.length, bare: bare.length, cut };
}

/** The text of a `.docx` as the message carries it, cut to `budget` bytes at the end of a line; `cut` when something was left. */
export function docxMessage(text: string, budget: number): { text: string; cut: boolean } {
	const room = Math.max(0, budget - 256);
	if (utf8Bytes(text) <= room) return { text, cut: false };
	const head = cutToBytes(text, room);
	const lastLine = head.lastIndexOf("\n");
	const kept = lastLine > 0 ? head.slice(0, lastLine) : head;
	return {
		text: `${kept}\n\n[The document continues: the rest is left out (limit of the text a message carries).]`,
		cut: true,
	};
}
