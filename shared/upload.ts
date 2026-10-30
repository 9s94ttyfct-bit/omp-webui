/**
 * Uploading a file into the folder a conversation works in (#617), for a page that cannot tell the server where a file is
 * on its own computer: any page but the macOS app's window, which is handed the real path by the shell.
 *
 * The page names the conversation (`live`, `file`), never a folder, and the server writes only below `UPLOAD_DIR` in that
 * conversation's folder: `.omp-webui/uploads/<date>/<name>`. Nothing is overwritten (a taken name gets ` (1)`, ` (2)` …),
 * a file or the folder of uploads over its limit is refused, and a link in the way is not followed. Uploads into one folder
 * are taken one at a time, so that the limit of the folder holds however many are sent at once. The folder carries a
 * `.gitignore` of its own, so uploads never show as changes in a repository. A conversation whose `.omp-webui` is a folder
 * an omp-webui keeps its own data in (the app's, the web version's, this server's) gets no uploads.
 */

/** Where uploads go, relative to the conversation's folder. */
export const UPLOAD_DIR = ".omp-webui/uploads";

const MiB = 1024 * 1024;

export const UPLOAD_LIMITS = {
	/** One file. */
	fileBytes: 50 * MiB,
	/** Everything under `UPLOAD_DIR` of one folder, so that a page cannot fill the disk one allowed file at a time. */
	folderBytes: 500 * MiB,
	/** Files in one drop: more is a folder's worth, which is not what a drop is for. */
	perDrop: 20,
	/** The most entries (files and folders) the folder of uploads may hold: the server adds them up, and counts no further than this. */
	counted: 20_000,
} as const;

/** Why an upload was refused; the page words it in its own language. */
export type UploadCode =
	| "unknownConversation"
	| "folderGone"
	| "tooLarge"
	| "quota"
	| "tooMany"
	| "ownData"
	/** Uploads from a page that is not this computer's are switched off on this computer (Settings › Remote access). */
	| "off"
	| "refused"
	| "stalled"
	| "badRequest"
	| "write";

/** What an upload answers: where the file is now. */
export interface UploadResult {
	/** The file's absolute path on the machine the server runs on. */
	path: string;
	/** The name it was saved under: the one it came with, tidied, and numbered when that was taken. */
	name: string;
	bytes: number;
}

/** The failure body of an upload: the English sentence, and the code the page words. */
export interface UploadFailure {
	error: string;
	code: UploadCode;
	/** The limit that was passed: bytes for `tooLarge` and `quota`, entries for `tooMany`. */
	limit?: number;
}
