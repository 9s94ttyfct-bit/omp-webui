import type { ChangeState } from "@shared/changes.ts";
import type { FolderFile } from "@shared/folder.ts";
import { Code, Columns2, Eye, FileDiff as FileDiffIcon, FileX, NotebookPen, Pencil, Rows3, X } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { en } from "../i18n/files.ts";
import { registerStrings, useT } from "../i18n/index.ts";
import { languageOf } from "../lib/files-rows.ts";
import type { FolderScope } from "../lib/folder-api.ts";
import { PANEL_SHEET_QUERY, useMediaQuery, useNarrowerThan } from "../lib/media.ts";
import { dismissOverlays } from "../store/app.ts";
import { type BigTarget, takeBigOpener } from "../store/big.ts";
import { uiOf, useChanges } from "../store/changes.ts";
import { keyOf, useTree } from "../store/files.ts";
import { openMdEditor } from "../store/md-editor.ts";
import { DiffBody, DiffNote } from "./changes/DiffBody.tsx";
import { SPLIT_MIN_PX, useDiff, versionOf } from "./changes/use-diff.ts";
import { FileBody, FileNotices, useFile } from "./files/FileBody.tsx";
import { Button, cx, Empty, IconButton, Spinner } from "./ui.tsx";

// Opened from the side panel, of either view: its strings are the Files tab's own (this chunk registers them, as
// `FilesPane` does for the panel).
registerStrings("files", en);

/** The editor and CodeMirror with it: fetched when Edit is pressed, not with this view. */
const FileEditor = lazy(() => import("./files/FileEditor.tsx"));

type TextFile = Extract<FolderFile, { kind: "text" }>;

/**
 * A file, or the change of one, opened large in place of the conversation's column: it covers the column (header, transcript
 * and message box) until it is closed. What it covers is not unmounted, only hidden from the eye and from assistive
 * technology, so closing it comes back exactly as it was — where the reader was in the transcript, and what they had typed.
 *
 * The file and the change are the Files tab's own reads, with its limits and its syntax colour, and the path is the one the
 * panel names. The one thing that writes is the editor of a text file (`FileEditor.tsx`, from the Edit button); a file with
 * text that is not saved there is not left without asking (`lib/leave-guard.ts`: closing, another file, another view). It is
 * not a modal dialog: the panel it was opened from stays usable beside it, where the panel is a column, so focus is not
 * trapped; it moves in when the view opens and back to the control that opened it when the view closes. What is under the
 * column it covers is hidden from the eye — and, with it, from the keyboard and from assistive technology — for as long as
 * it is up.
 */
export default function BigView({
	scope,
	target,
	onClose,
}: {
	scope: FolderScope;
	target: BigTarget;
	onClose: () => void;
}) {
	const t = useT();
	const path = target.path;
	const slash = path.lastIndexOf("/");
	const name = path.slice(slash + 1);
	const dir = slash < 0 ? "" : path.slice(0, slash);
	// Below the width at which the side panel is a sheet, the panel is over the page anyway: this takes the whole window.
	const sheet = useMediaQuery(PANEL_SHEET_QUERY);
	const [box, setBox] = useState<HTMLElement | null>(null);
	const wide = !useNarrowerThan(box, SPLIT_MIN_PX);
	const [mode, setMode] = useState<"unified" | "split">("split");
	const split = wide && mode === "split";

	// Focus comes in here once, and goes back — once — to the control that opened the view (in the panel, still there).
	// The element is taken here rather than through the effect's dependency: a second run would have nothing left to give
	// focus back to.
	const frame = useRef<HTMLElement | null>(null);
	const take = useCallback((el: HTMLElement | null) => {
		frame.current = el;
		setBox(el);
	}, []);
	useEffect(() => {
		frame.current?.focus();
		return () => {
			takeBigOpener()?.focus();
		};
	}, []);

	// Escape is read before the page's own handlers (capture): the Stop key of a running reply and the sheet's own Escape are
	// for the view under them, and the ones that follow check `defaultPrevented`.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented || e.repeat || e.isComposing || e.keyCode === 229) return;
			// The editor's own (it closes its find panel): it does not close the view over text that is not saved.
			if (e.target instanceof Element && e.target.closest("[data-editor]")) return;
			// Search, the shortcuts list or the feedback form is over everything: Escape is theirs.
			if (dismissOverlays()) {
				e.preventDefault();
				return;
			}
			// A menu, a list or a dialog of the page's own is what the key is for; so is a toast someone is reading.
			if (document.querySelector('[role="menu"], [role="listbox"], [role="alertdialog"], [role="dialog"]')) return;
			if (e.target instanceof Element && e.target.closest("[data-toast-region]")) return;
			e.preventDefault();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	return (
		<section
			ref={take}
			aria-label={t(target.kind === "diff" ? "files.diffLabel" : "files.largeAria", { name })}
			tabIndex={-1}
			className={cx(
				"absolute inset-0 flex flex-col bg-bg outline-none fade-in",
				// Over the side panel's sheet, which is `fixed … z-30` below the width at which a panel becomes one.
				sheet ? "fixed inset-0 z-40" : "z-10",
			)}
			data-testid="big-view"
			data-kind={target.kind}
			data-path={path}
		>
			<div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-semibold" title={path} data-testid="big-name">
						{name}
					</div>
					{dir ? (
						<div className="truncate font-mono text-xs text-faint" title={path} data-testid="big-dir">
							{dir}
						</div>
					) : null}
				</div>
				{target.kind === "diff" && wide ? (
					<fieldset
						className="flex shrink-0 items-center rounded-lg border border-border p-0.5"
						aria-label={t("files.diffModeLabel")}
					>
						<Mode
							on={!split}
							label={t("files.diffUnified")}
							onPick={() => setMode("unified")}
							testid="big-diff-unified"
						>
							<Rows3 size={13} />
						</Mode>
						<Mode on={split} label={t("files.diffSplit")} onPick={() => setMode("split")} testid="big-diff-split">
							<Columns2 size={13} />
						</Mode>
					</fieldset>
				) : null}
				<IconButton label={t("common.close")} size="sm" data-testid="big-close" onClick={onClose}>
					<X size={15} />
				</IconButton>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">
				{target.kind === "diff" ? (
					<DiffLarge scope={scope} path={path} split={split} wide={wide} />
				) : (
					<FileLarge key={path} scope={scope} path={path} />
				)}
			</div>
		</section>
	);
}

