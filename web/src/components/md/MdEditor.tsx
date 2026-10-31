import type { Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import * as Dialog from "@radix-ui/react-dialog";
import { FOLDER_LIMITS, type FolderFile } from "@shared/folder.ts";
import { Check, Code, Columns2, Copy, Eye, FileX, X } from "lucide-react";
import { type ReactNode, startTransition, useEffect, useMemo, useRef, useState } from "react";
import { en } from "../../i18n/files.ts";
import { registerStrings, useT } from "../../i18n/index.ts";
import { ApiError } from "../../lib/api.ts";
import { eolOf, saveFailureText, saveFile } from "../../lib/file-save.ts";
import { fmtBytes } from "../../lib/files-rows.ts";
import { type FolderScope, folder } from "../../lib/folder-api.ts";
import { holdLeaveGuard } from "../../lib/leave-guard.ts";
import { conflictDiff, type DiskState, judgeDisk, nextDiskState } from "../../lib/md-conflict.ts";
import type { MdOpen } from "../../lib/md-open.ts";
import { useMediaQuery } from "../../lib/media.ts";
import { inConversation } from "../../lib/same-conversation.ts";
import { TransferError } from "../../lib/transfer-api.ts";
import { dismissOverlays } from "../../store/app.ts";
import { closeMdEditor, takeMdOpener } from "../../store/md-editor.ts";
import { DiffBody } from "../changes/DiffBody.tsx";
import { EditorView, editorState, SEARCH_PHRASES, setLanguage } from "../files/code-editor.ts";
import { Button, cx, Empty, IconButton, Modal, Spinner } from "../ui.tsx";
import { MdPreview } from "./MdPreview.tsx";

// Opened from the Files tab, the Changes view, the large view or a conversation: its strings are the Files tab's own.
registerStrings("files", en);

/**
 * The Markdown editor: one `.md` file of a conversation's folder over the whole window, its source (CodeMirror) on the left
 * and its rendering (`MdPreview.tsx`) on the right, updated as it is typed; or either alone. On a phone the two are tabs.
 *
 * It reads and saves through the Files tab's requests and under their rules (`server/folder.ts`, `server/folder-write.ts`):
 * a path is resolved inside the conversation's folder, and a file the server says this page may not write (`editable`:
 * a page that is not on this computer without full file transfer, a protected place, a file cut at the read limit) is
 * shown read only. Every save names the `etag` of what the text was made from, and the server refuses one that is not the
 * file's any more; the editor also looks at the file every few seconds and when the window comes back. A file that changed
 * on the computer is taken as it is when nothing is unsaved, and is otherwise a conflict (Reload, Overwrite, Show diff):
 * nothing is ever written over a file the person has not seen. What is unsaved is not left without asking (Close, Escape,
 * another file, another conversation: `lib/leave-guard.ts`).
 *
 * It is a modal dialog over the page: the focus stays in it, Escape closes it (CodeMirror's find panel takes Escape first),
 * and the focus goes back to what opened it.
 */

type TextFile = Extract<FolderFile, { kind: "text" }>;
type ViewMode = "split" | "source" | "preview";

/** The view last chosen, on this device. */
const VIEW_KEY = "ompw.mdEditorView";
/** Below this width the two panes are tabs (a phone, a narrow window). */
const NARROW_QUERY = "(max-width: 767px)";
/** How often the file is looked at while the window is in front. */
const CHECK_MS = 3000;
/** How long the text must be still before the preview is drawn again. */
const PREVIEW_MS = 120;

function storedView(): ViewMode {
	try {
		const v = localStorage.getItem(VIEW_KEY);
		return v === "source" || v === "preview" || v === "split" ? v : "split";
	} catch {
		return "split";
	}
}

function nameOf(path: string): { name: string; dir: string } {
	const slash = path.lastIndexOf("/");
	return { name: path.slice(slash + 1), dir: slash < 0 ? "" : path.slice(0, slash) };
}

type Loaded = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; file: TextFile };

