import { ATTACH_LIMITS, looksLikeText } from "@shared/attachment.ts";
import { UPLOAD_LIMITS, type UploadResult } from "@shared/upload.ts";
import { t } from "../i18n/index.ts";
import type { DocumentFailure, DocumentRead, DocumentUse } from "./documents.ts";
import {
	documentFailureText,
	imageRefusalText,
	notAttachedText,
	type Task,
	totalText,
	uploadFailureText,
} from "./drop-flow.ts";
import type { ImageRefusal, PreparedImage } from "./images.ts";
import { UploadError, type UploadScope } from "./upload.ts";

/**
 * Doing what was chosen for dropped files (see `components/DropChoice.tsx` for the choosing): images are prepared as the
 * composer's own are, text files are read into the message, and a path is the one the app's window gave, or the one the
 * server gave back for a copy of the file. What cannot be done is said in a toast and does not stop the rest; a stop
 * (`signal`) ends it all and nothing is handed over.
 */

/** One upload of a drop, as the list of progress shows it. */
export interface UploadRow {
	name: string;
	state: "waiting" | "sending" | "sent" | "failed";
	sent: number;
	total: number;
}

/** A text file read for the message. */
export interface ReadText {
	name: string;
	/** The file's size on disk; for a document, the weight of the text read from it. */
	bytes: number;
	text: string;
	/** For a document: what was taken from it, in a few words (the chip shows it). */
	note?: string;
}

/** What the choice made of the files: what goes into the message, and the paths to write in it, in the order of the drop. */
export interface RunResult {
	images: PreparedImage[];
	files: ReadText[];
	paths: string[];
}

export interface RunDeps {
	/** Where an upload goes; null when the conversation has not started yet (nothing can be uploaded). */
	scope: UploadScope | null;
	/** What the message's images already weigh: they count against the images' total. */
	usedImageBytes: number;
	/** What the message's text files already weigh: they count against the text total. */
	usedTextBytes: number;
	signal: AbortSignal;
	/** Say what was refused or failed. */
	warn(text: string): void;
	/** Say what was taken in part: a document longer than a message takes. */
	notice(text: string): void;
	/** The document being read now, or null when no document is: reading one takes long enough to be shown. */
	reading(name: string | null): void;
	/** The uploads' progress (called with a copy), as they start, advance and end. Not called when nothing is uploaded. */
	progress(rows: UploadRow[]): void;
	prepareImage(file: File, usedBytes: number): Promise<PreparedImage | ImageRefusal>;
	/** A PDF or a `.docx` as the text file and the pictures of its pages that it becomes; or why it cannot be. */
	readDocument(file: File, use: DocumentUse): Promise<DocumentRead | DocumentFailure>;
	upload(
		scope: UploadScope,
		file: File,
		onProgress: (sent: number, total: number) => void,
		signal: AbortSignal,
	): Promise<UploadResult>;
}

/** A path to be had only by sending a copy: the app's window said nothing of where it is, and it is no folder. */
const needsUpload = (task: Task): boolean => task.action === "path" && !task.entry.path && !task.entry.directory;

const nameOf = (task: Task): string => task.entry.file.name || "file";

/** What a failed upload says: the server's own words when it answered, else the error's. */
function failureOf(e: unknown): { code: UploadError["code"]; message: string; limit?: number } {
	if (e instanceof UploadError) return e;
	return { code: "failed", message: e instanceof Error ? e.message : String(e) };
}

/** The bytes of a message's text files, as they count against `ATTACH_LIMITS.textTotalBytes`. */
export const textBytes = (files: readonly { bytes: number }[]): number => files.reduce((sum, f) => sum + f.bytes, 0);

