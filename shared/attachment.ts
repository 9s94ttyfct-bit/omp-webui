/**
 * Files dropped, pasted or picked in the composer (#617): what each one is, whether it can be attached to the message
 * (text inline, an image as an image, a PDF or a Word document as its text and the images of its pages) or only named by
 * its path, and how a text file is written into the message.
 *
 * What omp 18.12 takes with a prompt (read from its own code, `rpc.md` has only the first): `message` text and `images`
 * (`{ type: "image", data, mimeType }`, which it checks decode as an image: anything else is replaced by "[image omitted:
 * undecodable …]" before the model sees it). There is no document or file part, so a PDF or a Word document travels as the
 * text read from it in the browser (#697) and, for the pages of a PDF that have no text (a scan), as pictures of them. omp
 * does read a file whose path stands in the text as `@path` (`file-mentions`: text up to 5 MiB, an image, a folder's
 * listing; a binary file is only noted as skipped), and its `read` tool converts PDFs and Office documents (`.pdf .doc
 * .docx .ppt .pptx .xls .xlsx .rtf .epub`) when the model is given their path. So "attach" is text, images, PDFs and `.docx`;
 * everything else is a path.
 */

import { documentTypeOf, extensionOf } from "./folder.ts";

/** The most text a message carries inline. A model reads all of it: a megabyte of text is a quarter of a million tokens. */
export const ATTACH_LIMITS = {
	/** One text file. */
	textFileBytes: 256 * 1024,
	/** Every text file of one message together. */
	textTotalBytes: 512 * 1024,
} as const;

/**
 * PDF and Word (`.docx`) documents attached to a message (#697): how much of one is read, and where it stops. The text goes
 * into the message as a text file does, so it counts against `ATTACH_LIMITS` too; the page images go through the images'
 * own limits (`web/src/lib/images.ts`).
 */
export const DOCUMENT_LIMITS = {
	/** The largest document opened: the browser reads it whole into memory, so a bigger one is refused unread. */
	fileBytes: 25 * 1024 * 1024,
	/** The most pages of a PDF whose text goes into the message; the pages after them are left out, and counted. */
	textPages: 50,
	/** The most pages of a PDF sent as pictures: only the pages that have no text of their own (a scan), first ones first. */
	imagePages: 10,
	/** A page with fewer letters and digits than this has no text worth sending; it goes as a picture instead. */
	scannedBelowChars: 20,
} as const;

/** What a dropped item is, as far as the choice between attaching it and inserting its path goes. */
export type DropKind = "text" | "image" | "document" | "other" | "folder";
export const DROP_KINDS: readonly DropKind[] = ["text", "image", "document", "other", "folder"];

/** What is done with a dropped item: its content goes into the message (`attach`) or its path is written in the text (`path`). */
export type DropAction = "attach" | "path";

/** Whether `action` can be done to a `kind` at all: a folder (or a file that is none of these) has no content a message can carry. */
export const canAttachKind = (kind: DropKind): boolean => kind === "text" || kind === "image" || kind === "document";
export const actionAllowed = (kind: DropKind, action: DropAction): boolean => action === "path" || canAttachKind(kind);

/** The choices a person asked to be remembered, by kind; what is not here is asked each time. */
export type DropChoices = Partial<Record<DropKind, DropAction>>;

/** The choices a stored value holds; anything unreadable, or an action a kind cannot have, is dropped (asked again). */
export function parseChoices(raw: string | null): DropChoices {
	let parsed: unknown;
	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	const out: DropChoices = {};
	for (const kind of DROP_KINDS) {
		const action = (parsed as Record<string, unknown>)[kind];
		if ((action === "attach" || action === "path") && actionAllowed(kind, action)) out[kind] = action;
	}
	return out;
}

