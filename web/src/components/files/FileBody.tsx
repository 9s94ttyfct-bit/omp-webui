import { FOLDER_LIMITS, type FolderFile } from "@shared/folder.ts";
import { FileQuestion, FileX } from "lucide-react";
import { Fragment, lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { ApiError } from "../../lib/api.ts";
import { fmtBytes, languageOf } from "../../lib/files-rows.ts";
import { type FolderScope, folder } from "../../lib/folder-api.ts";
import { highlight, highlighted } from "../../lib/highlight.ts";
import { Empty, Spinner } from "../ui.tsx";

/**
 * What a file looks like, drawn once for both places that show it: the side panel's preview (with its header and its
 * actions) and the large view of the main area. The same limits hold in both — a text longer than
 * `MAX_HIGHLIGHT_CHARS` is not coloured, more than `MAX_NUMBERED_LINES` lines are not numbered, Markdown longer than
 * `MAX_RENDER_CHARS` is shown as source — since the file read and the body are the same.
 */

const Markdown = lazy(() => import("../Markdown.tsx").then((m) => ({ default: m.Markdown })));
// A PDF or a Word document: the PDF reader and the zip reader come with it, fetched when one is opened.
const DocumentView = lazy(() => import("./DocumentView.tsx"));

/** Text longer than this is shown plain: tokenising it is slow, and its HTML would be hundreds of thousands of elements. */
const MAX_HIGHLIGHT_CHARS = 150_000;
/** More lines than this are not numbered: a `<span>` for each would be the page's own weight. */
const MAX_NUMBERED_LINES = 20_000;
/** Markdown longer than this is shown as its source. */
export const MAX_RENDER_CHARS = 300_000;
/** A file that has been read again at least this long ago is not read again for a change (a file written in a stream). */
const REREAD_MS = 800;

export type Loaded =
	| { state: "loading" }
	| { state: "error"; message: string; gone: boolean }
	| { state: "ok"; file: FolderFile };

/** Whether two reads of a file are the same file as far as the page shows it (nothing redraws for what did not change). */
function sameRead(a: FolderFile, b: FolderFile): boolean {
	if (a.path !== b.path || a.size !== b.size || a.modified !== b.modified || a.local !== b.local || a.kind !== b.kind)
		return false;
	return a.kind !== "text" || (b.kind === "text" && a.etag === b.etag && a.editable === b.editable);
}

/**
 * The file being previewed, read when the tab asks and again whenever the folder was read again (`reads`), so that a
 * file omp is writing is followed. What did not change (same size, same time, same bytes) is not set again: nothing
 * redraws. The second of the pair puts a file in place of what was read: the editor's save does, so that the view behind
 * it shows the text that was just saved and not the older one until the next read.
 */
export function useFile(scope: FolderScope, path: string, reads: number): [Loaded, (file: FolderFile) => void] {
	const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
	const last = useRef(0);
	const shown = useRef<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `scope` is rebuilt from these two ids.
	useEffect(() => {
		const same = shown.current === path;
		// A burst of reads (a build writing a file) is followed at a pace, not at every change.
		const wait = same ? Math.max(0, last.current + REREAD_MS - Date.now()) : 0;
		const ctl = new AbortController();
		const timer = setTimeout(() => {
			last.current = Date.now();
			folder.file(scope, path, ctl.signal).then(
				(file) => {
					shown.current = path;
					setLoaded((cur) => (cur.state === "ok" && sameRead(cur.file, file) ? cur : { state: "ok", file }));
				},
				(e: unknown) => {
					if (ctl.signal.aborted) return;
					const status = e instanceof ApiError ? e.status : 0;
					setLoaded({ state: "error", message: e instanceof Error ? e.message : String(e), gone: status === 404 });
				},
			);
		}, wait);
		if (!same) setLoaded({ state: "loading" });
		return () => {
			clearTimeout(timer);
			ctl.abort();
		};
	}, [scope.live, scope.file, path, reads]);
	const put = useCallback((file: FolderFile) => {
		shown.current = file.path;
		setLoaded((cur) => (cur.state === "ok" && sameRead(cur.file, file) ? cur : { state: "ok", file }));
	}, []);
	return [loaded, put];
}

/** The text with a line number in front of each line (by CSS), highlighted when the text is small enough to. */
const CodeView = memo(function CodeView({ text, lang, path }: { text: string; lang: string; path: string }) {
	// The last colours made for this file stay on screen while the new ones are made: a file that is written to as it is read
	// would otherwise flash plain text at every change.
	const [done, setDone] = useState<{ path: string; html: string } | null>(null);
	const html = highlighted(text, lang) ?? (done?.path === path ? done.html : null);
	useEffect(() => {
		if (text.length > MAX_HIGHLIGHT_CHARS || highlighted(text, lang) !== null) return;
		let alive = true;
		void highlight(text, lang).then((h) => alive && h !== null && setDone({ path, html: h }));
		return () => {
			alive = false;
		};
	}, [text, lang, path]);
	const lines = useMemo(() => (html === null ? text.replace(/\n$/, "").split("\n") : []), [html, text]);
	return (
		<div className="file-code min-w-fit p-3 text-xs leading-relaxed" data-testid="file-code">
			{html !== null ? (
				<div
					className="[&_pre]:font-mono"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: shiki escapes the code it highlights
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			) : lines.length > MAX_NUMBERED_LINES ? (
				<pre className="font-mono">{text}</pre>
			) : (
				<pre className="font-mono">
					<code>
						{lines.map((line, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the lines of one immutable text
							<Fragment key={i}>
								<span className="line">{line}</span>
								{"\n"}
							</Fragment>
						))}
					</code>
				</pre>
			)}
		</div>
	);
});

/** What a file looks like in the panel and in the larger view: the same body in both. */
export function FileBody({
	scope,
	file,
	source,
	onSize,
}: {
	scope: FolderScope;
	file: FolderFile;
	source: boolean;
	/** What a picture's own size is, for the panel's caption; the larger view has no caption and asks for nothing. */
	onSize?: (size: string | null) => void;
}) {
	const t = useT();
	const name = file.path.slice(file.path.lastIndexOf("/") + 1);
	const [imageFailed, setImageFailed] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new file or a new version of it gets another try
	useEffect(() => setImageFailed(false), [file.path, file.modified]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the size of a picture is of the one on screen
	useEffect(() => onSize?.(null), [file.path, file.modified, onSize]);
	if (file.kind === "binary") {
		return (
			<Empty icon={<FileQuestion size={22} />} title={t("files.binaryTitle", { size: fmtBytes(file.size) })}>
				{file.local ? t("files.binaryBodyLocal") : t("files.binaryBody")}
			</Empty>
		);
	}
	if (file.kind === "document") {
		return (
			<Suspense
				fallback={
					<div className="flex justify-center py-10">
						<Spinner />
					</div>
				}
			>
				{/* Keyed by the version: a document written again is read again, not patched. */}
				<DocumentView key={`${file.path}:${file.modified}`} scope={scope} file={file} />
			</Suspense>
		);
	}
	if (file.kind === "image" || (file.kind === "text" && file.view === "svg" && !source && !file.truncated)) {
		const src =
			file.kind === "image"
				? folder.imageUrl(scope, file.path, file.modified)
				: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.text)}`;
		if (imageFailed) {
			return (
				<Empty icon={<FileX size={22} />} title={t("files.previewFailedTitle")}>
					{name}
				</Empty>
			);
		}
		return (
			<div className="flex min-h-full items-center justify-center p-3" data-testid="file-image">
				<img
					src={src}
					alt={name}
					className="max-h-full max-w-full rounded-md bg-code object-contain"
					onError={() => setImageFailed(true)}
					onLoad={(e) => {
						const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
						onSize?.(w && h ? t("files.imageSize", { w, h }) : null);
					}}
				/>
			</div>
		);
	}
	if (file.view === "markdown" && !source && file.text.length <= MAX_RENDER_CHARS) {
		return (
			<div className="prose-compact p-3" data-testid="file-markdown">
				<Suspense
					fallback={
						<div className="flex justify-center py-6">
							<Spinner />
						</div>
					}
				>
					<Markdown text={file.text} />
				</Suspense>
			</div>
		);
	}
	return <CodeView text={file.text} lang={languageOf(name)} path={file.path} />;
}

/**
 * The lines that say a file was cut, or that Markdown too large to render is its source: above the body, in the panel and
 * in the larger view alike.
 */
export function FileNotices({ file, source }: { file: FolderFile | null; source: boolean }) {
	const t = useT();
	if (!file || file.kind === "binary") return null;
	return (
		<>
			{file.kind === "text" && file.truncated ? (
				<div
					className="shrink-0 border-b border-border bg-bg-soft px-3 py-1.5 text-xs text-muted"
					data-testid="file-truncated"
				>
					{t("files.truncatedFile", { shown: fmtBytes(FOLDER_LIMITS.textBytes), size: fmtBytes(file.size) })}
				</div>
			) : null}
			{file.kind === "text" && file.view === "markdown" && !source && file.text.length > MAX_RENDER_CHARS ? (
				<div className="shrink-0 border-b border-border bg-bg-soft px-3 py-1.5 text-xs text-muted">
					{t("files.renderSkipped")}
				</div>
			) : null}
		</>
	);
}
