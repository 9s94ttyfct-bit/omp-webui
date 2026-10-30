import { FOLDER_LIMITS, type FolderFile } from "@shared/folder.ts";
import { FileX } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { type DocumentError, readDocx } from "../../lib/document-text.ts";
import { fmtBytes } from "../../lib/files-rows.ts";
import { type FolderScope, folder } from "../../lib/folder-api.ts";
import type { drawPage } from "../../lib/pdf.ts";
import { cx, Empty, Spinner } from "../ui.tsx";

/**
 * A PDF or a Word document, read only (#697), as the Files tab's body draws it: a PDF as its pages, drawn as they come near
 * (a long one is not drawn whole), and a `.docx` as its text. A chunk of its own: the PDF reader is fetched when a PDF is
 * opened, and the zip reader with it when a Word document is. What is fetched is the file's bytes (`GET /api/folder/doc`);
 * everything else happens in the page.
 */

type DocumentFile = Extract<FolderFile, { kind: "document" }>;

/** The widest a page is drawn, in CSS pixels: wider than that is a page of a size nobody reads at. */
const MAX_PAGE_WIDTH = 1000;
/** How far from the visible part a page is already drawn, so that it is there before the reader gets to it. */
const NEAR_MARGIN = "1000px 0px";

type Bytes = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; bytes: Uint8Array };

export default function DocumentView({ scope, file }: { scope: FolderScope; file: DocumentFile }) {
	const [read, setRead] = useState<Bytes>({ state: "loading" });
	// biome-ignore lint/correctness/useExhaustiveDependencies: `scope` is rebuilt from these two ids.
	useEffect(() => {
		const ctl = new AbortController();
		setRead({ state: "loading" });
		fetch(folder.documentUrl(scope, file.path, file.modified), { signal: ctl.signal })
			.then(async (res) => {
				if (!res.ok) {
					const body: { error?: string } = await res.json().catch(() => ({}));
					throw new Error(body.error ?? res.statusText);
				}
				return new Uint8Array(await res.arrayBuffer());
			})
			.then(
				(bytes) => setRead({ state: "ok", bytes }),
				(e: unknown) => {
					if (!ctl.signal.aborted) setRead({ state: "error", message: e instanceof Error ? e.message : String(e) });
				},
			);
		return () => ctl.abort();
	}, [scope.live, scope.file, file.path, file.modified]);
	return <Opened read={read} type={file.type} size={file.size} />;
}

function Opened({ read, type, size }: { read: Bytes; type: DocumentFile["type"]; size: number }) {
	const t = useT();
	if (read.state === "loading") {
		return (
			<div className="flex justify-center py-10">
				<Spinner />
			</div>
		);
	}
	if (read.state === "error") {
		return (
			<Empty icon={<FileX size={22} />} title={t("files.previewFailedTitle")}>
				{read.message}
			</Empty>
		);
	}
	return type === "pdf" ? <PdfView bytes={read.bytes} size={size} /> : <WordView bytes={read.bytes} />;
}

/** Why a document cannot be shown, in the Files tab's words. */
function Failed({ reason }: { reason: DocumentError }) {
	const t = useT();
	const text = {
		encrypted: t("files.docEncrypted"),
		oldWord: t("files.docOldWord"),
		tooLarge: t("files.docTooLarge"),
		damaged: t("files.docDamaged"),
	}[reason];
	return (
		<Empty icon={<FileX size={22} />} title={t("files.previewFailedTitle")}>
			{text}
		</Empty>
	);
}

// ------------------------------------------------------------------ Word

function WordView({ bytes }: { bytes: Uint8Array }) {
	const t = useT();
	const read = useMemo(() => readDocx(bytes), [bytes]);
	if ("error" in read) return <Failed reason={read.error} />;
	if (read.text.trim() === "") {
		return <Empty icon={<FileX size={22} />} title={t("files.docEmpty")} />;
	}
	const cut = read.text.length > FOLDER_LIMITS.textBytes;
	return (
		<>
			{cut ? (
				<div className="border-b border-border bg-bg-soft px-3 py-1.5 text-xs text-muted" data-testid="file-truncated">
					{t("files.docxCut", { shown: fmtBytes(FOLDER_LIMITS.textBytes) })}
				</div>
			) : null}
			<div
				className="mx-auto max-w-3xl break-words p-4 text-sm leading-relaxed whitespace-pre-wrap text-fg"
				data-testid="file-docx"
			>
				{cut ? read.text.slice(0, FOLDER_LIMITS.textBytes) : read.text}
			</div>
		</>
	);
}

// ------------------------------------------------------------------ PDF

type Pdf =
	| { phase: "loading" }
	| { phase: "failed"; reason: DocumentError }
	| { phase: "ready"; doc: PDFDocumentProxy; ratio: number; draw: typeof drawPage };

/** The nearest ancestor that scrolls, or null when the window does. */
function scrollParent(el: HTMLElement): Element | null {
	for (let parent = el.parentElement; parent; parent = parent.parentElement) {
		const { overflowY } = getComputedStyle(parent);
		if (overflowY === "auto" || overflowY === "scroll") return parent;
	}
	return null;
}

