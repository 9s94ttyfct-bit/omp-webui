import { ATTACH_LIMITS, DOCUMENT_LIMITS } from "@shared/attachment.ts";
import { documentTypeOf } from "@shared/folder.ts";
import { t } from "../i18n/index.ts";
import {
	type DocumentError,
	docxMessage,
	MIN_TEXT_BUDGET,
	pdfMessage,
	readDocx,
	scannedPages,
	utf8Bytes,
} from "./document-text.ts";
import "./drop-strings.ts";
import { checkLimits, type PreparedImage, refusalMessage, toBase64 } from "./images.ts";
import { openPdf, PdfError, pageImage, textOfPage } from "./pdf.ts";

/**
 * Reading a PDF or a Word document for a message (#697): its text becomes a text file attached to the message, and the
 * pages of a PDF that have no text of their own (a scan) become pictures, which go through the images' limits. A lazy chunk
 * with the PDF reader in it: it is fetched when a document is attached.
 */

/** What a document became. */
export interface DocumentRead {
	/** The text file it is: the document's name, the text's weight (not the file's), the text, and what was taken, in a few words. */
	file: { name: string; bytes: number; text: string; note: string };
	/** The pages of a PDF that have no text, as pictures. */
	images: PreparedImage[];
	/** What was left out of the document, in the page's words, for a toast each. */
	notices: string[];
}

export type DocumentFailure =
	| { reason: DocumentError | "empty"; name: string }
	/** The message's text files leave no room: `total` is what they would weigh with the least of this one. */
	| { reason: "noRoom"; name: string; total: number }
	| { reason: "failed"; name: string; message: string };

/** What the message already holds: its pictures' and its text files' weight, which this document's share is counted against. */
export interface DocumentUse {
	imageBytes: number;
	textBytes: number;
}

/** `12 pages`, or `10 of 12 pages` when the rest was left out. */
function pagesNote(taken: number, pages: number): string {
	if (taken < pages) return t("drop.docNotePagesSome", { n: taken, total: pages });
	return pages === 1 ? t("drop.docNotePage") : t("drop.docNotePages", { n: pages });
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

/** A PDF's text, and the pictures of its pages that have no text. */
async function readPdf(
	name: string,
	bytes: Uint8Array,
	budget: number,
	use: DocumentUse,
): Promise<DocumentRead | DocumentFailure> {
	// The reader below hands the bytes to the PDF's worker, which empties the array.
	const { doc, close } = await openPdf(bytes);
	try {
		const pages = doc.numPages;
		const texts: string[] = [];
		for (let n = 1; n <= Math.min(pages, DOCUMENT_LIMITS.textPages); n++) {
			const page = await doc.getPage(n);
			texts.push(await textOfPage(page));
			page.cleanup();
		}
		const blank = scannedPages(texts);
		const images: PreparedImage[] = [];
		const pictures: number[] = [];
		const notices: string[] = [];
		let usedImages = use.imageBytes;
		for (const n of blank.slice(0, DOCUMENT_LIMITS.imagePages)) {
			const label = `${name} page ${n}.jpg`;
			let blob: Blob;
			try {
				const page = await doc.getPage(n);
				blob = await pageImage(page);
				page.cleanup();
			} catch {
				// A page that cannot be drawn is told in the text as a page without a picture; the others go on.
				continue;
			}
			const refusal = checkLimits(label, blob.size, usedImages);
			if (refusal) {
				const { key, vars } = refusalMessage(refusal);
				notices.push(t(key, vars));
				// One page that is too heavy is skipped; the pictures' total being reached ends it.
				if (refusal.reason === "totalTooLarge") break;
				continue;
			}
			images.push({
				name: label,
				mimeType: "image/jpeg",
				data: await toBase64(blob),
				bytes: blob.size,
				resized: false,
			});
			usedImages += blob.size;
			pictures.push(n);
		}
		// Nothing a model could read: no page has text, and no page could be sent as a picture.
		if (blank.length === texts.length && !pictures.length) return { reason: "empty", name };
		const message = pdfMessage({ pages, texts, pictures, budget });
		if (message.leftOut > 0 || message.cut) {
			notices.unshift(
				t("drop.docLeftOut", {
					name,
					taken: message.included,
					pages,
					pageLimit: DOCUMENT_LIMITS.textPages,
					size: kb(budget),
				}),
			);
		}
		const unpictured = blank.length - DOCUMENT_LIMITS.imagePages;
		if (unpictured > 0) notices.push(t("drop.docNoImages", { name, n: unpictured, limit: DOCUMENT_LIMITS.imagePages }));
		const note = [
			pagesNote(message.included, pages),
			pictures.length ? t("drop.docNoteImages", { n: pictures.length }) : "",
		]
			.filter(Boolean)
			.join(" · ");
		return { file: { name, bytes: message.bytes, text: message.text, note }, images, notices };
	} finally {
		await close();
	}
}

/** A `.docx`'s text. */
function readWord(name: string, bytes: Uint8Array, budget: number): DocumentRead | DocumentFailure {
	const read = readDocx(bytes);
	if ("error" in read) return { reason: read.error, name };
	if (read.text.trim() === "") return { reason: "empty", name };
	const message = docxMessage(read.text, budget);
	const notices = message.cut ? [t("drop.docTextCut", { name, size: kb(budget) })] : [];
	const note = message.cut ? t("drop.docNoteWordCut") : t("drop.docNoteWord");
	return { file: { name, bytes: utf8Bytes(message.text), text: message.text, note }, images: [], notices };
}

/**
 * Read a PDF or a `.docx` for the message: refused unread when it is over `DOCUMENT_LIMITS.fileBytes` or when the message's
 * text files leave no room for it, and after that for what its bytes say (a password, a damaged or an old file). The text is
 * cut to what one text file may hold and what the message has left (`ATTACH_LIMITS`), and a PDF's pages with no text go as
 * pictures, `DOCUMENT_LIMITS.imagePages` of them at most and within the pictures' own limits.
 */
export async function readDocument(file: File, use: DocumentUse): Promise<DocumentRead | DocumentFailure> {
	const name = file.name || "document";
	const kind = documentTypeOf(name);
	if (!kind) return { reason: "failed", name, message: "not a PDF or a Word (.docx) document" };
	if (file.size > DOCUMENT_LIMITS.fileBytes) return { reason: "tooLarge", name };
	const budget = Math.min(ATTACH_LIMITS.textFileBytes, ATTACH_LIMITS.textTotalBytes - use.textBytes);
	if (budget < MIN_TEXT_BUDGET) return { reason: "noRoom", name, total: use.textBytes + MIN_TEXT_BUDGET };
	try {
		const bytes = new Uint8Array(await file.arrayBuffer());
		return kind === "pdf" ? await readPdf(name, bytes, budget, use) : readWord(name, bytes, budget);
	} catch (e) {
		if (e instanceof PdfError) return { reason: e.reason, name };
		return { reason: "failed", name, message: e instanceof Error ? e.message : String(e) };
	}
}
