import type { FolderEntry } from "@shared/folder.ts";
import { extensionOf } from "@shared/folder.ts";

/**
 * The Files tab's tree as the page draws it: which rows are on screen for the folders that are open, and where each key
 * of the keyboard moves. Pure, so that the walk and the keys are tested on their own.
 */

/** What a folder's listing holds, as the page keeps it. */
export interface DirListing {
	entries: FolderEntry[];
	hiddenCount: number;
	truncated: boolean;
	/** The folder is in a repository that was looked at. */
	git: boolean;
	/** The page is not this computer's: what is hidden by default stays hidden (there is no switch for it), and secrets are left out. */
	guarded: boolean;
	/** This page may ask for a folder to be opened in Finder (a page on this Mac, the server on macOS). */
	local: boolean;
}

/** One row of the tree: an entry of an open folder. */
export interface EntryRow {
	kind: "entry";
	path: string;
	name: string;
	depth: number;
	entry: FolderEntry;
	/** A folder that is open. */
	open: boolean;
	/** Position among the entries of its folder, and how many there are (for `aria-posinset` and `aria-setsize`). */
	index: number;
	count: number;
}

/** A row that is no entry: a folder being read, one that could not be, an empty one, or a list that was cut. */
export interface NoteRow {
	kind: "loading" | "error" | "empty" | "cut";
	/** The folder it is about. */
	path: string;
	depth: number;
	message?: string;
	/** `cut`: how many entries are listed. `empty`: how many are hidden. */
	n?: number;
}

export type Row = EntryRow | NoteRow;

/** What the page knows of one folder: its listing, or why it has none. */
export interface DirSlot {
	listing?: DirListing;
	error?: string;
}

export const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** Each folder `path` is in, nearest first, up to (not including) the root: `a/b/c` is in `a/b`, then `a`. */
export function* ancestorsOf(path: string): Generator<string> {
	for (let p = parentOf(path); p; p = parentOf(p)) yield p;
}

/** The open folders that can be seen: every one of the folders around it is open too. */
export function visibleOpen(open: readonly string[]): string[] {
	const set = new Set(open);
	return open.filter((p) => {
		for (const a of ancestorsOf(p)) if (!set.has(a)) return false;
		return true;
	});
}

/**
 * The rows on screen: the entries of the root, and below each folder that is open the entries of that folder, down to
 * as many levels as are open. A folder that is open and not read yet is a `loading` row below it.
 */
export function visibleRows(slots: Readonly<Record<string, DirSlot>>, open: readonly string[]): Row[] {
	const opened = new Set(open);
	const rows: Row[] = [];
	const walk = (dir: string, depth: number) => {
		const slot = slots[dir];
		if (!slot?.listing) {
			if (dir !== "")
				rows.push(
					slot?.error
						? { kind: "error", path: dir, depth, message: slot.error }
						: { kind: "loading", path: dir, depth },
				);
			return;
		}
		const { entries, hiddenCount, truncated } = slot.listing;
		if (entries.length === 0 && dir !== "") rows.push({ kind: "empty", path: dir, depth, n: hiddenCount });
		entries.forEach((entry, index) => {
			const path = dir ? `${dir}/${entry.name}` : entry.name;
			const isOpen = entry.kind === "dir" && opened.has(path);
			rows.push({ kind: "entry", path, name: entry.name, depth, entry, open: isOpen, index, count: entries.length });
			if (isOpen) walk(path, depth + 1);
		});
		if (truncated) rows.push({ kind: "cut", path: dir, depth, n: entries.length });
	};
	walk("", 0);
	return rows;
}

/** A key of the tree, and what the page does for it. */
export type TreeMove =
	| { to: string }
	| { open: string }
	| { close: string }
	| { toggle: string }
	| { choose: string }
	| null;

/**
 * What a key does with `current` focused among `rows` (the WAI-ARIA tree pattern): Down and Up move, Home and End go to
 * the first and last, Right opens a closed folder and then enters it, Left closes an open folder and then goes to the
 * one around it, Enter and Space open a folder or a file.
 */
export function moveFor(key: string, rows: readonly Row[], current: string | null): TreeMove {
	const entries = rows.filter((r): r is EntryRow => r.kind === "entry");
	if (entries.length === 0) return null;
	const at = current === null ? -1 : entries.findIndex((r) => r.path === current);
	const row = at < 0 ? undefined : entries[at];
	const go = (i: number): TreeMove => ({ to: entries[Math.max(0, Math.min(entries.length - 1, i))].path });
	switch (key) {
		case "ArrowDown":
			return go(at + 1);
		case "ArrowUp":
			return go(at < 0 ? 0 : at - 1);
		case "Home":
			return go(0);
		case "End":
			return go(entries.length - 1);
		case "ArrowRight": {
			if (row?.entry.kind !== "dir") return null;
			if (!row.open) return { open: row.path };
			const child = entries[at + 1];
			return child && child.depth > row.depth ? { to: child.path } : null;
		}
		case "ArrowLeft": {
			if (!row) return null;
			if (row.entry.kind === "dir" && row.open) return { close: row.path };
			const parent = parentOf(row.path);
			return parent && entries.some((r) => r.path === parent) ? { to: parent } : null;
		}
		case "Enter":
		case " ":
			if (!row) return null;
			return row.entry.kind === "dir" ? { toggle: row.path } : { choose: row.path };
		default:
			return null;
	}
}

/** What kind of icon a file gets, by its name. */
export type FileKind = "image" | "text" | "code" | "data" | "file";

const CODE = new Set(
	(
		"ts tsx js jsx mjs cjs mts cts py rb go rs java kt kts swift c h cc cpp hpp cs php lua sh bash zsh fish pl r scala " +
		"dart ex exs erl hs ml clj vue svelte css scss sass less html htm sql graphql gql proto tf zig nim jl"
	).split(" "),
);
const DATA = new Set("json jsonc json5 yaml yml toml ini xml csv tsv lock plist env".split(" "));
const TEXT = new Set("md markdown mdx txt rst adoc log text".split(" "));
const IMAGES = new Set("png jpg jpeg gif webp avif bmp ico svg".split(" "));

export function kindOf(name: string): FileKind {
	const ext = extensionOf(name);
	if (IMAGES.has(ext)) return "image";
	if (TEXT.has(ext)) return "text";
	if (DATA.has(ext)) return "data";
	if (CODE.has(ext)) return "code";
	return "file";
}

/** The language a highlighter is asked for: the extension, else the file's own name (`Dockerfile`, `Makefile`). */
export function languageOf(name: string): string {
	return extensionOf(name) || name.toLowerCase();
}

/** `n` bytes as people read them: 412 B, 3.4 KB, 2 MB. */
export function fmtBytes(n: number): string {
	if (n < 1000) return `${n} B`;
	const units = ["KB", "MB", "GB"];
	let value = n / 1000;
	let i = 0;
	while (value >= 1000 && i < units.length - 1) {
		value /= 1000;
		i++;
	}
	return `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** `text` in three parts around the first place `query` is in it (case does not matter): what comes before, the match, what follows. */
export function splitMatch(text: string, query: string): [string, string, string] {
	const q = query.trim().toLowerCase();
	const at = q ? text.toLowerCase().indexOf(q) : -1;
	return at < 0 ? [text, "", ""] : [text.slice(0, at), text.slice(at, at + q.length), text.slice(at + q.length)];
}
