import { TRANSFER_LIMITS } from "@shared/transfer.ts";
import { create } from "zustand";
import { type MessageKey, t, type Vars } from "../i18n/index.ts";
import { useApp } from "../store/app.ts";
import { keyOf, refreshAll } from "../store/files.ts";
import { fmtBytes } from "./files-rows.ts";
import type { FolderScope } from "./folder-api.ts";
import { type RowError, UploadBatch, type UploadRow } from "./transfer-api.ts";
import { fromFileList, type Gathered, gatherTaken } from "./transfer-items.ts";
import { type Conflict, checkBatch, joinPath, type Resolution } from "./transfer-plan.ts";
import type { Taken } from "./transfer-take.ts";

/**
 * The uploads of each conversation, kept apart from the panel that shows them: closing the panel does not stop an upload,
 * and the conversation can be left and come back to find how it went. One batch per conversation; what is dropped or
 * picked while it runs is added to it.
 */

/** A line the list says of the whole upload (hidden items left out, a file that is too large…), as the words it is made of. */
export interface Note {
	key: MessageKey;
	vars?: Vars;
}

export interface Upload {
	rows: UploadRow[];
	notes: Note[];
	/** Files that wait for the person to say what to do about a file by the same name. */
	held: Conflict[];
	/** The refusal that stopped the batch (the setting changed since the page was told). */
	halted: RowError | null;
}

const EMPTY: Upload = { rows: [], notes: [], held: [], halted: null };

interface TransferStore {
	uploads: Record<string, Upload>;
}

export const useTransfers = create<TransferStore>(() => ({ uploads: {} }));

/** The upload of a conversation (never undefined: none is an empty one). */
export function useUpload(key: string): Upload {
	return useTransfers((s) => s.uploads[key]) ?? EMPTY;
}

/** Whether any file of an upload is being sent or waits for its turn. */
export const isBusy = (rows: readonly UploadRow[]): boolean =>
	rows.some((r) => r.state === "waiting" || r.state === "sending");

const batches = new Map<string, UploadBatch>();
/** The last summary told for a conversation, so that two batches that end together are not announced twice. */
const told = new Map<string, string>();

function put(key: string, change: Partial<Upload>): void {
	useTransfers.setState((s) => ({ uploads: { ...s.uploads, [key]: { ...(s.uploads[key] ?? EMPTY), ...change } } }));
}

function batchFor(scope: FolderScope): UploadBatch {
	const key = keyOf(scope);
	const have = batches.get(key);
	if (have) return have;
	const batch: UploadBatch = new UploadBatch(scope, (rows) =>
		put(key, { rows, held: batch.held(), halted: batch.halted }),
	);
	batches.set(key, batch);
	return batch;
}

/** What was sent, said once the batch has nothing left to do (and no file is held for a decision). */
function finished(scope: FolderScope, batch: UploadBatch): void {
	const key = keyOf(scope);
	if (batch.busy || batch.held().length > 0) return;
	const rows = batch.rows;
	const done = rows.filter((r) => r.state === "done").length;
	const failed = rows.filter((r) => r.state === "failed").length;
	// A file left out (by the person's choice) or cancelled is no part of what was to be sent.
	if (done + failed === 0) return;
	const text =
		failed > 0
			? t("files.transferDoneToastSome", { done, total: done + failed, failed })
			: t("files.transferDoneToast", { n: done });
	if (told.get(key) === text) return;
	told.set(key, text);
	useApp.getState().toast(failed > 0 ? "warning" : "success", text);
	// The server's watcher usually has told the tree already; this makes sure.
	void refreshAll(scope);
}

/**
 * Upload what was gathered into `target` (a folder relative to the conversation's folder; "" is that folder itself): what
 * the page will not send is said in notes (too many files, a file that is too large, hidden items left out), and the rest
 * is added to the conversation's batch.
 */
export function startUpload(scope: FolderScope, target: string, gathered: Gathered): void {
	const key = keyOf(scope);
	const notes: Note[] = [];
	if (gathered.hidden > 0) notes.push({ key: "files.transferNoteHidden", vars: { n: gathered.hidden } });
	if (gathered.tooMany) {
		notes.push({ key: "files.transferNoteTooMany", vars: { limit: TRANSFER_LIMITS.uploadFiles } });
		put(key, { notes });
		return;
	}
	const { send, tooLarge } = checkBatch(gathered.items);
	for (const big of tooLarge) {
		notes.push({
			key: "files.transferNoteTooLarge",
			vars: { name: big.name, size: fmtBytes(big.size), limit: fmtBytes(TRANSFER_LIMITS.uploadBytes) },
		});
	}
	if (send.length === 0 && tooLarge.length === 0) notes.push({ key: "files.transferNoteNothing" });
	put(key, { notes });
	if (send.length === 0) return;
	const batch = batchFor(scope);
	void batch
		.add(send.map((i) => ({ file: i.file, dir: joinPath(target, i.dir), name: i.name, size: i.size })))
		.then(() => finished(scope, batch));
}

/** Upload what a drop carried (the entries were taken while the drop was handled: `lib/transfer-take.ts`). */
export async function dropUpload(scope: FolderScope, target: string, taken: Taken): Promise<void> {
	startUpload(scope, target, await gatherTaken(taken));
}

/** Upload the files of a file input (a folder picker's files carry the folders they came in). */
export function pickUpload(scope: FolderScope, target: string, files: Iterable<File>): void {
	startUpload(scope, target, fromFileList(files));
}

/** The answer to the files that are held: both kept, replaced, or left out. */
export function resolveHeld(scope: FolderScope, choice: Resolution): void {
	const batch = batches.get(keyOf(scope));
	if (batch) void batch.resolve(choice).then(() => finished(scope, batch));
}

/** Stop one file (by its row's key), or all of them. */
export function cancelUpload(scope: FolderScope, rowKey?: number): void {
	batches.get(keyOf(scope))?.cancel(rowKey);
}

/** Forget how an upload went: its list and notes. An upload that is still running is left to run. */
export function clearUpload(scope: FolderScope): void {
	const key = keyOf(scope);
	const batch = batches.get(key);
	if (batch?.busy) return;
	batches.delete(key);
	told.delete(key);
	useTransfers.setState((s) => {
		const uploads = { ...s.uploads };
		delete uploads[key];
		return { uploads };
	});
}
