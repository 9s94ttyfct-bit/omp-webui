/**
 * Moving files between this computer and a page that is not on it (#614, step two): downloading a file or a folder
 * (as a ZIP) out of the folder a conversation works in, and uploading files and folders into it. The server's side is
 * `server/folder-transfer.ts` (routes under `/api/folder/`), the page's is the Files tab.
 *
 * Every request names the conversation (`live` and/or `file`) and a path *inside its folder*, never a folder: the server
 * looks the folder up, resolves each path against its real location and refuses what leaves it (`..`, an absolute path, a
 * link that leads out). What a page that is not this computer's may touch is decided by the person on this computer
 * (`FileTransfer`, a setting only this computer changes: `/api/remote/config` answers a remote page 403).
 *
 *   GET|HEAD /api/folder/download?live&file&path      a file's bytes, as an attachment; `Range` and `If-Range` resume it
 *   POST     /api/folder/archive   {live?, file?, path, hidden?}   what a folder's ZIP holds (`ArchivePlan`) and a ticket for it
 *   GET      /api/folder/archive/<ticket>                 the ZIP, streamed, once
 *   POST     /api/folder/upload?live&file&dir&name&size[&id&offset][&exists=keep][&replace=<etag>]   body: bytes
 *   GET      /api/folder/upload/state?id                  how much of a file arrived (`UploadProgress`)
 *   POST     /api/folder/upload/cancel   {id}             the file is given up and what arrived is removed
 *
 * A failure is `{ error: <English sentence>, code?: TransferCode, ...}` with the status below; a page words the codes it
 * knows in its own language and shows the sentence for the others. A refused `HEAD` has no body, so every failure also
 * carries its code in the `ERROR_HEADER` response header (a page checks a download with a `HEAD` before it starts one).
 */

/** What a page that is not this computer's may do with files: nothing, download only, or download and upload. */
export type FileTransfer = "off" | "download" | "full";

export const FILE_TRANSFERS: readonly FileTransfer[] = ["off", "download", "full"];

/** Upload is on unless the person turns it off (their choice, #614). */
export const DEFAULT_FILE_TRANSFER: FileTransfer = "full";

export const isFileTransfer = (value: unknown): value is FileTransfer =>
	typeof value === "string" && (FILE_TRANSFERS as readonly string[]).includes(value);

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const TRANSFER_LIMITS = {
	/** One uploaded file. */
	uploadBytes: 2 * GiB,
	/**
	 * What a page sends in one request of an upload: a file bigger than this goes in pieces (Cloudflare takes 100 MB at most
	 * per request on the plans most people have, and a piece that fails is sent again, not the whole file).
	 */
	pieceBytes: 8 * MiB,
	/** What the server takes in one request: more is refused (413). */
	pieceMax: 16 * MiB,
	/** The most files the page puts in one upload (a folder dropped on it); the server has no say in this one. */
	uploadFiles: 5000,
	/** What a folder's ZIP may hold: more files, or more bytes before compressing, is refused with the plan counted so far (413). */
	archiveFiles: 50_000,
	archiveBytes: 2 * GiB,
	/** How long a ticket for a ZIP is good for, in ms. */
	ticketMs: 5 * 60_000,
	/** How long an upload that is not finished waits for its next piece before it is given up, in ms. */
	idleMs: 30 * 60_000,
} as const;

