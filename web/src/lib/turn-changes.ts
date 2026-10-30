import type { SessionEntry } from "@shared/protocol.ts";
import { toolChanges } from "./diff.ts";
import { blocks, messageOf, type ToolResults } from "./messages.ts";
import { isPrompt, isUserCommand } from "./turns.ts";

/**
 * Which files omp's `edit` and `write` calls changed in each turn of a conversation, for the Changes view's "By turn" list.
 * What a turn changed is what its tool calls say they did (a call that failed changed nothing); a file that omp's `bash`
 * tool or another program changed is in the working tree's list, not in these.
 */

/** The tools that put a file in a turn's list. */
const FILE_TOOLS: Readonly<Record<string, true>> = { edit: true, write: true };
/** The longest label kept of a prompt. */
const LABEL_CHARS = 90;

export interface TurnFile {
	/** The file as omp wrote it (relative to its folder or absolute); for a moved file, where it went. */
	path: string;
	/** A moved file: where it was. */
	from?: string;
}

export interface TurnEdits {
	/** The entry the turn starts at: the prompt (or, for a conversation that does not start with one, the first row). */
	id: string;
	/** Which turn of the conversation it is, from 1 (turns that changed no file count too). */
	number: number;
	/** The first line of the prompt that began the turn. */
	label: string;
	files: TurnFile[];
}

/** The first non-empty line of a prompt's text, cut to a label. */
function labelOf(entry: SessionEntry): string {
	const m = messageOf(entry);
	if (!m) return "";
	const text = blocks(m)
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
	const line =
		text
			.split("\n")
			.map((l) => l.trim())
			.find(Boolean) ?? "";
	return line.length > LABEL_CHARS ? `${line.slice(0, LABEL_CHARS - 1)}…` : line;
}

/**
 * The turns of `entries` (a conversation's path, oldest first) that changed a file, oldest first. A prompt, or a command
 * the user ran, ends one turn and starts the next; a call whose result is missing (still running, or never answered) or is
 * an error is left out.
 */
export function turnEdits(entries: readonly SessionEntry[], results: ToolResults): TurnEdits[] {
	const out: TurnEdits[] = [];
	let turn: TurnEdits | null = null;
	let count = 0;
	for (const entry of entries) {
		const m = messageOf(entry);
		if (m && (isPrompt(m) || isUserCommand(m))) {
			turn = { id: entry.id, number: ++count, label: labelOf(entry), files: [] };
			out.push(turn);
			continue;
		}
		if (m?.role !== "assistant") continue;
		if (!turn) {
			turn = { id: entry.id, number: ++count, label: "", files: [] };
			out.push(turn);
		}
		for (const b of blocks(m)) {
			if (b.type !== "toolCall" || !b.id || !b.name || !FILE_TOOLS[b.name]) continue;
			const result = results.get(b.id);
			if (!result || result.isError) continue;
			for (const f of toolChanges(b.name, b.arguments, result.details).files) {
				if (!f.path) continue;
				const path = f.move ?? f.path;
				const known = turn.files.find((x) => x.path === path);
				if (known) continue;
				turn.files.push(f.move ? { path, from: f.path } : { path });
			}
		}
	}
	return out.filter((t) => t.files.length > 0);
}

/**
 * `path` as a path inside a folder, written with `/`: an absolute path under one of `roots` (the folder as the server
 * resolved it, and as omp knows it: they differ when a link is on the way), or a relative one that does not climb. Null for
 * a path that is somewhere else, or is the folder itself.
 */
export function relativeIn(roots: readonly string[], path: string): string | null {
	if (path.startsWith("/")) {
		for (const root of roots) {
			const base = root.endsWith("/") ? root.slice(0, -1) : root;
			if (base && path.startsWith(`${base}/`)) return relativeIn([], path.slice(base.length + 1));
		}
		return null;
	}
	const parts = path.split("/").filter((p) => p !== "" && p !== ".");
	if (parts.length === 0 || parts.includes("..") || path.startsWith("~")) return null;
	return parts.join("/");
}
