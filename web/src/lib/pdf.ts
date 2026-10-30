import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
// The legacy build: it carries what older WebKit lacks, and the macOS app's window is WebKit.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import PdfWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker";
import { type DocumentError, type PdfTextItem, pageText } from "./document-text.ts";

/**
 * Opening a PDF and drawing its pages (#697), for what is attached to a message (`lib/documents.ts`) and for the Files tab
 * (`components/files/DocumentView.tsx`). PDF.js is large: nothing of the first page imports this, and the PDF's own worker
 * is a chunk of its own that starts when a PDF is opened, one worker for each open document, and ends with it.
 */

/** Where the build puts the files PDF.js fetches (`scripts/lib/pdfjs-assets.ts`). */
const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;

/** The longest side, in pixels, of the picture of a page that goes to the model: small print stays legible, and a page is a few hundred KB. */
export const PAGE_IMAGE_EDGE = 1600;
/** A page picture's JPEG quality: text and line drawings stay sharp, and photographs are not worth more. */
const PAGE_IMAGE_QUALITY = 0.82;

/** A PDF that cannot be read, and why. */
export class PdfError extends Error {
	constructor(
		readonly reason: DocumentError,
		cause: unknown,
	) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
	}
}

export interface OpenPdf {
	doc: PDFDocumentProxy;
	/** Let go of the document and end its worker. */
	close(): Promise<void>;
}

function reasonOf(e: unknown): DocumentError {
	return e instanceof pdfjs.PasswordException ? "encrypted" : "damaged";
}

/** Open a PDF from its bytes (which are handed to its worker: the array is empty afterwards). */
export async function openPdf(bytes: Uint8Array): Promise<OpenPdf> {
	const port = new PdfWorker();
	const worker = pdfjs.PDFWorker.create({ port });
	const task = pdfjs.getDocument({
		data: bytes,
		worker,
		cMapUrl: `${ASSETS}cmaps/`,
		cMapPacked: true,
		wasmUrl: `${ASSETS}wasm/`,
	});
	const close = async () => {
		await task.destroy().catch(() => {});
		worker.destroy();
		// A worker given to PDF.js is not ended by it.
		port.terminate();
	};
	try {
		return { doc: await task.promise, close };
	} catch (e) {
		await close();
		throw new PdfError(reasonOf(e), e);
	}
}

/** The text of one page, as lines. */
export async function textOfPage(page: PDFPageProxy): Promise<string> {
	const content = await page.getTextContent();
	return pageText(content.items as PdfTextItem[]);
}

/** Draw `page` into `canvas`, `scale` pixels to a point of the page; resolves when it is drawn. */
export function drawPage(
	page: PDFPageProxy,
	canvas: HTMLCanvasElement,
	scale: number,
): { done: Promise<void>; cancel(): void } {
	const viewport = page.getViewport({ scale });
	canvas.width = Math.max(1, Math.ceil(viewport.width));
	canvas.height = Math.max(1, Math.ceil(viewport.height));
	const task = page.render({ canvas, viewport, background: "#fff" });
	return { done: task.promise, cancel: () => task.cancel() };
}

/** A picture of `page` as a JPEG of `PAGE_IMAGE_EDGE` pixels on its longer side (a small page is drawn larger, up to three times). */
export async function pageImage(page: PDFPageProxy): Promise<Blob> {
	const size = page.getViewport({ scale: 1 });
	const scale = Math.min(3, PAGE_IMAGE_EDGE / Math.max(size.width, size.height));
	const canvas = document.createElement("canvas");
	try {
		await drawPage(page, canvas, scale).done;
		const encoded = Promise.withResolvers<Blob | null>();
		canvas.toBlob(encoded.resolve, "image/jpeg", PAGE_IMAGE_QUALITY);
		const blob = await encoded.promise;
		if (!blob) throw new Error("The page could not be turned into a picture.");
		return blob;
	} finally {
		// A canvas keeps its pixels until it is resized, however long it is not on a page.
		canvas.width = 0;
		canvas.height = 0;
	}
}
