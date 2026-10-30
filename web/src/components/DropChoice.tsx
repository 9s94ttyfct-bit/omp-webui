import * as Popover from "@radix-ui/react-popover";
import { type DropAction, hasMention, pathText } from "@shared/attachment.ts";
import { FileText, Loader2, TriangleAlert, X } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type MessageKey, t as translate, useLang, useT, type Vars } from "../i18n/index.ts";
import {
	choicesFor,
	describe,
	type Entry,
	kindsOf,
	kindsText,
	labelText,
	plan,
	rememberedFor,
	sizeText,
	type Task,
	whyText,
} from "../lib/drop-flow.ts";
import type { DropRequest } from "../lib/drop-items.ts";
import { readChoices, rememberChoices } from "../lib/drop-prefs.ts";
import { run, type UploadRow } from "../lib/drop-run.ts";
import "../lib/drop-strings.ts";
import { attachedBytes, prepareImage } from "../lib/images.ts";
import { type UploadScope, uploadFile } from "../lib/upload.ts";
import { useApp } from "../store/app.ts";
import type { ImageAttachment, TextAttachment } from "./Composer.tsx";
import { Button, cx } from "./ui.tsx";

/**
 * What to do with files given to the message box (dropped, pasted or picked): put them into the message (`Attach`: an image
 * as an image, a text file as text) or write where they are (`Insert path`). A kind of file the person has chosen for before
 * ("Remember") is not asked about again. A file with no path to write is first sent to the conversation's folder.
 *
 * This is a chunk of its own, fetched when the first files arrive: the message box only holds the request (`lib/drop-items.ts`).
 * What it does with the files is in `lib/drop-flow.ts` (what they are) and `lib/drop-run.ts` (doing it).
 */

interface Props {
	request: DropRequest;
	/** What the choice hangs from: the message box. */
	anchor: HTMLElement | null;
	/** The conversation an upload goes to; null while there is none (a new conversation that has not started). */
	scope: UploadScope | null;
	/** The message's pictures: they count against the pictures' total. */
	images: readonly ImageAttachment[];
	/** What the message's text files already weigh. */
	usedTextBytes: number;
	onAttach(added: { images: ImageAttachment[]; files: TextAttachment[] }): void;
	/** Text to write into the message (paths, one to a line). */
	onInsert(text: string): void;
	/** The request is dealt with, or was cancelled: the message box lets go of it. */
	onDone(): void;
}

type View = { kind: "ask"; asked: Entry[] } | { kind: "upload"; rows: UploadRow[] } | { kind: "reading"; name: string };

/** At most this many files are listed in the choice; the rest are counted. */
const LISTED = 5;