function PdfView({ bytes, size }: { bytes: Uint8Array; size: number }) {
	const t = useT();
	const [pdf, setPdf] = useState<Pdf>({ phase: "loading" });
	const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(0);
	// The container the pages scroll in: a page is near by how far it is from what that shows. Not from the window's edge:
	// the container clips a page below its own, so the window would never see the pages that are not shown yet.
	const [scroller, setScroller] = useState<Element | null | undefined>(undefined);
	useEffect(() => {
		if (wrap) setScroller(scrollParent(wrap));
	}, [wrap]);

	// The document is opened with its own worker, which ends with the view (or with the file read again).
	useEffect(() => {
		let live = true;
		let close: (() => Promise<void>) | null = null;
		void (async () => {
			// Fetched when a PDF is opened, not with this view: the PDF reader is most of a megabyte (a static import would
			// put it into the chunk a Word document is shown from).
			const lib = await import("../../lib/pdf.ts");
			try {
				// A copy: the worker takes the array it is given, and React runs this effect twice in development.
				const open = await lib.openPdf(bytes.slice());
				close = open.close;
				if (!live) {
					await open.close();
					return;
				}
				const first = await open.doc.getPage(1);
				const page = first.getViewport({ scale: 1 });
				first.cleanup();
				if (live) setPdf({ phase: "ready", doc: open.doc, ratio: page.height / page.width, draw: lib.drawPage });
			} catch (e) {
				if (live) setPdf({ phase: "failed", reason: e instanceof lib.PdfError ? e.reason : "damaged" });
			}
		})();
		return () => {
			live = false;
			void close?.();
		};
	}, [bytes]);

	// Pages are as wide as the room there is (up to a limit); the width moves in steps, or dragging a panel's edge would draw
	// every page again at each pixel.
	useEffect(() => {
		if (!wrap) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setWidth(Math.floor(entry.contentRect.width / 16) * 16);
		});
		observer.observe(wrap);
		return () => observer.disconnect();
	}, [wrap]);

	if (pdf.phase === "failed") return <Failed reason={pdf.reason} />;
	if (pdf.phase === "loading") {
		return (
			<div className="flex justify-center py-10">
				<Spinner />
			</div>
		);
	}
	const pageWidth = Math.min(MAX_PAGE_WIDTH, width);
	return (
		<div ref={setWrap} className="p-3" data-testid="file-pdf" data-pages={pdf.doc.numPages}>
			<div className="mb-2 text-center text-xs text-faint">
				{[
					pdf.doc.numPages === 1 ? t("files.docOnePage") : t("files.docPages", { n: pdf.doc.numPages }),
					fmtBytes(size),
				].join(" · ")}
			</div>
			<div className="flex flex-col items-center gap-3">
				{Array.from({ length: pdf.doc.numPages }, (_, i) => (
					<PdfPage
						// biome-ignore lint/suspicious/noArrayIndexKey: a document's pages are its numbers; the list never reorders.
						key={i}
						doc={pdf.doc}
						n={i + 1}
						ratio={pdf.ratio}
						width={pageWidth}
						root={scroller}
						draw={pdf.draw}
					/>
				))}
			</div>
		</div>
	);
}

/**
 * One page: an empty sheet of the page's shape until it is near the visible part, then drawn; once far from it again its
 * canvas is let go (a long PDF drawn whole would be hundreds of megabytes of pixels).
 */
function PdfPage({
	doc,
	n,
	ratio,
	width,
	root,
	draw,
}: {
	doc: PDFDocumentProxy;
	n: number;
	/** Height over width of the first page: what every page is taken to be until it is drawn. */
	ratio: number;
	width: number;
	/** What the pages scroll in (null: the window); undefined while it is not known, when nothing is drawn but the first page. */
	root: Element | null | undefined;
	draw: typeof drawPage;
}) {
	const t = useT();
	const [box, setBox] = useState<HTMLDivElement | null>(null);
	const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
	const [near, setNear] = useState(n === 1);
	const [state, setState] = useState<"idle" | "drawing" | "drawn" | "failed">("idle");
	const [shape, setShape] = useState(ratio);

	useEffect(() => {
		if (!box || root === undefined) return;
		const observer = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), {
			root,
			rootMargin: NEAR_MARGIN,
		});
		observer.observe(box);
		return () => observer.disconnect();
	}, [box, root]);

	useEffect(() => {
		if (!near || !canvas || width <= 0) {
			setState("idle");
			return;
		}
		let live = true;
		let drawing: { done: Promise<void>; cancel(): void } | null = null;
		setState("drawing");
		void (async () => {
			try {
				const page = await doc.getPage(n);
				if (!live) return;
				const base = page.getViewport({ scale: 1 });
				setShape(base.height / base.width);
				drawing = draw(page, canvas, (width / base.width) * Math.min(2, window.devicePixelRatio || 1));
				await drawing.done;
				page.cleanup();
				if (live) setState("drawn");
			} catch (e) {
				// A page that was drawn over by a newer draw (or let go) was cancelled, which is no failure.
				if (live && !(e instanceof Error && e.name === "RenderingCancelledException")) setState("failed");
			}
		})();
		return () => {
			live = false;
			drawing?.cancel();
			// A canvas keeps its pixels until it is resized, drawn or not.
			canvas.width = 0;
			canvas.height = 0;
		};
	}, [near, canvas, width, doc, n, draw]);

	return (
		<div
			ref={setBox}
			className="relative max-w-full overflow-hidden rounded-sm bg-white shadow-md"
			style={{ width, height: width * shape }}
			data-testid="file-pdf-page"
			data-page={n}
			data-state={state}
		>
			<canvas
				ref={setCanvas}
				role="img"
				aria-label={t("files.docPageAria", { n, total: doc.numPages })}
				className={cx("block h-full w-full", state === "failed" && "hidden")}
			/>
			{state === "drawing" ? (
				<div
					className="absolute inset-0 flex items-center justify-center"
					role="status"
					aria-label={t("files.docRendering")}
				>
					<Spinner />
				</div>
			) : null}
			{state === "failed" ? (
				<div className="absolute inset-0 flex items-center justify-center p-3 text-center text-xs text-neutral-500">
					{t("files.docPageFailed")}
				</div>
			) : null}
		</div>
	);
}
