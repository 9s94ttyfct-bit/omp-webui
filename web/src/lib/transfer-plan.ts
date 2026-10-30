import { type ExistsFailure, TRANSFER_LIMITS } from "@shared/transfer.ts";

/**
 * The decisions of an upload that need no network and no page (#614): how a file is cut into pieces, when a failed piece is
 * sent again and after how long, what a batch may hold, and what each answer of the conflict dialog does. Pure, so that
 * they are tested on their own (`tests/unit/transfer-plan.test.ts`); `lib/transfer-api.ts` does the sending.
 */

/** How many times one request is tried in all (the first and the sends again). */
export const MAX_TRIES = 5;

/** The longest the page waits before it sends a piece again, whatever the server asked for. */
const MAX_WAIT_MS = 30_000;

/** The next piece of a file of `size` bytes of which the server holds `received`: `[offset, end)`. An empty file is one piece with no bytes. */
export function nextPiece(
	received: number,
	size: number,
	pieceBytes: number = TRANSFER_LIMITS.pieceBytes,
): { offset: number; end: number } {
	const offset = Math.max(0, Math.min(received, size));
	return { offset, end: Math.min(size, offset + pieceBytes) };
}

/** How many requests a file of `size` bytes takes when nothing goes wrong. */
export function pieceCount(size: number, pieceBytes: number = TRANSFER_LIMITS.pieceBytes): number {
	return Math.max(1, Math.ceil(size / pieceBytes));
}

/** How long to wait before try number `failures + 1`: 0.5 s, 1 s, 2 s, 4 s…, or what `Retry-After` asked, whichever is longer. */
export function backoffMs(failures: number, retryAfterMs = 0): number {
	const own = 500 * 2 ** Math.max(0, failures - 1);
	return Math.min(MAX_WAIT_MS, Math.max(own, retryAfterMs));
}

/**
 * Whether a piece that failed is sent again: no answer at all (`status` 0), the body stopped arriving (408), the server is
 * busy (429) or failed on its own (5xx). A full disk (507) does not get better by waiting.
 */
export function isRetryable(status: number): boolean {
	if (status === 0 || status === 408 || status === 429) return true;
	return status >= 500 && status !== 507;
}

/** What `Retry-After` says, in ms: seconds as a number (a date is not used). */
export function retryAfterMs(header: string | null): number {
	if (!header) return 0;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

/** What a batch is made of, checked before anything is sent. */
export function checkBatch<T extends { size: number }>(
	items: readonly T[],
): { send: T[]; tooLarge: T[]; tooMany: boolean } {
	if (items.length > TRANSFER_LIMITS.uploadFiles) return { send: [], tooLarge: [], tooMany: true };
	const send: T[] = [];
	const tooLarge: T[] = [];
	for (const item of items) (item.size > TRANSFER_LIMITS.uploadBytes ? tooLarge : send).push(item);
	return { send, tooLarge, tooMany: false };
}

/** What the person answers to files that are already there: both are kept, they are replaced, or the new ones are left out. */
export type Resolution = "keep" | "replace" | "skip";

/** A file the server held back because one by that name is there (`409 exists`). */
export interface Conflict {
	key: number;
	failure: Pick<ExistsFailure, "suggestion" | "existing">;
}

/** How one held-back file is sent again: under a free name, or in place of the one that is there (only while it is still that file). */
export type Resend = { key: number; exists: "keep" } | { key: number; replace: string };

export interface ConflictPlan {
	resend: Resend[];
	/** Left out on purpose (Skip). */
	skipped: number[];
	/** Replace was chosen and the file there may not be replaced (a program, a link): the conflict stands, nothing is sent. */
	refused: number[];
}

/** What one answer does with the files of a batch that were held back. */
export function conflictPlan(conflicts: readonly Conflict[], choice: Resolution): ConflictPlan {
	const plan: ConflictPlan = { resend: [], skipped: [], refused: [] };
	for (const c of conflicts) {
		if (choice === "skip") plan.skipped.push(c.key);
		else if (choice === "keep") plan.resend.push({ key: c.key, exists: "keep" });
		else if (c.failure.existing.replaceable) plan.resend.push({ key: c.key, replace: c.failure.existing.etag });
		else plan.refused.push(c.key);
	}
	return plan;
}

/** Replace can be offered for the whole batch, for part of it, or not at all. */
export function replaceable(conflicts: readonly Conflict[]): "all" | "some" | "none" {
	const n = conflicts.filter((c) => c.failure.existing.replaceable).length;
	return n === 0 ? "none" : n === conflicts.length ? "all" : "some";
}

/** The parent of a path relative to the conversation's folder ("" for one at the top). */
export const parentPath = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** The last segment of a path. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** `dir/name`, where an empty `dir` is the conversation's folder. */
export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/**
 * The folder an upload goes to when nothing says otherwise: the folder of the row that holds the tree's focus (the row itself
 * when it is a folder, the one around it when it is a file) and the conversation's own folder when no row does.
 * `isFolder` says whether a path of the tree is one.
 */
export function targetFolder(focused: string | null, isFolder: (path: string) => boolean): string {
	if (!focused) return "";
	return isFolder(focused) ? focused : parentPath(focused);
}

/**
 * What a person typed for "download by path", as a path inside the conversation's folder; null when it is none: empty, absolute,
 * starting from the home folder, or one that climbs out with `..`. (The server refuses those too: this is the words before the trip.)
 */
export function typedPath(text: string): string | null {
	let path = text.trim().replace(/\\/g, "/");
	while (path.startsWith("./")) path = path.slice(2);
	path = path.replace(/\/+$/, "");
	if (!path || path === "." || path.startsWith("/") || path.startsWith("~")) return null;
	const parts = path.split("/");
	if (parts.some((p) => p === "" || p === "..")) return null;
	return parts.join("/");
}

/** How far a set of files has got. */
export interface Progress {
	files: number;
	done: number;
	failed: number;
	bytes: number;
	sent: number;
}

/** A row of the results list, as much of it as the count needs. */
interface Counted {
	state: "waiting" | "sending" | "held" | "done" | "failed" | "skipped" | "cancelled";
	size: number;
	sent: number;
}

/** The overall line: how many files are finished, how many failed, and how many bytes have gone. */
export function progressOf(rows: readonly Counted[]): Progress {
	const out: Progress = { files: rows.length, done: 0, failed: 0, bytes: 0, sent: 0 };
	for (const row of rows) {
		out.bytes += row.size;
		out.sent += row.state === "done" ? row.size : Math.min(row.sent, row.size);
		if (row.state === "done") out.done++;
		else if (row.state === "failed") out.failed++;
	}
	return out;
}

/** Whether a row is finished, for one way or another. */
export const isFinished = (state: Counted["state"]): boolean =>
	state === "done" || state === "failed" || state === "skipped" || state === "cancelled";