/** Why a transfer was refused or failed (the HTTP status is with each). */
export type TransferCode =
	/** 403: the setting on this computer says no downloads (`off`), or no uploads (`uploadOff`). */
	| "off"
	| "uploadOff"
	/** 403: outside the conversation's folder (`..`, an absolute path, a link that leads out). */
	| "outside"
	/** 403: a name that looks like a secret (`.env`, a key, credentials). */
	| "secret"
	/** 403: hidden (a dotfile, a dependency or build folder) as the name of an uploaded file or folder; for downloads only when the conversation's folder is the home folder. */
	| "hidden"
	/** 403: a place nothing is changed or carried out of unasked: `.ssh`, `.aws`, `.omp`, the app's data, launch agents, shell start-up files; for uploads also what CI runs on a push (`.github/workflows`, `.github/actions`). */
	| "protected"
	/** 403: uploads into the home folder (or one that holds it) are not made. */
	| "homeFolder"
	/** 403: the folder is one an omp-webui keeps its own data in. */
	| "ownData"
	/** 403: a link or a file where a folder of the path should be; an executable file is never replaced. */
	| "refused"
	/** 400: not a name a file or folder can have here (empty, `.`/`..`, a name `safeName` would change in a folder part). */
	| "badName"
	/** 400: not a usable request. */
	| "badRequest"
	/** 404: the conversation, the folder or the file is not there. */
	| "notFound"
	/** 404: the upload is not known (finished, cancelled, expired, or the server restarted): send the file again from its start. */
	| "gone"
	/** 415: a download of a folder (use its ZIP), or of something that is not a regular file. */
	| "notFile"
	/** 400: a ZIP of something that is not a folder. */
	| "notFolder"
	/** 409: a file by that name is there (see `ExistsFailure`). */
	| "exists"
	/** 409: a piece does not begin where the file stopped (see `OffsetFailure`). */
	| "offset"
	/** 412: the file to replace is not the one the page saw. */
	| "changed"
	/** 409: a save (`POST /api/folder/file`) was made from a version of the file that is no longer the one on disk (see `EditConflict`). */
	| "conflict"
	/** 415: a save into a file that is not UTF-8 text (a binary file, or text in another encoding): it is not rewritten. */
	| "notText"
	/** 413: over a limit (`limit` says which one, in bytes or files). */
	| "tooLarge"
	| "tooMany"
	/** 429: too many transfers at once: try again after `Retry-After`. */
	| "busy"
	/** 507: not enough room on the disk. */
	| "diskFull"
	/** 408: the body stopped arriving. */
	| "stalled"
	/** 500: the system said no. */
	| "write";

/** The body of a failed transfer request. */
export interface TransferFailure {
	error: string;
	code?: TransferCode;
	/** The limit that was passed: bytes, or files for `tooMany`. */
	limit?: number;
}

/** What a failed piece or upload says when a file is already there (409 `exists`). */
export interface ExistsFailure extends TransferFailure {
	code: "exists";
	/** The name that is free: `report (2).pdf`. Sending the file again with `exists=keep` saves it under this one (or the next that is free). */
	suggestion: string;
	/** What is there now: replace it by sending `replace=<etag>` with this etag, and it is replaced only if it is still this file. */
	existing: { size: number; modified: number; etag: string; replaceable: boolean };
}

/** 409 `conflict`: the file is not the one the save was made from; `etag` is the one it is now (saving again with it overwrites what is there). */
export interface EditConflict extends TransferFailure {
	code: "conflict";
	etag: string;
}

/** 409 `offset`: the piece began somewhere else than where the file stopped. */
export interface OffsetFailure extends TransferFailure {
	code: "offset";
	received: number;
}

/** The body of `POST /api/folder/archive`. */
export interface ArchiveRequest {
	live?: string;
	file?: string;
	/** The folder to pack, relative to the conversation's folder; "" is that folder itself. */
	path: string;
	/**
	 * Include what is hidden by default (dotfiles, dependency and build folders) below the folder. Off unless asked, and
	 * ignored (as if off) where `ArchivePlan.hiddenAllowed` is false. The folder asked for may itself be one of those
	 * (`dist`, `node_modules`): what is judged is what is *below* it.
	 */
	hidden?: boolean;
}

/** What a folder's ZIP will hold, found before anything is streamed (`POST /api/folder/archive`). */
export interface ArchivePlan {
	/** Asked for with `GET /api/folder/archive/<ticket>`, once, within `TRANSFER_LIMITS.ticketMs`. */
	ticket: string;
	url: string;
	/** The ZIP's file name: `<folder>.zip`. */
	name: string;
	files: number;
	/** The files' bytes before compressing. */
	bytes: number;
	/** What was left out, and why. */
	skipped: ArchiveSkipped;
	/** When the ticket stops being good, in ms since the epoch. */
	expires: number;
	/** Whether this page may ask for the hidden things at all: false when the conversation's folder is the home folder, where a page is shown what its Files tab shows and no more. */
	hiddenAllowed: boolean;
	/** Whether the plan (and the ZIP) include them: what was asked for and allowed. */
	hidden: boolean;
}