/** What is stored for `choices`: null for none. */
export function serializeChoices(choices: DropChoices): string | null {
	const clean = parseChoices(JSON.stringify(choices));
	return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

/** Why an item cannot be attached; the page words it. */
export type NoAttach = "folder" | "document" | "binary" | "tooLarge" | "documentTooLarge";

export interface DropFileInfo {
	name: string;
	/** The MIME type the browser reports; empty when it does not know. */
	type: string;
	size: number;
	/** A folder (the browser gives it as an item with no content). */
	directory?: boolean;
}

export interface Classified {
	kind: DropKind;
	/** `true`: the content can go into the message; else why not. */
	attach: true | NoAttach;
}

/** What omp's `read` tool converts to text from a path (`CONVERTIBLE_EXTENSIONS`); a message carries only two of them. */
const DOCUMENT_EXTENSIONS: Readonly<Record<string, true>> = {
	pdf: true,
	doc: true,
	docx: true,
	ppt: true,
	pptx: true,
	xls: true,
	xlsx: true,
	rtf: true,
	epub: true,
};

/** Whether a file name is one of those: PDF, Word, PowerPoint, Excel, RTF and EPUB. */
export const isDocumentName = (name: string): boolean => Object.hasOwn(DOCUMENT_EXTENSIONS, extensionOf(name));

/**
 * What a file is. `looksText` is what `looksLikeText` made of its first bytes: names say little (`Makefile`, `.env`,
 * `notes`), and a file that is not text cannot be put into a message whatever it is called. A document by name is one
 * whatever it holds (an `.rtf` is text, but its markup is not what to hand a model); of those only a PDF and a `.docx` are
 * read for the message, and the rest are paths.
 */
export function classify(file: DropFileInfo, looksText: boolean): Classified {
	if (file.directory) return { kind: "folder", attach: "folder" };
	if (documentTypeOf(file.name)) {
		return { kind: "document", attach: file.size > DOCUMENT_LIMITS.fileBytes ? "documentTooLarge" : true };
	}
	if (isDocumentName(file.name)) return { kind: "other", attach: "document" };
	const svg = file.type === "image/svg+xml" || extensionOf(file.name) === "svg";
	if (file.type.startsWith("image/") && !svg) return { kind: "image", attach: true };
	if (!looksText) return { kind: "other", attach: "binary" };
	return { kind: "text", attach: file.size > ATTACH_LIMITS.textFileBytes ? "tooLarge" : true };
}

/**
 * Whether `sample` is text: no NUL byte, and UTF-8 throughout. A sample that is the start of a longer file may end in a
 * character that is cut (let by); one that is `whole` file may not.
 */
export function looksLikeText(sample: Uint8Array, whole = false): boolean {
	if (sample.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: !whole });
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether `text` has an `@` that omp would read as the mention of a file (`@src/a.ts`, `@"a b.txt"`, `@~/notes`): at the
 * start or after a space, then a quote, `~`, `/` or `.`. omp reads the files such mentions name into the prompt, wherever the
 * mention is in the message, so one in an attached file is read too. It is told to the person, not removed from the text.
 */
export const hasMention = (text: string): boolean => /(^|\s)@["~/.]/.test(text);

// ------------------------------------------------------------------ text files in the message

export interface TextFile {
	name: string;
	/** The file's size on disk, in bytes. */
	bytes: number;
	text: string;
}

/** The fence languages worth naming: what a reader (and the transcript's code blocks) highlights. */
const FENCE_LANGUAGES: Readonly<Record<string, string>> = {
	ts: "ts",
	tsx: "tsx",
	js: "js",
	jsx: "jsx",
	mjs: "js",
	cjs: "js",
	json: "json",
	md: "md",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cpp: "cpp",
	hpp: "cpp",
	cs: "csharp",
	sh: "sh",
	zsh: "sh",
	bash: "sh",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	html: "html",
	css: "css",
	scss: "scss",
	sql: "sql",
	xml: "xml",
	svg: "xml",
	csv: "csv",
};

/** A name as it is written in the header: one line, and nothing that ends the quoted attribute or opens a tag. */
function headerName(name: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed.
	return name.replace(/[\u0000-\u001f\u007f"<>]/g, "_").slice(0, 200);
}

/** A fence of backticks longer than any run of them in `text`, so that nothing in the file can close it. */
export function fenceFor(text: string): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return "`".repeat(Math.max(3, longest + 1));
}

/**
 * One text file as the model reads it: its name and size, and its text in a fence. The same shape omp's own file
 * mentions have (`<file path="…">`), so the model needs no explanation. `splitMessage` reads it back, to show the file as
 * a chip instead of a wall of text.
 */
export function formatTextFile(file: TextFile): string {
	const fence = fenceFor(file.text);
	const ext = extensionOf(file.name);
	const language = Object.hasOwn(FENCE_LANGUAGES, ext) ? FENCE_LANGUAGES[ext] : "";
	const body = file.text === "" || file.text.endsWith("\n") ? file.text : `${file.text}\n`;
	return `<file name="${headerName(file.name)}" size="${Math.max(0, Math.floor(file.bytes))}">\n${fence}${language}\n${body}${fence}\n</file>`;
}

/** The message a person's text and their attached text files make: the files after the text, one block each. */
export function joinMessage(text: string, files: readonly TextFile[]): string {
	if (!files.length) return text;
	const blocks = files.map(formatTextFile).join("\n");
	return text ? `${text}\n\n${blocks}` : blocks;
}

export interface MessageFile {
	name: string;
	bytes: number;
	/** The file's text (the newline `formatTextFile` ends it with is not part of it). */
	text: string;
	/** The block as it stands in the message. */
	raw: string;
}

const BLOCK = /<file name="([^"\n]*)" size="(\d+)">\n(`{3,})([^\n`]*)\n([\s\S]*?)\3\n<\/file>/g;

/** A message split into what the person wrote and the text files `joinMessage` put in it (anything else stays in the text). */
export function splitMessage(message: string): { text: string; files: MessageFile[] } {
	if (!message.includes("<file name=")) return { text: message, files: [] };
	const files: MessageFile[] = [];
	const rest: string[] = [];
	let from = 0;
	for (const m of message.matchAll(BLOCK)) {
		const body = m[5] ?? "";
		// The closing fence is at the start of a line, as `formatTextFile` writes it.
		if (body !== "" && !body.endsWith("\n")) continue;
		rest.push(message.slice(from, m.index));
		from = (m.index ?? 0) + m[0].length;
		files.push({
			name: m[1] ?? "",
			bytes: Number(m[2]),
			text: body.endsWith("\n") ? body.slice(0, -1) : body,
			raw: m[0],
		});
	}
	if (!files.length) return { text: message, files };
	rest.push(message.slice(from));
	return {
		text: rest
			.map((piece) => piece.trim())
			.filter(Boolean)
			.join("\n\n"),
		files,
	};
}

/** Whether the message carries text files the way `joinMessage` writes them. */
export const hasTextFiles = (message: string): boolean => splitMessage(message).files.length > 0;

/** `path` as it is written in a message: quoted when it holds a space, so that it reads as one thing. */
export function pathText(path: string): string {
	return /\s/.test(path) ? `"${path}"` : path;
}
