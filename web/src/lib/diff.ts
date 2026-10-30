/**
 * What omp's `edit` / `write` tools put in a tool call and its result, ready for display. Pure: no React.
 *
 * omp's `details.diff` is one line per row, `<sign><lineNo>|<text>`: sign is ` ` (context), `+` or `-`,
 * the number is not padded, `-` rows carry old-file numbers and the others new-file numbers, and a
 * blank line is the gap between two hunks.
 */

export type DiffRow = { kind: "add" | "del" | "ctx"; line: number; text: string } | { kind: "gap" };

export interface DiffCounts {
	added: number;
	removed: number;
}

const DIFF_LINE = /^([ +-])(\d+)\|(.*)$/;
const KINDS = { " ": "ctx", "+": "add", "-": "del" } as const;

/** Rows of a diff string. Lines of no known shape are dropped; gaps are collapsed and never lead or trail. */
export function parseDiff(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	for (const raw of diff.split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const m = DIFF_LINE.exec(line);
		if (m) {
			rows.push({ kind: KINDS[m[1] as keyof typeof KINDS], line: Number(m[2]), text: m[3] });
		} else if (line.trim() === "" && rows.length > 0 && rows[rows.length - 1].kind !== "gap") {
			rows.push({ kind: "gap" });
		}
	}
	if (rows[rows.length - 1]?.kind === "gap") rows.pop();
	return rows;
}

export function diffCounts(rows: readonly DiffRow[]): DiffCounts {
	const counts = { added: 0, removed: 0 };
	for (const r of rows) {
		if (r.kind === "add") counts.added++;
		else if (r.kind === "del") counts.removed++;
	}
	return counts;
}

/** Written content as numbered, neutral rows: for an overwrite nothing in it is known to be new. */
export function listingRows(content: string): DiffRow[] {
	if (!content) return [];
	const lines = content.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.map((text, i) => ({
		kind: "ctx",
		line: i + 1,
		text: text.endsWith("\r") ? text.slice(0, -1) : text,
	}));
}

const HASHLINE_HEADER = /^["']?\[["']?(.+?)["']?#[0-9a-fA-F]{4}["']?\]["']?\s*$/;
const PATCH_HEADER = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/;

/** Every file an edit `input` addresses, in order: `[path#TAG]` headers and `*** Update File:` lines. */
export function hashlinePaths(input: string): string[] {
	const paths: string[] = [];
	for (const line of input.split("\n")) {
		const m = HASHLINE_HEADER.exec(line) ?? PATCH_HEADER.exec(line);
		const path = m?.[1].replace(/^["']|["']$/g, "");
		if (path && !paths.includes(path)) paths.push(path);
	}
	return paths;
}

const WARNINGS_HEADING = /(?:^|\n)[ \t]*Warnings:[ \t]*\n/;

/**
 * The tool's text blocks, split into what it reported and what it warned about: everything after a
 * `Warnings:` heading in the first block, plus every further block.
 */
export function splitWarnings(texts: readonly string[]): { output: string; warnings: string[] } {
	const [first = "", ...rest] = texts;
	const warnings: string[] = [];
	let output = first;
	const m = WARNINGS_HEADING.exec(first);
	if (m) {
		output = first.slice(0, m.index);
		const body = first.slice(m.index + m[0].length).trim();
		if (body) warnings.push(body);
	}
	for (const text of rest) if (text.trim()) warnings.push(text.trim());
	return { output: output.trimEnd(), warnings };
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The text blocks of a tool result (`{ content }`), whether content is a string or a block list. */
export function resultTexts(result: unknown): string[] {
	if (typeof result === "string") return result ? [result] : [];
	const content = rec(result)?.content;
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.flatMap((b) => {
		const block = rec(b);
		return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
	});
}

export interface FileChange {
	path: string;
	/** omp's diff string for this file, when it reported one. */
	diff?: string;
	op?: string;
	/** Target path of a move. */
	move?: string;
}

export interface Diagnostics {
	summary?: string;
	messages: string[];
	errored?: boolean;
}

export interface ToolChanges {
	files: FileChange[];
	counts: DiffCounts;
	diagnostics?: Diagnostics;
}

function fileOf(path: string, source: Record<string, unknown>): FileChange {
	const file: FileChange = { path };
	const diff = str(source.diff);
	if (diff) file.diff = diff;
	const op = str(source.op);
	if (op) file.op = op;
	const move = str(source.move);
	if (move) file.move = move;
	return file;
}

function diagnosticsOf(details: Record<string, unknown> | undefined): Diagnostics | undefined {
	const d = rec(details?.diagnostics);
	if (!d) return undefined;
	const messages = Array.isArray(d.messages) ? d.messages.filter((m): m is string => typeof m === "string") : [];
	const summary = str(d.summary);
	if (!summary && messages.length === 0) return undefined;
	const out: Diagnostics = { messages };
	if (summary) out.summary = summary;
	if (typeof d.errored === "boolean") out.errored = d.errored;
	return out;
}

/** Files an `edit`/`write` call touched, from the richest source available (see the order below). */
export function toolChanges(name: string, args: unknown, details: unknown): ToolChanges {
	const a = rec(args);
	const d = rec(details);
	let files: FileChange[] = [];

	const perFile = Array.isArray(d?.perFileResults) ? d.perFileResults : [];
	for (const entry of perFile) {
		const e = rec(entry);
		const path = str(e?.path);
		if (e && path) files.push(fileOf(path, e));
	}
	if (files.length === 0 && d) {
		const path = str(d.path) ?? (name === "write" ? str(d.resolvedPath) : undefined);
		if (path) files = [fileOf(path, d)];
	}
	if (files.length === 0) {
		const paths = name === "edit" && typeof a?.input === "string" ? hashlinePaths(a.input) : [];
		const argPath = str(a?.path) ?? str(a?.file_path);
		if (paths.length === 0 && argPath) paths.push(argPath);
		files = paths.map((path) => ({ path }));
		const diff = str(d?.diff);
		if (diff && files.length === 1) files[0].diff = diff;
		else if (diff && files.length === 0) files = [{ path: "", diff }];
	}

	const counts = { added: 0, removed: 0 };
	for (const f of files) {
		if (!f.diff) continue;
		const c = diffCounts(parseDiff(f.diff));
		counts.added += c.added;
		counts.removed += c.removed;
	}
	const diagnostics = diagnosticsOf(d);
	return diagnostics ? { files, counts, diagnostics } : { files, counts };
}

/** `dir/` and `name` of a path (either slash), so a view can truncate the directory first. */
export function splitPath(path: string): { dir: string; name: string } {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
	if (cut === path.length) return { dir: "", name: path };
	return { dir: path.slice(0, cut), name: path.slice(cut) };
}