export default function DropChoice({
	request,
	anchor,
	scope,
	images,
	usedTextBytes,
	onAttach,
	onInsert,
	onDone,
}: Props) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const [view, setView] = useState<View | null>(null);
	const [remember, setRemember] = useState(false);
	// Read when work finishes, which can be long after it began: the message box has changed since.
	const latest = useRef({ scope, images, usedTextBytes, onAttach, onInsert, onDone, toast });
	latest.current = { scope, images, usedTextBytes, onAttach, onInsert, onDone, toast };
	const stop = useRef<AbortController | null>(null);
	// Files are being sent: a newer drop that takes this one's place cancels them, and says so.
	const sending = useRef(false);
	const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);

	/** Do `tasks`; false when that was cancelled (nothing was handed over). */
	const execute = useCallback(async (tasks: Task[], signal: AbortSignal): Promise<boolean> => {
		const begin = latest.current;
		const result = await run(tasks, {
			scope: begin.scope,
			usedImageBytes: attachedBytes(begin.images),
			usedTextBytes: begin.usedTextBytes,
			signal,
			warn: (text) => latest.current.toast("error", text),
			notice: (text) => latest.current.toast("warning", text),
			reading: (name) => setView(name === null ? null : { kind: "reading", name }),
			progress: (rows) => {
				sending.current = true;
				setView({ kind: "upload", rows });
			},
			prepareImage,
			// The PDF reader is a chunk of its own, fetched with the first document.
			readDocument: (file, use) => import("../lib/documents.ts").then((m) => m.readDocument(file, use)),
			upload: uploadFile,
		}).finally(() => {
			sending.current = false;
		});
		if (!result) return false;
		const now = latest.current;
		if (result.images.length || result.files.length) {
			now.onAttach({
				images: result.images.map((img) => ({
					type: "image" as const,
					data: img.data,
					mimeType: img.mimeType,
					name: img.name,
					id: crypto.randomUUID(),
				})),
				files: result.files.map((file) => ({ type: "text" as const, ...file, id: crypto.randomUUID() })),
			});
		}
		if (result.paths.length) now.onInsert(result.paths.map(pathText).join("\n"));
		return true;
	}, []);

	useEffect(() => {
		const control = new AbortController();
		stop.current = control;
		void (async () => {
			const { settled, asked } = plan(await describe(request), choicesFor(request.source, readChoices()));
			if (control.signal.aborted) return;
			if (settled.length && !(await execute(settled, control.signal))) return;
			if (!asked.length) {
				latest.current.onDone();
				return;
			}
			setView({ kind: "ask", asked });
		})();
		return () => {
			if (sending.current && !control.signal.aborted)
				latest.current.toast("warning", translate("drop.uploadsCancelled"));
			control.abort();
		};
	}, [request, execute]);

	const choose = (action: DropAction, asked: Entry[]) => {
		const control = stop.current;
		if (!control || control.signal.aborted) return;
		if (remember) rememberChoices(rememberedFor(asked, action));
		// Closed now; an upload shows its progress at once (`run` reports before it first waits).
		setView(null);
		void execute(
			asked.map((entry) => ({ entry, action })),
			control.signal,
		).then((done) => done && latest.current.onDone());
	};

	const cancel = () => {
		stop.current?.abort();
		latest.current.onDone();
	};

	return (
		<Popover.Root open={view !== null}>
			<Popover.Anchor virtualRef={anchorRef} />
			<Popover.Portal>
				<Popover.Content
					side="top"
					align="center"
					sideOffset={8}
					collisionPadding={8}
					aria-label={view?.kind === "ask" ? titleOf(view.asked, t) : t("drop.progressTitle")}
					className="z-50 w-[32rem] max-w-[calc(100vw-1rem)] rounded-2xl border border-border bg-surface p-3 shadow-2xl outline-none"
					data-testid="drop-choice"
					onInteractOutside={(e) => e.preventDefault()}
					onEscapeKeyDown={cancel}
					onOpenAutoFocus={(e) => e.preventDefault()}
					onCloseAutoFocus={(e) => e.preventDefault()}
				>
					{view?.kind === "ask" ? (
						<Ask asked={view.asked} remember={remember} onRemember={setRemember} onChoose={choose} onCancel={cancel} />
					) : view?.kind === "upload" ? (
						<Uploading rows={view.rows} onCancel={cancel} />
					) : view?.kind === "reading" ? (
						<Reading name={view.name} onCancel={cancel} />
					) : null}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

type Translate = (key: MessageKey, vars?: Vars) => string;

function titleOf(asked: readonly Entry[], t: Translate): string {
	return asked.length === 1
		? t("drop.titleOne", { name: asked[0]?.file.name ?? "" })
		: t("drop.titleMany", { n: asked.length });
}

/** Focus the first button of `root` that marks itself as a choice and is enabled. */
function focusFirstChoice(root: HTMLElement | null): void {
	root?.querySelector<HTMLElement>("button[data-choice]:not(:disabled)")?.focus();
}

function Ask({
	asked,
	remember,
	onRemember,
	onChoose,
	onCancel,
}: {
	asked: Entry[];
	remember: boolean;
	onRemember: (on: boolean) => void;
	onChoose: (action: DropAction, asked: Entry[]) => void;
	onCancel: () => void;
}) {
	const t = useT();
	const lang = useLang((s) => s.lang);
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => focusFirstChoice(root.current), []);

	const attachable = asked.filter((e) => e.info.attach === true).length;
	// A folder is written down only where the app knows where it is: a browser can send files, never a folder.
	const pathable = asked.filter((e) => !e.directory || e.path !== null).length;
	const local = asked.every((e) => e.path !== null);
	const attachLabel =
		attachable < asked.length ? t("drop.attachSome", { n: attachable, m: asked.length }) : t("drop.attach");

	// ← and → go between the buttons, as they do in a row of tabs or a toolbar.
	const arrows = (e: KeyboardEvent<HTMLElement>) => {
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-choice]:not(:disabled)")];
		const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
		if (at < 0 || buttons.length < 2) return;
		e.preventDefault();
		buttons[(at + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
	};

	return (
		<div ref={root}>
			<div className="mb-2 flex items-start gap-2">
				<h2 className="min-w-0 flex-1 break-words text-sm font-medium">{titleOf(asked, t)}</h2>
				<button
					type="button"
					aria-label={t("common.close")}
					className="shrink-0 rounded-md p-1 text-muted hover:bg-hover hover:text-fg"
					onClick={onCancel}
					data-testid="drop-close"
				>
					<X size={14} />
				</button>
			</div>
			<ul className="mb-3 space-y-1.5" data-testid="drop-rows">
				{asked.slice(0, LISTED).map((entry, i) => (
					<li
						// biome-ignore lint/suspicious/noArrayIndexKey: the same name can be dropped twice; the list does not change.
						key={i}
						className="flex flex-wrap items-baseline gap-x-2 text-xs"
						data-testid="drop-row"
						data-kind={entry.info.kind}
					>
						<span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-muted">{labelText(entry.info.kind)}</span>
						<span className="min-w-0 max-w-full truncate text-sm text-fg" title={entry.file.name}>
							{entry.file.name}
						</span>
						{entry.directory ? null : <span className="shrink-0 text-muted">{sizeText(entry.file.size)}</span>}
						{entry.info.attach === true ? null : (
							<span className="basis-full text-muted" data-testid="drop-why">
								{entry.directory && entry.path === null ? t("drop.whyFolderNoPath") : whyText(entry.info.attach)}
							</span>
						)}
						{entry.mentions ? (
							<span className="flex basis-full items-start gap-1.5 text-warning" data-testid="drop-mentions">
								<TriangleAlert size={13} className="mt-px shrink-0" />
								{t("drop.warnMentions")}
							</span>
						) : null}
					</li>
				))}
				{asked.length > LISTED ? (
					<li className="text-xs text-muted">{t("drop.moreItems", { n: asked.length - LISTED })}</li>
				) : null}
			</ul>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys between the two buttons; the buttons are the controls. */}
			<div className="flex flex-wrap gap-2" onKeyDown={arrows}>
				<Button
					variant="primary"
					data-choice
					disabled={attachable === 0}
					onClick={() => onChoose("attach", asked)}
					data-testid="drop-attach"
				>
					{attachLabel}
				</Button>
				<Button
					variant="outline"
					data-choice
					disabled={pathable === 0}
					onClick={() => onChoose("path", asked)}
					data-testid="drop-path"
				>
					{asked.length > 1 ? t("drop.insertPaths") : t("drop.insertPath")}
				</Button>
			</div>
			<label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-muted">
				<input
					type="checkbox"
					className="accent-[var(--accent)]"
					checked={remember}
					onChange={(e) => onRemember(e.target.checked)}
					data-testid="drop-remember"
				/>
				{t("drop.remember", { types: kindsText(kindsOf(asked), lang) })}
			</label>
			<p className="mt-2 text-xs text-muted" data-testid="drop-hint">
				{local ? t("drop.hintLocal") : t("drop.hintUpload")}
			</p>
		</div>
	);
}

