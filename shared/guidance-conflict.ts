/**
 * The guidance conflict check (v0.13.0): when the person saves a conversation's model guidance (or switches it to another
 * template), a small model reads the new text beside what omp also tells the agent in that conversation's folder — its
 * `AGENTS.md` and the other context files omp loads there — and what omp remembers for the project, and reports the
 * statements that contradict each other, each with a proposed change. The page shows them for review: nothing outside the
 * guidance text is written unless the person applies that one change (`server/omp/guidance/conflict-check.ts`).
 *
 * This module is the contract between the server and the page, and the two pure helpers both use: applying a proposed
 * change to a text (`applyChange`) and the line diff a proposal is shown as (`lineDiff`).
 */

/** The limits of one check: what is read of each source, of all of them, and how many conflicts an answer may hold. */
export const CONFLICT_LIMITS = {
	/** Characters of one context file that are put in the prompt; the rest is left out with a note. */
	fileChars: 12_000,
	/** Characters of all context files together. */
	filesChars: 30_000,
	/** The most memories read, the newest first. */
	memories: 40,
	/** Characters of one memory. */
	memoryChars: 600,
	/** Characters of all memories together. */
	memoriesChars: 8_000,
	/** The most conflicts taken from one answer. */
	conflicts: 8,
	/** Characters of a quote or a reason taken from an answer. */
	quoteChars: 600,
	/** The longest one check may take, every model it tries included (ms). */
	checkMs: 60_000,
} as const;

/** One thing the guidance was compared with. */
export interface ConflictSource {
	/** The id the prompt and the answer name it by (`f1`, `m3`). */
	id: string;
	kind: "file" | "memory";
	/** What the page calls it: a file's path (`~/…` under the home folder), a memory's first words. */
	label: string;
	/** A file in the conversation's folder or one above it (`project`), or one of the person's own (`user`). */
	level: "project" | "user";
	/**
	 * A file the Files tab may write: its path relative to the conversation's folder. Null for a file it may not (outside the
	 * folder, or where a save is refused), and for a memory: a change to it is never proposed.
	 */
	rel: string | null;
	/** A memory's bank and id (what `/api/memory/retire` takes). */
	bank?: string;
	memoryId?: string;
	/** Only the beginning of it was read (see `CONFLICT_LIMITS`). */
	truncated: boolean;
}

/** A line of a proposal's diff: kept, removed, added, or the lines left out between two changes (`gap`: how many). */
export type DiffLine = { kind: "same" | "del" | "add"; text: string } | { kind: "gap"; lines: number };

/** What a proposal changes: the guidance, a file of the folder, or a memory omp forgets (retired, not deleted). */
export type ConflictChange =
	| { target: "guidance"; find: string; replace: string; diff: DiffLine[] }
	| { target: "file"; source: string; rel: string; find: string; replace: string; diff: DiffLine[] }
	| { target: "memory"; source: string; bank: string; memoryId: string };

/** One contradiction: what the guidance says, what the source says, why they clash, and what would resolve it. */
export interface GuidanceConflict {
	guidance: string;
	source: string;
	other: string;
	why: string;
	/** Null: the checker proposed none that can be applied here (the person decides by hand). */
	change: ConflictChange | null;
}

/** Why a check gave no answer. The guidance is saved all the same. */
export type ConflictFailure = "noModel" | "timeout" | "model" | "malformed" | "folder";

/** What `POST /api/model-guidance/conflicts` answers. */
export type ConflictCheckResult =
	/** The check is turned off in Settings. */
	| { state: "off" }
	/** No guidance: nothing to check. */
	| { state: "empty" }
	/** Nothing to compare with: no context file, no memory. */
	| { state: "nothing"; sources: ConflictSource[] }
	| { state: "clear"; sources: ConflictSource[]; model: string; cached: boolean }
	| { state: "found"; sources: ConflictSource[]; conflicts: GuidanceConflict[]; model: string; cached: boolean }
	| { state: "failed"; reason: ConflictFailure; detail?: string };

/** How many times `find` is in `text` (stops counting at 2). */
function occurrences(text: string, find: string): number {
	const first = text.indexOf(find);
	if (first < 0) return 0;
	return text.indexOf(find, first + 1) < 0 ? 1 : 2;
}

/**
 * `text` with its one occurrence of `find` replaced by `replace`; null when `find` is empty, absent, or there more than
 * once (the proposal no longer says which part it changes: the text changed since the check).
 */
export function applyChange(text: string, find: string, replace: string): string | null {
	if (!find || occurrences(text, find) !== 1) return null;
	const at = text.indexOf(find);
	return text.slice(0, at) + replace + text.slice(at + find.length);
}

/**
 * The lines that differ between `before` and `after`, with `context` unchanged lines around each change and a `gap` for
 * the ones between. The lines both share at either end are matched first, so a change to one part of a long file costs
 * only that part; what is left is matched by a longest common subsequence (bounded: past `MAX_MIDDLE` lines each, it is
 * shown as all removed and all added).
 */
export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
	const a = before.split("\n");
	const b = after.split("\n");
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const middle = middleDiff(a.slice(start, endA), b.slice(start, endB));
	if (middle.length === 0) return [];
	const lines: DiffLine[] = [
		...a.slice(0, start).map((text) => ({ kind: "same" as const, text })),
		...middle,
		...a.slice(endA).map((text) => ({ kind: "same" as const, text })),
	];
	// Keep `context` kept lines around each change; fold the others into gaps.
	const near = lines.map(() => false);
	lines.forEach((line, i) => {
		if (line.kind === "same") return;
		for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) near[j] = true;
	});
	const out: DiffLine[] = [];
	let folded = 0;
	lines.forEach((line, i) => {
		if (near[i]) {
			if (folded > 0) out.push({ kind: "gap", lines: folded });
			folded = 0;
			out.push(line);
		} else folded++;
	});
	if (folded > 0) out.push({ kind: "gap", lines: folded });
	return out;
}

const MAX_MIDDLE = 400;

function middleDiff(a: string[], b: string[]): DiffLine[] {
	if (a.length === 0) return b.map((text) => ({ kind: "add", text }));
	if (b.length === 0) return a.map((text) => ({ kind: "del", text }));
	if (a.length > MAX_MIDDLE || b.length > MAX_MIDDLE)
		return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
	// lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
	const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push({ kind: "same", text: a[i] });
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: "del", text: a[i++] });
		else out.push({ kind: "add", text: b[j++] });
	}
	while (i < a.length) out.push({ kind: "del", text: a[i++] });
	while (j < b.length) out.push({ kind: "add", text: b[j++] });
	return out;
}
