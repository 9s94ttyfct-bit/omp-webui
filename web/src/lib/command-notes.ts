import type { OmpFrame } from "@shared/protocol.ts";
import { stripAnsi } from "./ansi.ts";
import type { CommandNote } from "./notices.ts";

/**
 * What a command prints (`/context`, `/session`) is not a message: omp does not save it in the conversation, so
 * nothing but this page has it. The page puts it where the command was run (see `withLiveNotices`: after the entry
 * saved last), and keeps it in this browser by the conversation's file, so that loading the page anew, or opening
 * the conversation again, shows it where it was. Only a bounded number of files, notes and characters are kept.
 */

const KEY = "ompw.commandOutput";
/** Files remembered; the least recently written go first. */
const MAX_FILES = 40;
/** Notes remembered per file: the latest. */
const MAX_NOTES = 30;
/** Characters of one note: a command that printed more is cut, as a terminal would scroll it away. */
const MAX_TEXT = 20_000;

/** The part of `Storage` this needs: tests give it a Map. */
export interface NoteStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

interface Saved {
	at: number;
	after: string | null;
	text: string;
}

/** The text of a `command_output` frame, without the terminal's escape sequences. */
export function commandText(frame: OmpFrame): string {
	const say = (v: unknown) => (typeof v === "string" ? v : undefined);
	return stripAnsi(say(frame.text) ?? say(frame.output) ?? say(frame.message) ?? JSON.stringify(frame));
}

function isSaved(v: unknown): v is Saved {
	if (typeof v !== "object" || v === null) return false;
	const n = v as Record<string, unknown>;
	return typeof n.at === "number" && (n.after === null || typeof n.after === "string") && typeof n.text === "string";
}

/** Everything kept, oldest file first. Whatever does not read as what `write` wrote is dropped, not trusted. */
function read(storage: NoteStorage): [string, Saved[]][] {
	let raw: unknown;
	try {
		raw = JSON.parse(storage.getItem(KEY) ?? "[]");
	} catch {
		return [];
	}
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((row): [string, Saved[]][] =>
		Array.isArray(row) && typeof row[0] === "string" && Array.isArray(row[1]) ? [[row[0], row[1].filter(isSaved)]] : [],
	);
}

/** The notes kept for a conversation's file, as notes numbered in the order they were written. */
export function loadCommandNotes(file: string | null, storage: NoteStorage = localStorage): CommandNote[] {
	if (file === null) return [];
	const kept = read(storage).find(([f]) => f === file)?.[1] ?? [];
	return kept.map(
		(n, i): CommandNote => ({ kind: "command", seq: i + 1, at: n.at, after: n.after, file, text: n.text }),
	);
}

/**
 * Remember a conversation's notes, replacing what was kept for its file. Only the notes of a file count: the page's
 * list can hold notes of a file it has since left (a branch is a file of its own), which are kept under theirs.
 */
export function saveCommandNotes(file: string, notes: CommandNote[], storage: NoteStorage = localStorage): void {
	const rows = read(storage).filter(([f]) => f !== file);
	const mine = notes
		.filter((n) => n.file === file)
		.slice(-MAX_NOTES)
		.map((n): Saved => ({ at: n.at, after: n.after, text: n.text.slice(0, MAX_TEXT) }));
	if (mine.length > 0) rows.push([file, mine]);
	try {
		storage.setItem(KEY, JSON.stringify(rows.slice(-MAX_FILES)));
	} catch {
		// Storage is full or refused: these are a convenience, and the page shows them for as long as it runs.
	}
}

/**
 * Remember the notes of every file in a list the page holds (see `saveCommandNotes`): those of the list, and those of
 * the list it replaces, which may have none left.
 */
export function rememberCommandNotes(
	notes: CommandNote[],
	before: CommandNote[] = [],
	storage: NoteStorage = localStorage,
): void {
	const files = new Set([...notes, ...before].flatMap((n) => (n.file === null ? [] : [n.file])));
	for (const file of files) saveCommandNotes(file, notes, storage);
}