/** Do `tasks` in order. Resolves to nothing at all when `signal` stopped it. */
export async function run(tasks: readonly Task[], deps: RunDeps): Promise<RunResult | null> {
	const out: RunResult = { images: [], files: [], paths: [] };
	let usedImages = deps.usedImageBytes;
	let usedText = deps.usedTextBytes;

	// Which uploads can be made: there is a conversation to send to, the file is not over the limit, and the drop is not
	// more than a drop is for. The rest are refused where their turn comes.
	const sendable = tasks.filter(
		(task) => needsUpload(task) && deps.scope !== null && task.entry.file.size <= UPLOAD_LIMITS.fileBytes,
	);
	const queue = new Set(sendable.slice(0, UPLOAD_LIMITS.perDrop));
	const rows = new Map<Task, UploadRow>();
	for (const task of queue)
		rows.set(task, { name: nameOf(task), state: "waiting", sent: 0, total: task.entry.file.size });
	const report = () => {
		if (rows.size) deps.progress([...rows.values()].map((row) => ({ ...row })));
	};
	if (sendable.length > queue.size) deps.warn(t("drop.errTooMany", { n: UPLOAD_LIMITS.perDrop }));
	report();

	for (const task of tasks) {
		if (deps.signal.aborted) return null;
		const { entry } = task;
		const name = nameOf(task);
		if (task.action === "attach") {
			if (entry.info.kind === "image") {
				const prepared = await deps.prepareImage(entry.file, usedImages);
				if ("reason" in prepared) {
					deps.warn(imageRefusalText(prepared));
				} else {
					usedImages += prepared.bytes;
					out.images.push(prepared);
				}
			} else if (entry.info.kind === "text" && entry.info.attach === true) {
				// A file that cannot be attached was named, with its reason, where the choice was made.
				if (usedText + entry.file.size > ATTACH_LIMITS.textTotalBytes) {
					deps.warn(totalText(name, usedText + entry.file.size));
					continue;
				}
				try {
					const bytes = new Uint8Array(await entry.file.arrayBuffer());
					// Read whole now: what the first look at the file let by (a NUL byte or bytes that are no UTF-8 further in,
					// or a file changed since) is not put into a message.
					if (!looksLikeText(bytes, true)) {
						deps.warn(notAttachedText(name, "binary"));
						continue;
					}
					// Decoding drops a byte order mark.
					const text = new TextDecoder().decode(bytes);
					usedText += bytes.byteLength;
					out.files.push({ name, bytes: bytes.byteLength, text });
				} catch (e) {
					deps.warn(t("drop.errRead", { name, error: e instanceof Error ? e.message : String(e) }));
				}
			} else if (entry.info.kind === "document" && entry.info.attach === true) {
				// A document takes a moment (a scan is drawn page by page): the choice shows which one is being read.
				deps.reading(name);
				let read: DocumentRead | DocumentFailure;
				try {
					read = await deps.readDocument(entry.file, { imageBytes: usedImages, textBytes: usedText });
				} catch (e) {
					// The reader's own chunk could not be fetched (or something it did not foresee broke): said like the rest.
					read = { reason: "failed", name, message: e instanceof Error ? e.message : String(e) };
				} finally {
					deps.reading(null);
				}
				if (deps.signal.aborted) return null;
				if ("reason" in read) {
					deps.warn(documentFailureText(read));
					continue;
				}
				usedText += read.file.bytes;
				for (const image of read.images) usedImages += image.bytes;
				out.files.push(read.file);
				out.images.push(...read.images);
				for (const notice of read.notices) deps.notice(notice);
			}
			continue;
		}
		if (entry.path) {
			out.paths.push(entry.path);
		} else if (entry.directory) {
			deps.warn(t("drop.errFolderNoPath", { name }));
		} else if (deps.scope === null) {
			deps.warn(t("drop.errNoConversation", { name }));
		} else if (entry.file.size > UPLOAD_LIMITS.fileBytes) {
			deps.warn(uploadFailureText(name, { code: "tooLarge", message: "", limit: UPLOAD_LIMITS.fileBytes }));
		} else {
			const row = rows.get(task);
			if (!row) continue;
			row.state = "sending";
			report();
			try {
				const saved = await deps.upload(
					deps.scope,
					entry.file,
					(sent, total) => {
						row.sent = sent;
						row.total = total;
						report();
					},
					deps.signal,
				);
				row.state = "sent";
				row.sent = row.total;
				out.paths.push(saved.path);
			} catch (e) {
				if (deps.signal.aborted) return null;
				row.state = "failed";
				deps.warn(uploadFailureText(name, failureOf(e)));
			}
			report();
		}
	}
	return deps.signal.aborted ? null : out;
}