/** One of the two ways a change is drawn, as the Changes view draws its switch (its own test ids here). */
function Mode({
	on,
	label,
	onPick,
	testid,
	children,
}: {
	on: boolean;
	label: string;
	onPick: () => void;
	testid: string;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={on}
			aria-label={label}
			title={label}
			data-testid={testid}
			className={cx(
				"inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs max-lg:min-h-9",
				on ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg",
			)}
			onClick={onPick}
		>
			{children}
		</button>
	);
}

/** What makes one file's change another: its state, its counts, and (for a list read again) that it is still there. */
const STATE_MARK: Record<ChangeState, { letter: string; word: string; tone: string }> = {
	modified: { letter: "M", word: "files.stateModified", tone: "text-accent" },
	added: { letter: "A", word: "files.stateAdded", tone: "text-success" },
	deleted: { letter: "D", word: "files.stateDeleted", tone: "text-danger" },
	renamed: { letter: "R", word: "files.stateRenamed", tone: "text-accent" },
	typechange: { letter: "T", word: "files.stateTypechange", tone: "text-warning" },
	untracked: { letter: "U", word: "files.stateUntracked", tone: "text-success" },
	conflict: { letter: "!", word: "files.stateConflict", tone: "text-danger" },
};

/** A file's state, as the Changes view marks it: a letter, a word, and a tint that is never the only cue. */
function StateMark({ state }: { state: ChangeState }) {
	const t = useT();
	const mark = STATE_MARK[state];
	return (
		<span className="shrink-0" data-testid="big-state" data-state={state}>
			<span className={cx("font-semibold", mark.tone)} aria-hidden>
				{mark.letter}
			</span>{" "}
			{t(mark.word as "files.stateModified")}
		</span>
	);
}

/**
 * The change of one file, as the Changes view draws it: unified (old and new line numbers, a sign, a tint) or side by side
 * (what this room is for), coloured by the file's language, with the same row limit and the same "show all".
 */