export default function MdEditor({ scope, chatKey, path }: { scope: FolderScope; chatKey: string; path: string }) {
	const t = useT();
	const { name, dir } = nameOf(path);
	const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
	// Read once per file: the conversation's process may start or stop meanwhile (its scope changes), and the text being
	// edited is not read again from under the person for that.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the file is `path`; the scope it is asked with is the one at hand
	useEffect(() => {
		const ctl = new AbortController();
		setLoaded({ state: "loading" });
		folder.file(scope, path, ctl.signal).then(
			(file) =>
				setLoaded(
					file.kind === "text" ? { state: "ok", file } : { state: "error", message: t("files.mdNotText", { name }) },
				),
			(e: unknown) => {
				if (ctl.signal.aborted) return;
				const reason =
					e instanceof ApiError && e.status === 404 ? t("files.fileGone") : e instanceof Error ? e.message : String(e);
				setLoaded({ state: "error", message: t("files.mdOpenFailed", { name, reason }) });
			},
		);
		return () => ctl.abort();
	}, [path]);

	return (
		// Closing is the editor's own (Escape, Close, the question about unsaved text): Radix is not let close it.
		<Dialog.Root open onOpenChange={() => {}}>
			<Dialog.Portal>
				<Dialog.Content
					className="fixed inset-0 z-40 flex flex-col bg-bg outline-none fade-in"
					aria-describedby={undefined}
					data-testid="md-editor"
					data-path={path}
					onEscapeKeyDown={(e) => {
						// CodeMirror's find panel closes on Escape: it is let have it.
						if (document.querySelector('[data-testid="md-source"] .cm-search')) return;
						e.preventDefault();
						if (e.isComposing || e.repeat) return;
						if (dismissOverlays()) return;
						closeMdEditor();
					}}
					onCloseAutoFocus={(e) => {
						const opener = takeMdOpener();
						if (!opener) return;
						e.preventDefault();
						opener.focus();
					}}
				>
					{loaded.state === "ok" ? (
						<Workspace key={path} scope={scope} chatKey={chatKey} path={path} initial={loaded.file} />
					) : (
						<>
							<Header name={name} dir={dir} path={path} />
							<div className="min-h-0 flex-1 overflow-auto">
								{loaded.state === "loading" ? (
									<div className="flex justify-center py-10" role="status" aria-label={t("files.mdLoading")}>
										<Spinner />
									</div>
								) : (
									<Empty icon={<FileX size={22} />} title={t("files.previewFailedTitle")}>
										<span data-testid="md-open-error">{loaded.message}</span>
									</Empty>
								)}
							</div>
						</>
					)}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/** The top row: the file's name and folder, then `children` (status and actions), then Close. */
function Header({ name, dir, path, children }: { name: string; dir: string; path: string; children?: ReactNode }) {
	const t = useT();
	return (
		<div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5 max-md:flex-wrap">
			<div className="min-w-0 flex-1">
				<Dialog.Title className="truncate text-sm font-semibold" title={path} data-testid="md-name">
					{name}
				</Dialog.Title>
				{dir ? (
					<div className="truncate font-mono text-xs text-faint" title={path}>
						{dir}
					</div>
				) : null}
			</div>
			{children}
			<IconButton label={t("files.mdClose")} size="sm" data-testid="md-close" onClick={() => closeMdEditor()}>
				<X size={15} />
			</IconButton>
		</div>
	);
}

/**
 * One of the ways the file is shown: a toggle beside the window's other two, or one of two tabs on a phone (the arrow keys
 * move between the tabs, as a tab list's do; `onOther` picks the other one).
 */
function ViewChoice({
	on,
	label,
	onPick,
	testid,
	tab,
	children,
}: {
	on: boolean;
	label: string;
	onPick: () => void;
	testid: string;
	tab?: { controls: string; onOther: () => void };
	children: ReactNode;
}) {
	const className = cx(
		"inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs max-lg:min-h-9",
		tab && "flex-1",
		on ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg",
	);
	if (tab) {
		return (
			<button
				type="button"
				role="tab"
				aria-selected={on}
				aria-controls={tab.controls}
				tabIndex={on ? 0 : -1}
				data-testid={testid}
				className={className}
				onClick={onPick}
				onKeyDown={(e) => {
					if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
					e.preventDefault();
					tab.onOther();
				}}
			>
				{children}
				<span>{label}</span>
			</button>
		);
	}
	return (
		<button type="button" aria-pressed={on} title={label} data-testid={testid} className={className} onClick={onPick}>
			{children}
			<span className="max-xl:sr-only">{label}</span>
		</button>
	);
}

/** Copy the text being edited (a file that is gone cannot be saved: this is the way to keep it). */
function CopyText({ text }: { text: () => string }) {
	const t = useT();
	const [done, setDone] = useState(false);
	return (
		<Button
			size="sm"
			data-testid="md-copy-text"
			onClick={() => {
				void navigator.clipboard.writeText(text()).then(() => {
					setDone(true);
					setTimeout(() => setDone(false), 1500);
				});
			}}
		>
			{done ? <Check size={13} /> : <Copy size={13} />} {done ? t("files.mdCopied") : t("files.mdCopyText")}
		</Button>
	);
}

function Workspace({
	scope,
	chatKey,
	path,
	initial,
}: {
	scope: FolderScope;
	chatKey: string;
	path: string;
	initial: TextFile;
}) {
	const t = useT();
	const { name, dir } = nameOf(path);
	const narrow = useMediaQuery(NARROW_QUERY);
	const [view, setView] = useState<ViewMode>(storedView);
	// On a phone there is room for one pane: the two are tabs, and the split view shows the preview.
	const shown: ViewMode = narrow ? (view === "source" ? "source" : "preview") : view;
	/** The file as last read or saved: its etag, its time (for its images), and whether this page may save it. */
	const [file, setFile] = useState(initial);
	const editable = file.editable && !file.truncated;
	const host = useRef<HTMLDivElement>(null);
	const previewBox = useRef<HTMLElement>(null);
	const editor = useRef<EditorView | null>(null);
	/** What the text on screen was made from: the file's etag, its text as the editor holds it, and its line ending. */
	const base = useRef({ etag: initial.etag, doc: null as Text | null, eol: eolOf(initial.text) });
	/** The text the preview draws: the editor's, a moment after the last keystroke. */
	const [text, setText] = useState(initial.text);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [note, setNote] = useState<"saved" | "reloaded" | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [disk, setDisk] = useState<DiskState>({ kind: "same" });
	const [diffOpen, setDiffOpen] = useState(false);
	const [asking, setAsking] = useState<{ go: () => void; stay?: () => void } | null>(null);
	/** A save or a reload is on its way: a look at the file waits for its answer. */
	const busy = useRef(false);
	const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const ids = useMemo(() => {
		const n = Math.random().toString(36).slice(2, 8);
		return { source: `md-source-${n}`, preview: `md-preview-${n}` };
	}, []);
	const open = useMemo<MdOpen>(() => ({ scope, chatKey, base: dir }), [scope, chatKey, dir]);

	const isDirty = () =>
		editor.current !== null && base.current.doc !== null && !editor.current.state.doc.eq(base.current.doc);
	const current = () => editor.current?.state.doc.toString() ?? text;

	// What the handlers registered once read when they run: this render's.
	const latest = useRef({ t, editable });
	latest.current = { t, editable };

	const config = (readOnly: boolean) => ({
		name,
		label: latest.current.t("files.mdSourceText", { name }),
		phrases: Object.fromEntries(Object.entries(SEARCH_PHRASES).map(([phrase, key]) => [phrase, latest.current.t(key)])),
		readOnly,
		tabIndents: false,
		onUpdate: (u: ViewUpdate) => {
			if (!u.docChanged || base.current.doc === null) return;
			setDirty(!u.state.doc.eq(base.current.doc));
			setNote(null);
			clearTimeout(previewTimer.current);
			const doc = u.state.doc;
			previewTimer.current = setTimeout(() => startTransition(() => setText(doc.toString())), PREVIEW_MS);
		},
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: once: the text it opens with is the one it keeps
	useEffect(() => {
		const parent = host.current;
		if (!parent) return;
		const state = editorState(initial.text, config(!editable));
		base.current.doc = state.doc;
		const ed = new EditorView({ state, parent });
		editor.current = ed;
		if (shown === "preview") previewBox.current?.focus();
		else ed.focus();
		void setLanguage(ed, name);
		return () => {
			clearTimeout(previewTimer.current);
			ed.destroy();
			editor.current = null;
		};
	}, []);

	/** Put `next` in the editor in place of what is there (nothing unsaved is lost: the caller knows), keeping the place. */
	const take = (next: TextFile) => {
		const ed = editor.current;
		if (!ed) return;
		const scroll = ed.scrollDOM.scrollTop;
		const head = ed.state.selection.main.head;
		// A new state: what was undone before is not undone into the file as it is now.
		const state = editorState(next.text, config(!(next.editable && !next.truncated)));
		ed.setState(state);
		ed.dispatch({ selection: { anchor: Math.min(head, state.doc.length) } });
		ed.scrollDOM.scrollTop = scroll;
		void setLanguage(ed, name);
		base.current = { etag: next.etag, doc: state.doc, eol: eolOf(next.text) };
		clearTimeout(previewTimer.current);
		setFile(next);
		setText(next.text);
		setDirty(false);
		setDisk({ kind: "same" });
		setDiffOpen(false);
	};

	/** Look at the file on the computer, and act on what is there (see `judgeDisk`). */
	const check = async () => {
		if (busy.current) return;
		let found: FolderFile | null;
		try {
			found = await folder.file(scope, path);
		} catch (e) {
			// Gone is a state of its own; any other failure (the connection) is looked at again next time.
			if (!(e instanceof ApiError && e.status === 404)) return;
			found = null;
		}
		// A save started meanwhile: its answer says what the file is.
		if (busy.current || !editor.current) return;
		const judged = judgeDisk(base.current.etag, isDirty(), found);
		if (judged.kind === "reload") {
			take(judged.file);
			setNote("reloaded");
		} else setDisk((shownNow) => nextDiskState(shownNow, judged));
	};
	const checkRef = useRef(check);
	checkRef.current = check;

	// The file is looked at every few seconds while the window is in front, and when it comes back to the front.
	useEffect(() => {
		const look = () => {
			if (document.visibilityState === "visible") void checkRef.current();
		};
		const timer = setInterval(look, CHECK_MS);
		window.addEventListener("focus", look);
		document.addEventListener("visibilitychange", look);
		return () => {
			clearInterval(timer);
			window.removeEventListener("focus", look);
			document.removeEventListener("visibilitychange", look);
		};
	}, []);

	/** Save the text. `overwrite` is the etag of the file on the computer, to write over it once the person said so. True when what is on screen is saved. */
	async function save(overwrite?: string): Promise<boolean> {
		const ed = editor.current;
		if (!ed || busy.current || !latest.current.editable) return false;
		const snapshot = ed.state.doc;
		if (overwrite === undefined && base.current.doc !== null && snapshot.eq(base.current.doc)) return true;
		const body = snapshot.sliceString(0, snapshot.length, base.current.eol);
		if (new TextEncoder().encode(body).length > FOLDER_LIMITS.editBytes) {
			setProblem(t("files.editTooLarge", { limit: fmtBytes(FOLDER_LIMITS.editBytes) }));
			return false;
		}
		busy.current = true;
		setSaving(true);
		setProblem(null);
		try {
			const done = await saveFile(scope, path, body, overwrite ?? base.current.etag);
			base.current.etag = done.etag;
			base.current.doc = snapshot;
			setFile((f) => ({ ...f, text: body, etag: done.etag, size: done.size, modified: done.modified }));
			setDisk({ kind: "same" });
			setDiffOpen(false);
			// More may have been typed while the request was on its way: that is not saved.
			const still = !ed.state.doc.eq(snapshot);
			setDirty(still);
			setNote(still ? null : "saved");
			return !still;
		} catch (e) {
			if (e instanceof TransferError && e.code === "conflict" && e.etag) {
				// What is there now, for the diff; the etag of the refusal is the one an Overwrite names.
				let there: string | null = null;
				let etag = e.etag;
				try {
					const now = await folder.file(scope, path);
					if (now.kind === "text") {
						etag = now.etag;
						there = now.truncated ? null : now.text;
					}
				} catch {
					// The diff is offered when it can be read.
				}
				setDisk({ kind: "conflict", etag, text: there });
			} else {
				setProblem(t("files.editSaveFailed", { reason: saveFailureText(e, name) }));
				// A file that is gone says so in its own words.
				queueMicrotask(() => void checkRef.current());
			}
			return false;
		} finally {
			busy.current = false;
			setSaving(false);
		}
	}
	const saveRef = useRef(save);
	saveRef.current = save;

	/** Drop what was typed and take what is on the computer. */
	async function reload(): Promise<void> {
		if (busy.current) return;
		busy.current = true;
		setProblem(null);
		try {
			const next = await folder.file(scope, path);
			if (next.kind === "text") {
				take(next);
				setNote(null);
			} else setDisk({ kind: "unusable" });
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) setDisk({ kind: "gone" });
			else setProblem(t("files.editReloadFailed", { reason: e instanceof Error ? e.message : String(e) }));
		} finally {
			busy.current = false;
		}
	}

	// ⌘S and Ctrl+S save, wherever in the editor the focus is (the browser would offer to save the page).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "s") return;
			e.preventDefault();
			if (!e.repeat) void saveRef.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// While there is unsaved text: what would take the person away from it asks first, and so does the browser.
	useEffect(() => {
		if (!dirty) return;
		const release = holdLeaveGuard({
			blocks: (next) => next === null || !inConversation(next),
			ask: (go, stay) => setAsking({ go, stay }),
		});
		const onUnload = (e: BeforeUnloadEvent) => {
			e.preventDefault();
		};
		window.addEventListener("beforeunload", onUnload);
		return () => {
			release();
			window.removeEventListener("beforeunload", onUnload);
		};
	}, [dirty]);

	// The two panes scroll together, by the share of each that is above the view.
	useEffect(() => {
		const src = editor.current?.scrollDOM;
		const out = previewBox.current;
		if (shown !== "split" || !src || !out) return;
		let lead: HTMLElement | null = null;
		let release: ReturnType<typeof setTimeout> | undefined;
		const follow = (from: HTMLElement, to: HTMLElement) => () => {
			if (lead !== null && lead !== from) return;
			lead = from;
			clearTimeout(release);
			release = setTimeout(() => {
				lead = null;
			}, 150);
			const room = from.scrollHeight - from.clientHeight;
			to.scrollTop = room > 0 ? (from.scrollTop / room) * (to.scrollHeight - to.clientHeight) : 0;
		};
		const fromSource = follow(src, out);
		const fromPreview = follow(out, src);
		src.addEventListener("scroll", fromSource, { passive: true });
		out.addEventListener("scroll", fromPreview, { passive: true });
		return () => {
			clearTimeout(release);
			src.removeEventListener("scroll", fromSource);
			out.removeEventListener("scroll", fromPreview);
		};
	}, [shown]);

	const pick = (next: ViewMode) => {
		setView(next);
		try {
			localStorage.setItem(VIEW_KEY, next);
		} catch {
			// A browser that keeps nothing shows the default next time.
		}
		// The focus goes to the pane that is shown when the one that had it is hidden.
		requestAnimationFrame(() => {
			const active = document.activeElement;
			if (next === "preview" && host.current?.contains(active)) previewBox.current?.focus();
			if (next === "source" && previewBox.current?.contains(active)) editor.current?.focus();
		});
	};

	const answer = (leave: boolean) => {
		const pending = asking;
		setAsking(null);
		if (leave) pending?.go();
		else pending?.stay?.();
	};

	const diff = useMemo(
		() => (diffOpen && disk.kind === "conflict" && disk.text !== null ? conflictDiff(path, disk.text, text) : null),
		[diffOpen, disk, text, path],
	);

	const status = saving
		? t("files.editSaving")
		: dirty
			? t("files.editUnsaved")
			: note === "saved"
				? t("files.editSaved")
				: note === "reloaded"
					? t("files.mdReloaded")
					: "";

	/** On a phone, the arrow keys on one tab pick the other and put the focus on it. */
	const other = (next: "source" | "preview") => () => {
		pick(next);
		requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="md-view-${next}"]`)?.focus());
	};
	const choices = (tabs: boolean) => (
		<>
			{tabs ? null : (
				<ViewChoice
					on={shown === "split"}
					label={t("files.mdViewSplit")}
					onPick={() => pick("split")}
					testid="md-view-split"
				>
					<Columns2 size={13} />
				</ViewChoice>
			)}
			<ViewChoice
				on={shown === "source"}
				label={t("files.mdViewSource")}
				onPick={() => pick("source")}
				testid="md-view-source"
				tab={tabs ? { controls: ids.source, onOther: other("preview") } : undefined}
			>
				<Code size={13} />
			</ViewChoice>
			<ViewChoice
				on={shown === "preview"}
				label={t("files.mdViewPreview")}
				onPick={() => pick("preview")}
				testid="md-view-preview"
				tab={tabs ? { controls: ids.preview, onOther: other("source") } : undefined}
			>
				<Eye size={13} />
			</ViewChoice>
		</>
	);

	return (
		<section className="flex min-h-0 flex-1 flex-col" aria-label={t("files.mdLabel", { name })}>
			<Header name={name} dir={dir} path={path}>
				<div
					className="min-w-0 shrink truncate text-xs text-muted max-md:order-last max-md:basis-full"
					role="status"
					data-testid="md-status"
				>
					{status}
				</div>
				{editable ? null : (
					<span
						className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted"
						title={t("files.mdReadOnlyHint")}
						data-testid="md-readonly"
					>
						{t("files.mdReadOnly")}
					</span>
				)}
				{narrow ? null : (
					<fieldset
						className="flex shrink-0 items-center rounded-lg border border-border p-0.5"
						aria-label={t("files.mdViewLabel")}
					>
						{choices(false)}
					</fieldset>
				)}
				{editable ? (
					<Button
						size="sm"
						variant="primary"
						data-testid="md-save"
						disabled={!dirty || saving}
						title="⌘S"
						onClick={() => void save()}
					>
						{t("files.editSave")}
					</Button>
				) : null}
			</Header>
			{narrow ? (
				<div
					className="flex shrink-0 gap-1 border-b border-border p-1"
					role="tablist"
					aria-label={t("files.mdViewLabel")}
				>
					{choices(true)}
				</div>
			) : null}
			{disk.kind === "conflict" ? (
				<div
					role="alert"
					className="shrink-0 border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs"
					data-testid="md-conflict"
				>
					<div className="font-medium">{t("files.editConflictTitle")}</div>
					<p className="mt-0.5 text-muted">{t("files.mdConflictBody", { name })}</p>
					<div className="mt-2 flex flex-wrap gap-2">
						<Button size="sm" data-testid="md-reload" disabled={saving} onClick={() => void reload()}>
							{t("files.editReload")}
						</Button>
						<Button
							size="sm"
							variant="danger"
							data-testid="md-overwrite"
							disabled={saving || !editable}
							onClick={() => void save(disk.etag)}
						>
							{t("files.editOverwrite")}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							data-testid="md-show-diff"
							aria-expanded={diffOpen}
							onClick={() => setDiffOpen((o) => !o)}
						>
							{diffOpen ? t("files.mdHideDiff") : t("files.mdShowDiff")}
						</Button>
					</div>
				</div>
			) : null}
			{disk.kind === "gone" || disk.kind === "unusable" ? (
				<div
					role="alert"
					className="flex shrink-0 flex-wrap items-center gap-2 border-b border-danger/40 bg-danger/10 px-3 py-2 text-xs"
					data-testid="md-gone"
				>
					<div className="min-w-0 flex-1">
						{disk.kind === "gone" ? (
							<>
								<div className="font-medium">{t("files.mdGoneTitle")}</div>
								<p className="mt-0.5 text-muted">{t("files.mdGoneBody", { name })}</p>
							</>
						) : (
							<p>{t("files.mdUnusable", { name })}</p>
						)}
					</div>
					<CopyText text={current} />
				</div>
			) : null}
			{problem !== null ? (
				<div
					role="alert"
					className="shrink-0 border-b border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
					data-testid="md-problem"
				>
					{problem}
				</div>
			) : null}
			{diffOpen && disk.kind === "conflict" ? (
				<section
					className="max-h-[40vh] shrink-0 overflow-auto border-b border-border"
					aria-label={t("files.mdDiffLabel")}
					data-testid="md-diff"
				>
					<p className="px-3 py-1 text-xs text-faint">{t("files.mdDiffLegend")}</p>
					{disk.text === null ? (
						<p className="px-3 pb-2 text-xs text-muted">{t("files.mdDiffTooLarge")}</p>
					) : diff && diff.view === "text" ? (
						<DiffBody diff={diff} split={false} lang="markdown" />
					) : (
						<p className="px-3 pb-2 text-xs text-muted">{t("files.mdDiffSame")}</p>
					)}
				</section>
			) : null}
			<div className="flex min-h-0 flex-1">
				<section
					id={ids.source}
					role={narrow ? "tabpanel" : undefined}
					aria-label={t("files.mdSourceText", { name })}
					className={cx(
						"min-h-0 min-w-0 flex-1 overflow-hidden",
						shown === "split" && "border-r border-border",
						shown === "preview" && "hidden",
					)}
					data-testid="md-source"
				>
					<div ref={host} className="h-full text-xs" data-editor="" />
				</section>
				<section
					ref={previewBox}
					id={ids.preview}
					role={narrow ? "tabpanel" : undefined}
					aria-label={t("files.mdPreviewLabel", { name })}
					tabIndex={0}
					className={cx(
						"min-h-0 min-w-0 flex-1 overflow-auto px-5 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:px-3",
						shown === "source" && "hidden",
					)}
					data-testid="md-preview"
				>
					<div className="mx-auto max-w-3xl">
						<MdPreview text={text} open={open} version={file.modified} />
					</div>
				</section>
			</div>
			<Modal
				open={asking !== null}
				onOpenChange={(o) => !o && answer(false)}
				title={t("files.editDiscardTitle")}
				description={t("files.editDiscardBody", { name })}
			>
				<div className="mt-2 flex flex-wrap justify-end gap-2">
					<Button variant="ghost" data-testid="md-keep" onClick={() => answer(false)}>
						{t("files.editKeepEditing")}
					</Button>
					<Button variant="danger" data-testid="md-discard" onClick={() => answer(true)}>
						{t("files.editDiscard")}
					</Button>
					{editable ? (
						<Button
							variant="primary"
							data-testid="md-save-close"
							onClick={() => {
								const pending = asking;
								setAsking(null);
								void saveRef.current().then((ok) => {
									if (ok) pending?.go();
									else pending?.stay?.();
								});
							}}
						>
							{t("files.mdSaveAndClose")}
						</Button>
					) : null}
				</div>
			</Modal>
		</section>
	);
}
