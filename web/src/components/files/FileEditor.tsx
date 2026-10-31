import type { Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { FOLDER_LIMITS, type FolderFile } from "@shared/folder.ts";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { eolOf, saveFailureText, saveFile } from "../../lib/file-save.ts";
import { fmtBytes } from "../../lib/files-rows.ts";
import { type FolderScope, folder } from "../../lib/folder-api.ts";
import { holdLeaveGuard } from "../../lib/leave-guard.ts";
import { inConversation } from "../../lib/same-conversation.ts";
import { TransferError } from "../../lib/transfer-api.ts";
import { Button, Modal } from "../ui.tsx";
import { EditorView, editorState, SEARCH_PHRASES, setLanguage } from "./code-editor.ts";

/**
 * The editor of the large view: the text of one file in CodeMirror, with Save (⌘S, Ctrl+S) and Cancel, what to do when the
 * file changed on the computer meanwhile (Reload or Overwrite), and the question that is asked before unsaved text is lost.
 * It is loaded when Edit is pressed (`BigView.tsx`), with the editor's code.
 *
 * The text it is given is the file's as the large view read it, with the `etag` that read had; every save names the etag of
 * what the text was made from, and the answer names the next one. What was typed is the page's until it is saved: nothing
 * reads the file again behind it (`BigView.tsx` holds the folder's changes back for as long as the editor is open), and what
 * would take the person away from it asks first (`lib/leave-guard.ts`: another view, another conversation, the large view
 * closing or showing another file; a reload or a closed tab is the browser's to ask).
 */

type TextFile = Extract<FolderFile, { kind: "text" }>;

export default function FileEditor({
	scope,
	file,
	onFile,
	onClose,
}: {
	scope: FolderScope;
	file: TextFile;
	/** The file as it is on the computer now (after a save, or a reload): the view behind the editor shows it. */
	onFile: (file: FolderFile) => void;
	onClose: () => void;
}) {
	const t = useT();
	const name = file.path.slice(file.path.lastIndexOf("/") + 1);
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	/** What the text on screen was made from: the file's etag, its text as the editor holds it, and the line ending it is saved with. */
	const base = useRef({ etag: file.etag, doc: null as Text | null, eol: eolOf(file.text) });
	const busy = useRef(false);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [justSaved, setJustSaved] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	/** The etag the file has on the computer now, when a save found it is not the one the text was made from. */
	const [conflict, setConflict] = useState<string | null>(null);
	const [reloading, setReloading] = useState(false);
	const [asking, setAsking] = useState<{ go: () => void; stay?: () => void } | null>(null);
	// What the handlers below read at the moment they run: this render's, whichever render registered them.
	const latest = useRef({ scope, file, onFile, onClose, t, save: async (_overwrite?: string) => {} });

	const config = () => ({
		name,
		label: latest.current.t("files.editorText", { name }),
		phrases: Object.fromEntries(Object.entries(SEARCH_PHRASES).map(([phrase, key]) => [phrase, latest.current.t(key)])),
		onUpdate: (u: ViewUpdate) => {
			if (!u.docChanged || base.current.doc === null) return;
			setDirty(!u.state.doc.eq(base.current.doc));
			setJustSaved(false);
		},
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: once per time the editor is opened: the text it opens with is the one it keeps
	useEffect(() => {
		const parent = host.current;
		if (!parent) return;
		const state = editorState(file.text, config());
		base.current.doc = state.doc;
		const editor = new EditorView({ state, parent });
		view.current = editor;
		editor.focus();
		void setLanguage(editor, name);
		return () => {
			editor.destroy();
			view.current = null;
		};
	}, []);

	async function save(overwrite?: string): Promise<void> {
		const editor = view.current;
		if (!editor || busy.current) return;
		const snapshot = editor.state.doc;
		if (overwrite === undefined && base.current.doc !== null && snapshot.eq(base.current.doc)) return;
		const text = snapshot.sliceString(0, snapshot.length, base.current.eol);
		if (new TextEncoder().encode(text).length > FOLDER_LIMITS.editBytes) {
			setProblem(t("files.editTooLarge", { limit: fmtBytes(FOLDER_LIMITS.editBytes) }));
			return;
		}
		busy.current = true;
		setSaving(true);
		setProblem(null);
		try {
			const done = await saveFile(latest.current.scope, latest.current.file.path, text, overwrite ?? base.current.etag);
			base.current.etag = done.etag;
			base.current.doc = snapshot;
			setConflict(null);
			// More may have been typed while the request was on its way: that is not saved.
			setDirty(!editor.state.doc.eq(snapshot));
			setJustSaved(true);
			latest.current.onFile({
				...latest.current.file,
				text,
				etag: done.etag,
				size: done.size,
				modified: done.modified,
			});
		} catch (e) {
			if (e instanceof TransferError && e.code === "conflict" && e.etag) setConflict(e.etag);
			else setProblem(t("files.editSaveFailed", { reason: saveFailureText(e, name) }));
		} finally {
			busy.current = false;
			setSaving(false);
		}
	}
	latest.current = { scope, file, onFile, onClose, t, save };

	/** Drop what was typed and take what is on the computer now. A file that can no longer be edited ends the editing. */
	async function reload(): Promise<void> {
		if (reloading) return;
		setReloading(true);
		setProblem(null);
		try {
			const next = await folder.file(scope, file.path);
			onFile(next);
			const editor = view.current;
			if (next.kind !== "text" || !next.editable || !editor) {
				onClose();
				return;
			}
			// A new state, so that what was undone before is not undone into the file as it is now.
			const state = editorState(next.text, config());
			editor.setState(state);
			void setLanguage(editor, name);
			base.current = { etag: next.etag, doc: state.doc, eol: eolOf(next.text) };
			setDirty(false);
			setConflict(null);
			setJustSaved(false);
		} catch (e) {
			setProblem(t("files.editReloadFailed", { reason: e instanceof Error ? e.message : String(e) }));
		} finally {
			setReloading(false);
		}
	}

	// ⌘S and Ctrl+S save, wherever in the view the focus is (the browser would offer to save the page).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "s") return;
			e.preventDefault();
			if (!e.repeat) void latest.current.save();
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
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", onUnload);
		return () => {
			release();
			window.removeEventListener("beforeunload", onUnload);
		};
	}, [dirty]);

	const answer = (leave: boolean) => {
		const pending = asking;
		setAsking(null);
		if (leave) pending?.go();
		else pending?.stay?.();
	};

	return (
		<section
			className="flex h-full min-h-0 flex-col"
			data-testid="big-editor"
			aria-label={t("files.editorLabel", { name })}
		>
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
				<div className="min-w-0 flex-1 truncate text-xs text-muted" role="status" data-testid="big-edit-status">
					{saving ? t("files.editSaving") : dirty ? t("files.editUnsaved") : justSaved ? t("files.editSaved") : ""}
				</div>
				<Button
					size="sm"
					variant="ghost"
					data-testid="big-edit-cancel"
					onClick={() => (dirty ? setAsking({ go: onClose }) : onClose())}
				>
					{dirty ? t("files.editCancel") : t("files.editDone")}
				</Button>
				<Button
					size="sm"
					variant="primary"
					data-testid="big-edit-save"
					disabled={!dirty || saving || reloading}
					onClick={() => void save()}
				>
					{t("files.editSave")}
				</Button>
			</div>
			{conflict !== null ? (
				<div
					role="alert"
					className="shrink-0 border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs"
					data-testid="big-edit-conflict"
				>
					<div className="font-medium">{t("files.editConflictTitle")}</div>
					<p className="mt-0.5 text-muted">{t("files.editConflictBody", { name })}</p>
					<div className="mt-2 flex flex-wrap gap-2">
						<Button
							size="sm"
							data-testid="big-edit-reload"
							disabled={saving || reloading}
							onClick={() => void reload()}
						>
							{t("files.editReload")}
						</Button>
						<Button
							size="sm"
							variant="danger"
							data-testid="big-edit-overwrite"
							disabled={saving || reloading}
							onClick={() => void save(conflict)}
						>
							{t("files.editOverwrite")}
						</Button>
					</div>
				</div>
			) : null}
			{problem !== null ? (
				<div
					role="alert"
					className="shrink-0 border-b border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
					data-testid="big-edit-problem"
				>
					{problem}
				</div>
			) : null}
			{/* Escape belongs to the editor here (it closes the find panel): it does not close the view over unsaved text. */}
			<div ref={host} className="min-h-0 flex-1 overflow-hidden text-xs" data-editor="" data-testid="big-edit-body" />
			<Modal
				open={asking !== null}
				onOpenChange={(open) => !open && answer(false)}
				title={t("files.editDiscardTitle")}
				description={t("files.editDiscardBody", { name })}
			>
				<div className="mt-2 flex justify-end gap-2">
					<Button variant="ghost" data-testid="big-edit-keep" onClick={() => answer(false)}>
						{t("files.editKeepEditing")}
					</Button>
					<Button variant="danger" data-testid="big-edit-discard" onClick={() => answer(true)}>
						{t("files.editDiscard")}
					</Button>
				</div>
			</Modal>
		</section>
	);
}