function DiffLarge({ scope, path, split, wide }: { scope: FolderScope; path: string; split: boolean; wide: boolean }) {
	const t = useT();
	const changes = useChanges((s) => uiOf(s, keyOf(scope)).data);
	const file = changes?.files.find((f) => f.path === path);
	const opened = useDiff(scope, path, versionOf(file));
	const name = path.slice(path.lastIndexOf("/") + 1);
	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="big-diff">
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1 text-xs text-faint">
				{file ? <StateMark state={file.state} /> : null}
				{file?.added !== undefined && file.removed !== undefined ? (
					<span className="font-mono tabular-nums" aria-hidden>
						<span className="text-success">+{file.added}</span> <span className="text-danger">−{file.removed}</span>
					</span>
				) : null}
				{opened.state === "ok" && opened.diff.mode ? <span>{t("files.diffMode", opened.diff.mode)}</span> : null}
				{opened.state === "ok" && opened.diff.from ? (
					<span className="truncate">{t("files.changesFrom", { from: opened.diff.from })}</span>
				) : null}
				{wide ? null : <span className="ml-auto">{t("files.diffUnifiedOnly")}</span>}
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{opened.state === "loading" ? (
					<div className="flex justify-center py-10">
						<Spinner />
					</div>
				) : opened.state === "error" ? (
					<Empty
						icon={<FileDiffIcon size={22} />}
						title={opened.gone ? t("files.diffGone") : t("files.diffError", { error: opened.message })}
					/>
				) : opened.diff.view === "text" ? (
					<DiffBody diff={opened.diff} split={split} lang={languageOf(name)} />
				) : (
					<DiffNote diff={opened.diff} />
				)}
			</div>
		</div>
	);
}

/**
 * One file, as the Files tab previews it (code with its line numbers, Markdown rendered with its source one click away, a
 * picture, or the words that it is a binary file), followed while omp writes it. A text file that can be edited has an Edit
 * button: the editor (`FileEditor.tsx`) replaces the body until it is closed, and is the one thing in this view that writes.
 */
function FileLarge({ scope, path }: { scope: FolderScope; path: string }) {
	const t = useT();
	const reads = useTree(keyOf(scope)).reads;
	/**
	 * The editor, when it is open: the file it was opened with, and the count of the folder's reads then. While it is open the
	 * file is not read again whatever the folder says (a change of the folder would otherwise take the text from under what
	 * is being typed); the save finds out whether the file on the computer is still the one the text was made from.
	 */
	const [session, setSession] = useState<{ file: TextFile; reads: number } | null>(null);
	const [loaded, put] = useFile(scope, path, session?.reads ?? reads);
	const [source, setSource] = useState(false);
	const bar = useRef<HTMLDivElement>(null);
	const wasEditing = useRef(false);
	const editing = session !== null;
	// Closing the editor gives focus back to the button that opened it.
	useEffect(() => {
		if (wasEditing.current && !editing) bar.current?.querySelector<HTMLElement>("[data-edit]")?.focus();
		wasEditing.current = editing;
	}, [editing]);
	const file = loaded.state === "ok" ? loaded.file : null;
	const rendered = file?.kind === "text" && file.view !== "code";
	const editable = file?.kind === "text" && file.editable;
	const markdown = file?.kind === "text" && file.view === "markdown";
	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="big-file">
			{session ? (
				<Suspense
					fallback={
						<div className="flex justify-center py-10" role="status" aria-label={t("files.editorLoading")}>
							<Spinner />
						</div>
					}
				>
					<FileEditor scope={scope} file={session.file} onFile={put} onClose={() => setSession(null)} />
				</Suspense>
			) : (
				<>
					{rendered || editable ? (
						<div ref={bar} className="flex shrink-0 items-center justify-end gap-1 border-b border-border px-2 py-1">
							{editable ? (
								<Button
									size="sm"
									variant="ghost"
									data-testid="big-edit"
									data-edit=""
									title={t("files.editHint")}
									onClick={() => setSession({ file, reads })}
								>
									<Pencil size={13} /> {t("files.edit")}
								</Button>
							) : null}
							{markdown ? (
								<Button
									size="sm"
									variant="ghost"
									data-testid="big-md-editor"
									onClick={(e) => openMdEditor(keyOf(scope), path, e.currentTarget)}
								>
									<NotebookPen size={13} /> {t("files.mdOpen")}
								</Button>
							) : null}
							{rendered ? (
								<IconButton
									label={source ? t("files.viewRendered") : t("files.viewSource")}
									size="sm"
									data-testid="big-file-source"
									active={source}
									aria-pressed={source}
									onClick={() => setSource((s) => !s)}
								>
									{source ? <Eye size={14} /> : <Code size={14} />}
								</IconButton>
							) : null}
						</div>
					) : null}
					<FileNotices file={file} source={source} />
					<div className="min-h-0 flex-1 overflow-auto bg-code" data-testid="big-file-body">
						{loaded.state === "loading" ? (
							<div className="flex justify-center py-10">
								<Spinner />
							</div>
						) : loaded.state === "error" ? (
							<Empty icon={<FileX size={22} />} title={t("files.previewFailedTitle")}>
								{loaded.gone ? t("files.fileGone") : loaded.message}
							</Empty>
						) : (
							<FileBody scope={scope} file={loaded.file} source={source} />
						)}
					</div>
				</>
			)}
		</div>
	);
}
