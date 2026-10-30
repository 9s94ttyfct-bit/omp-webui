/**
 * The Files tab of the side panel: what the server tells the page about the folder a conversation works in
 * (`/api/folder/*`, see server/folder.ts). Every path in it is relative to that folder, written with `/`, and never
 * leaves it: the server resolves each one against the real folder and refuses what falls outside.
 */

/** How a file differs from the repository's last commit. */
export type GitMark = "modified" | "added" | "untracked" | "conflict";

export interface FolderEntry {
	name: string;
	kind: "dir" | "file";
	/**
	 * A symbolic link. `in`: it leads to something inside the folder and is shown (and opened) as that. `out`: it leads
	 * outside the folder (or nowhere): it is listed, never followed and never opened.
	 */
	link?: "in" | "out";
	/** A file's mark; a folder is `changed` when something below it differs. Absent: unchanged, or not a repository. */
	git?: GitMark | "changed";
	/** Only listed because the page asked for everything: a dotfile, a dependency or build folder, or something `.gitignore` names. */
	hidden?: true;
}

export interface FolderListing {
	/** The conversation's folder, as the server resolved it (no link left in it): what a page shows and copies as the path. */
	root: string;
	/** The folder listed, relative to the conversation's (empty for that folder itself). */
	path: string;
	/** Folders first, then files, each by name (numbers by value: `file2` before `file10`). */
	entries: FolderEntry[];
	/** How many entries are left out because they are hidden by default. Zero when everything was asked for. */
	hiddenCount: number;
	/** The folder holds more than `FOLDER_LIMITS.listEntries`: only the first of them are listed. */
	truncated: boolean;
	/** Whether the folder is in a repository that was looked at, so that `git` marks are in the answer. */
	git: boolean;
	/**
	 * The page is not this computer's: nothing hidden by default is listed whatever it asks, and what looks like a secret
	 * (environment files, keys, credentials) is neither listed nor readable.
	 */
	guarded?: true;
	/**
	 * This page may ask the server to open the folder (and the folders in it) in Finder: a page on this Mac, the server on
	 * macOS. Absent otherwise: nothing for the page to offer.
	 */
	local?: true;
}

export interface FolderMatch {
	path: string;
	git?: GitMark;
}

export interface FolderFound {
	/** Best matches first. */
	matches: FolderMatch[];
	/** More files matched than `FOLDER_LIMITS.matches`. */
	truncated: boolean;
	/** The walk of the folder ended at its limits (see server/files.ts): files deeper in may be missing from the matches. */
	partial: boolean;
}

/** What a file opens as in the panel. */
export type FolderView = "code" | "markdown" | "svg";

interface FolderFileBase {
	path: string;
	/** Size in bytes. */
	size: number;
	/** When the file last changed, in ms: a page tells whether what it shows is still the file. */
	modified: number;
	/** Whether this page may ask the server to open the file in its default app and show it in Finder (a page on this Mac). */
	local: boolean;
}

export type FolderFile =
	| (FolderFileBase & {
			kind: "text";
			/** The file's text; only its first `FOLDER_LIMITS.textBytes` bytes when `truncated`. */
			text: string;
			truncated: boolean;
			view: FolderView;
			/**
			 * What the bytes read were: their SHA-256 (hex). It changes whenever the content does and never otherwise (a file
			 * touched with the same text has the same one), so a save names the one it was made from and the server can tell
			 * that the file is no longer it (`FolderSaveRequest.etag`).
			 */
			etag: string;
			/**
			 * The text can be offered for editing: the file is whole (not cut at the limit) and is UTF-8 text that
			 * saves back byte for byte, and, where the server can tell, nothing about its place or this page refuses a write
			 * (`POST /api/folder/file`, which asks it all again). Never the whole answer to whether a page may edit: see
			 * `FileTransfer`.
			 */
			editable: boolean;
	  })
	| (FolderFileBase & { kind: "image"; mime: string })
	/** A PDF or a Word (`.docx`) document, which the large view draws or reads (the page fetches its bytes: `GET /api/folder/doc`). */
	| (FolderFileBase & { kind: "document"; type: FolderDocument })
	/** Not text (or an image or a document too large to show): the panel names its size and offers the actions. */
	| (FolderFileBase & { kind: "binary" });

/** The body of `POST /api/folder/file`: the whole new text of a file of the conversation's folder, as the person left it. */
export interface FolderSaveRequest {
	/** The conversation, as for every request of the Files tab (the page never names the folder). */
	live?: string;
	file?: string;
	/** The file, relative to the conversation's folder: one that is there (a save makes no file). */
	path: string;
	/** The text, at most `FOLDER_LIMITS.editBytes` of UTF-8. A file that began with a byte order mark keeps it. */
	text: string;
	/** The `etag` of the file the text was made from; a file that is no longer that one is refused with 409. */
	etag: string;
}

/** The answer of a save: what the file is now. */
export interface FolderSaved {
	/** The `etag` of what was written: the next save of the same text names it. */
	etag: string;
	size: number;
	modified: number;
}

export const FOLDER_LIMITS = {
	/** Entries listed for one folder. */
	listEntries: 5000,
	/** Matches the filter returns. */
	matches: 200,
	/** Bytes of a text file shown; the rest is cut (the preview says so). */
	textBytes: 1024 * 1024,
	/** The most text the page saves into a file, and the largest file it offers to edit: a file cut at `textBytes` is not edited. */
	editBytes: 1024 * 1024,
	/** The largest image the panel shows. */
	imageBytes: 25 * 1024 * 1024,
	/** The largest PDF or Word document the Files tab shows (the page reads it whole into memory). */
	documentBytes: 25 * 1024 * 1024,
	/** Folders the server watches for one page. */
	watchedDirs: 64,
} as const;

/** What the page tells the server it is showing, so that it hears of changes: replaces any earlier set. */
export interface FolderWatchRequest {
	live?: string;
	file?: string;
	/** The folders (relative paths; "" is the root) that are expanded. */
	dirs: string[];
}

/** The text of a mention of `path` in a prompt: `@path`, quoted when it holds a space. */
export function mentionOf(path: string): string {
	return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/** The image types the panel shows (by extension), and what they are served as. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
};

/** The documents the Files tab draws, and a message can carry (#697): a PDF, and a Word document of the `.docx` kind (not the older `.doc`). */
export type FolderDocument = "pdf" | "docx";

/** Which of them a file name is (by its extension), or null. */
export function documentTypeOf(name: string): FolderDocument | null {
	const ext = extensionOf(name);
	return ext === "pdf" || ext === "docx" ? ext : null;
}

/** The extension of a file name, lower case and without the dot; empty when there is none (`.env` has none). */
export function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