export interface ArchiveSkipped {
	/** Files that look like secrets (by name, or a private key inside), and what is in a protected place. */
	secret: number;
	/** Links (a link to a folder, one that leads out of the folder or nowhere). */
	links: number;
	/** Sockets, pipes, devices, and what cannot be read. */
	special: number;
	/** Names a ZIP cannot hold (a backslash, a control character, one that is too long). */
	name: number;
	/** Hidden things (dotfiles, dependency and build folders) below the folder that were left out: all of them unless `ArchivePlan.hidden`. */
	hidden: number;
}

/** 413 on `POST /api/folder/archive`: what the walk counted before it passed a limit. */
export interface ArchiveTooLarge extends TransferFailure {
	code: "tooLarge" | "tooMany";
	counted: { files: number; bytes: number };
}

/** Where an upload stands: the answer to a piece that did not finish the file, and to `upload/state`. */
export interface UploadProgress {
	id: string;
	/** Bytes the server holds so far: the next piece begins here. */
	received: number;
	size: number;
}

/** The answer to the piece that finished a file. */
export interface UploadSaved {
	done: true;
	/** Where it is, relative to the conversation's folder (`sub/report (2).pdf`). */
	path: string;
	/** The name it was saved under: the one it came with, tidied, and numbered when `exists=keep` found it taken. */
	name: string;
	bytes: number;
	/** SHA-256 of what was saved (also in the audit log). */
	sha256: string;
	/** Another file was replaced (`replace=<etag>`). */
	replaced: boolean;
}

/** What `GET /api/folder/download`, the ZIP, an upload and a save into a file (`POST /api/folder/file`) are logged as, in `<data dir>/transfers.jsonl`. */
export type TransferKind = "download" | "zip" | "upload" | "edit";

/** A line of the audit log. No query string, no token: who, what, how it ended. */
export interface TransferRecord {
	/** ISO time the transfer ended (or was refused). */
	t: string;
	kind: TransferKind;
	/** The Access email of a page that came through the tunnel, `local`, or `net:<address>` for a page on the network. */
	who: string;
	/**
	 * The conversation's folder (its real path) and the path of the file or folder in it. For an upload, the file as it was
	 * saved: one kept beside a file by the same name is logged under the name it was kept as.
	 */
	root: string;
	path: string;
	size?: number;
	files?: number;
	sha256?: string;
	/** An upload put the file in the place of one that was there (the person chose Replace for the file they had seen). */
	replaced?: boolean;
	/** `ok`, `refused:<code>`, `aborted` (the page stopped, or the connection dropped), `expired` (the Access session ended mid-transfer), `failed`. */
	status: string;
	/** How long it took, in ms. */
	ms: number;
}

/**
 * Names the page leaves out of a folder it uploads (and the server refuses to put in a folder): a dotfile or dot folder, a
 * dependency or build folder. The same rule as the Files tab's `hiddenByDefault` (`server/files.ts`; a test holds the two
 * together), kept here because the page needs it before it sends anything.
 */
const HIDDEN_DIRS: readonly string[] = ["node_modules", "__pycache__", "dist", "build", "target"];
export function isHiddenName(name: string, isDirectory: boolean): boolean {
	if (name.startsWith(".")) return !(isDirectory && name === ".github");
	return isDirectory && HIDDEN_DIRS.includes(name);
}

/** The header the page sends with every piece that is not a GET (the server asks it of every write). */
export const CSRF_HEADER = "x-omp-webui";

/** The response header that carries a failure's `TransferCode` (a `HEAD` answer has no body to carry it). */
export const ERROR_HEADER = "x-omp-webui-error";