/** A document being read: a PDF is drawn page by page when it is a scan, which takes seconds. */
function Reading({ name, onCancel }: { name: string; onCancel: () => void }) {
	const t = useT();
	return (
		<div>
			<h2 className="mb-2 text-sm font-medium">{t("drop.progressTitle")}</h2>
			<p className="mb-3 flex items-center gap-2 text-sm" role="status" data-testid="drop-reading">
				<Loader2 size={14} className="shrink-0 animate-spin text-muted" />
				<span className="min-w-0 truncate" title={name}>
					{t("drop.reading", { name })}
				</span>
			</p>
			<Button size="sm" variant="ghost" onClick={onCancel} data-testid="drop-cancel">
				{t("drop.cancelUpload")}
			</Button>
		</div>
	);
}

function Uploading({ rows, onCancel }: { rows: UploadRow[]; onCancel: () => void }) {
	const t = useT();
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => root.current?.querySelector<HTMLElement>("button")?.focus(), []);
	return (
		<div ref={root}>
			<h2 className="mb-2 text-sm font-medium">{t("drop.progressTitle")}</h2>
			<ul className="mb-3 space-y-2" data-testid="drop-progress">
				{rows.map((row, i) => {
					const percent = row.total > 0 ? Math.min(100, Math.round((row.sent / row.total) * 100)) : 0;
					return (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: rows keep their order and are never reordered or removed.
							key={i}
							data-testid="drop-upload"
							data-state={row.state}
						>
							<div className="flex items-baseline justify-between gap-3 text-xs">
								<span className="min-w-0 truncate text-sm text-fg" title={row.name}>
									{row.name}
								</span>
								<span className={cx("shrink-0", row.state === "failed" ? "text-danger" : "text-muted")}>
									{row.state === "waiting"
										? t("drop.waiting")
										: row.state === "sending"
											? `${t("drop.sending")} ${percent}%`
											: row.state === "sent"
												? t("drop.sent")
												: t("drop.failed")}
								</span>
							</div>
							<div
								role="progressbar"
								aria-label={row.name}
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={percent}
								className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover"
							>
								<div
									className={cx("h-full rounded-full", row.state === "failed" ? "bg-danger" : "bg-accent")}
									style={{ width: `${percent}%` }}
								/>
							</div>
						</li>
					);
				})}
			</ul>
			<Button size="sm" variant="ghost" onClick={onCancel} data-testid="drop-cancel">
				{t("drop.cancelUpload")}
			</Button>
		</div>
	);
}

