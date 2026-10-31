import type { DiffHunk, DiffRow, FileDiff } from "@shared/changes.ts";
import type { FolderFile } from "@shared/folder.ts";

/**
 * What the Markdown editor (`components/md/MdEditor.tsx`) does when the file it holds may have changed on the computer: pure,
 * so that it is tested without a page. The editor keeps the `etag` (SHA-256 of the bytes) of what its text was made from; it
 * looks at the file again now and then and before it saves, and a save names that etag, so the server refuses (409) a file
 * that is no longer it. Nothing here ever writes over a file the person has not seen.
 */

type TextFile = Extract<FolderFile, { kind: "text" }>;

/** What the editor shows about the file on the computer. */
export type DiskState =
	/** The file is the one the text was made from. */
	| { kind: "same" }
	/**
	 * It changed, and nothing typed would be lost: take what is there (the editor says it did). A file that can no longer be
	 * saved from here (cut at the read limit, or refused) is then shown read only.
	 */
	| { kind: "reload"; file: TextFile }
	/**
	 * It changed and there is text that is not saved: ask (Reload, Overwrite, Show diff). `etag` is the file's now, which an
	 * Overwrite names (the server writes only over that one); `text` is what is there, for the diff (null when it cannot be
	 * shown: cut at the read limit).
	 */
	| { kind: "conflict"; etag: string; text: string | null }
	/** The file is gone (deleted or moved): a save makes no file, so there is nothing to offer but to copy the text. */
	| { kind: "gone" }
	/** It is there, but no longer text (it became binary, an image…): nothing to reload into the editor. */
	| { kind: "unusable" };

/**
 * Judge a look at the file on the computer against what the text was made from. `disk` is null when the file is not there
 * any more. `dirty` is whether the text differs from what it was made from.
 */
export function judgeDisk(baseEtag: string, dirty: boolean, disk: FolderFile | null): DiskState {
	if (disk === null) return { kind: "gone" };
	if (disk.kind !== "text") return { kind: "unusable" };
	if (disk.etag === baseEtag) return { kind: "same" };
	if (!dirty) return { kind: "reload", file: disk };
	return { kind: "conflict", etag: disk.etag, text: disk.truncated ? null : disk.text };
}

/**
 * The next state after a check, given the one shown: a conflict already on screen is kept as long as the file has not changed
 * again (the person is reading it), and replaced when it has (an Overwrite must name the file's newest etag).
 */
export function nextDiskState(shown: DiskState, judged: DiskState): DiskState {
	if (shown.kind === "conflict" && judged.kind === "conflict" && shown.etag === judged.etag) return shown;
	return judged;
}

/** Lines of context kept round a change in the diff, as the Changes view has. */
const CONTEXT = 3;
/** Above this many cells (lines × lines of what differs), the middle is shown as all removed and all added. */
const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
	const lines = text.split(/\r?\n/);
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	return lines;
}

/** The rows that turn `a` into `b`, by the longest common subsequence of their lines (both are a few thousand lines at most). */
function rowsOf(a: string[], b: string[]): DiffRow[] {
	// What both start and end with is context, whatever lies between.
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	const rows: DiffRow[] = [];
	for (let i = 0; i < head; i++) rows.push({ kind: "ctx", old: i + 1, new: i + 1, text: a[i] ?? "" });
	const midA = a.slice(head, a.length - tail);
	const midB = b.slice(head, b.length - tail);
	const n = midA.length;
	const m = midB.length;
	if (n * m > MAX_CELLS) {
		for (const [i, text] of midA.entries()) rows.push({ kind: "del", old: head + i + 1, text });
		for (const [j, text] of midB.entries()) rows.push({ kind: "add", new: head + j + 1, text });
	} else {
		// lcs[i][j]: the common subsequence of midA[i..] and midB[j..], one row of m + 1 per line of midA.
		const lcs = new Uint32Array((n + 1) * (m + 1));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				lcs[i * (m + 1) + j] =
					midA[i] === midB[j]
						? (lcs[(i + 1) * (m + 1) + j + 1] ?? 0) + 1
						: Math.max(lcs[(i + 1) * (m + 1) + j] ?? 0, lcs[i * (m + 1) + j + 1] ?? 0);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && midA[i] === midB[j]) {
				rows.push({ kind: "ctx", old: head + i + 1, new: head + j + 1, text: midA[i] ?? "" });
				i++;
				j++;
				// On a tie the removed line comes first, as git writes a change.
			} else if (j < m && (i === n || (lcs[i * (m + 1) + j + 1] ?? 0) > (lcs[(i + 1) * (m + 1) + j] ?? 0))) {
				rows.push({ kind: "add", new: head + j + 1, text: midB[j] ?? "" });
				j++;
			} else {
				rows.push({ kind: "del", old: head + i + 1, text: midA[i] ?? "" });
				i++;
			}
		}
	}
	const offA = a.length - tail;
	const offB = b.length - tail;
	for (let k = 0; k < tail; k++)
		rows.push({ kind: "ctx", old: offA + k + 1, new: offB + k + 1, text: a[offA + k] ?? "" });
	return rows;
}

/** Rows cut into hunks with `CONTEXT` lines round each change, as git makes them. */
function hunksOf(rows: DiffRow[]): DiffHunk[] {
	const keep = rows.map(() => false);
	for (const [i, row] of rows.entries()) {
		if (row.kind === "ctx") continue;
		for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) keep[k] = true;
	}
	const hunks: DiffHunk[] = [];
	let cur: DiffRow[] | null = null;
	for (const [i, row] of rows.entries()) {
		if (!keep[i]) {
			cur = null;
			continue;
		}
		if (cur === null) {
			cur = [];
			hunks.push({ oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, section: "", rows: cur });
		}
		cur.push(row);
	}
	for (const hunk of hunks) {
		const olds = hunk.rows.filter((r) => r.kind !== "add");
		const news = hunk.rows.filter((r) => r.kind !== "del");
		hunk.oldLines = olds.length;
		hunk.newLines = news.length;
		hunk.oldStart = olds[0]?.old ?? Math.max(0, (news[0]?.new ?? 1) - 1);
		hunk.newStart = news[0]?.new ?? Math.max(0, (olds[0]?.old ?? 1) - 1);
	}
	return hunks;
}

/**
 * How the text being edited (`mine`) differs from the file on the computer (`disk`), as the Changes view draws a file's
 * change: the file is the old side, the editor's text the new one.
 */
export function conflictDiff(path: string, disk: string, mine: string): FileDiff {
	const rows = rowsOf(splitLines(disk), splitLines(mine));
	const hunks = hunksOf(rows);
	return {
		path,
		state: "modified",
		view: hunks.length > 0 ? "text" : "empty",
		hunks,
		added: rows.filter((r) => r.kind === "add").length,
		removed: rows.filter((r) => r.kind === "del").length,
		truncated: false,
	};
}