/**
 * The text files attached to the message, as chips in the strip above the field (the message box fetches this with the
 * choice: the first page has none of it). Each has its name, its size (a document, what was taken from it too) and a button
 * that takes it off the message.
 */
export function AttachedFiles({ files, onRemove }: { files: readonly TextAttachment[]; onRemove(id: string): void }) {
	const t = useT();
	return files.map((file) => {
		// What was taken from a document, when it is one, and the weight of the text that went into the message.
		const detail = file.note ? `${file.note} · ${sizeText(file.bytes)}` : sizeText(file.bytes);
		return (
			<div
				key={file.id}
				className="group relative flex h-16 max-w-56 items-center gap-2 rounded-lg border border-border bg-bg-soft px-3"
				data-testid="file-chip"
			>
				<FileText size={18} className="shrink-0 text-muted" />
				<span className="min-w-0">
					<span className="block truncate text-sm text-fg" title={file.name}>
						{file.name}
					</span>
					<span className="flex items-center gap-1 text-xs text-muted">
						<span className="truncate" title={detail}>
							{detail}
						</span>
						{hasMention(file.text) ? (
							<TriangleAlert
								size={12}
								role="img"
								aria-label={t("drop.warnMentions")}
								className="shrink-0 text-warning"
								data-testid="file-chip-mentions"
							/>
						) : null}
					</span>
				</span>
				<button
					type="button"
					aria-label={t("chat.composerRemoveImage", { name: file.name })}
					className="absolute -top-1.5 -right-1.5 rounded-full border border-border bg-surface p-0.5 text-muted hover:text-fg"
					onClick={() => onRemove(file.id)}
				>
					<X size={12} />
				</button>
			</div>
		);
	});
}
