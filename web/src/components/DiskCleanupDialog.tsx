import type { DeletePreview, TrashPick } from "@shared/delete-cleanup.ts";
import type { DiskRow } from "@shared/disk-space.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { type Translate as TFunction, useT } from "../i18n/index.ts";
import { formatBytes } from "../lib/app-update.ts";
import { type DiskPreview, diskApi } from "../lib/disk-space.ts";
import { forgetDraft } from "../lib/drafts.ts";
import { fmtRelative, shortPath } from "../lib/format.ts";
import { useApp } from "../store/app.ts";
import { Options } from "./CleanupOptions.tsx";
import { Button, Modal, Spinner } from "./ui.tsx";

/**
 * The Disk space page's "Clean up…" dialog for one row (docs/superpowers/specs/2026-11-26-disk-space-page-design.md): its
 * conversations to delete, and its folder or dependency folders to move to the Trash, each ticked on its own. Nothing is
 * ticked at first; the server deletes the ticked conversations first, then checks every ticked path again and moves it.
 */

/** Refusals a deletion in the same request may lift (the conversations' own omp ends with the delete). */
const LIFTED_BY_DELETE = new Set(["inUse", "holdsConversations"]);

export function DiskCleanupDialog({ row, onClose }: { row: DiskRow; onClose: (changed: boolean) => void }) {
	const t = useT();
	const home = useApp((s) => s.meta?.home);
	const [preview, setPreview] = useState<DiskPreview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [files, setFiles] = useState<Set<string>>(new Set());
	const [picks, setPicks] = useState<Record<string, TrashPick>>({});
	const [checking, setChecking] = useState(false);
	const [working, setWorking] = useState(false);
	/** The conversations the folder part was last looked at as leaving. */
	const looked = useRef<string[]>([]);

	useEffect(() => {
		let gone = false;
		diskApi
			.preview(row.folder, [])
			.then((p) => !gone && setPreview(p))
			.catch((e) => !gone && setError((e as Error).message));
		return () => {
			gone = true;
		};
	}, [row.folder]);

	// A folder that only a ticked conversation keeps (its omp runs there, its transcript is kept there) is looked at again
	// with those leaving; and again when they are unticked, so that it is not offered on their account.
	const refused = preview?.cleanup?.folder?.refused ?? null;
	const ticked = useMemo(() => [...files].sort(), [files]);
	useEffect(() => {
		if (!preview?.cleanup) return;
		const same = ticked.join("\n") === looked.current.join("\n");
		if (same || (!(refused && LIFTED_BY_DELETE.has(refused)) && looked.current.length === 0)) return;
		let gone = false;
		setChecking(true);
		const timer = setTimeout(() => {
			diskApi
				.preview(row.folder, ticked)
				.then((p) => {
					if (gone) return;
					looked.current = ticked;
					setPreview((old) => (old ? { ...old, cleanup: p.cleanup } : p));
					// What is no longer offered is no longer ticked.
					const offered = new Set(
						[p.cleanup?.folder, ...(p.cleanup?.deps ?? [])].flatMap((x) => (x && x.refused === null ? [x.real] : [])),
					);
					setPicks((all) => Object.fromEntries(Object.entries(all).filter(([real]) => offered.has(real))));
				})
				.catch(() => {})
				.finally(() => !gone && setChecking(false));
		}, 300);
		return () => {
			gone = true;
			clearTimeout(timer);
		};
	}, [ticked, refused, preview?.cleanup, row.folder]);

	const conversations = preview?.conversations ?? [];
	const tickable = conversations.filter((c) => !c.busy);
	const cleanup = preview?.cleanup ?? null;
	const options: DeletePreview | null = cleanup
		? { file: row.folder, folder: cleanup.folder, deps: cleanup.deps }
		: null;
	const folderPick = cleanup?.folder ? picks[cleanup.folder.real] : undefined;
	/** What goes to the Trash: the ticked folder alone, else its ticked dependency folders. */
	const trash = folderPick ? [folderPick] : Object.values(picks);
	const frees =
		conversations.filter((c) => files.has(c.file)).reduce((n, c) => n + c.bytes, 0) +
		(folderPick
			? (cleanup?.folder?.bytes ?? row.folderBytes ?? 0)
			: (cleanup?.deps ?? []).filter((d) => picks[d.real]).reduce((n, d) => n + (d.bytes ?? 0), 0));
	const kept = conversations.length - files.size;

	const toggleFile = (file: string, on: boolean) =>
		setFiles((all) => {
			const next = new Set(all);
			if (on) next.add(file);
			else next.delete(file);
			return next;
		});
	const togglePick = (_file: string, pick: TrashPick, on: boolean) =>
		setPicks((all) => {
			const next = { ...all };
			if (on) next[pick.real] = pick;
			else delete next[pick.real];
			return next;
		});

	const confirm = async () => {
		setWorking(true);
		const { toast, loadSessions } = useApp.getState();
		try {
			const r = await diskApi.clean(row.folder, ticked, trash);
			for (const f of r.deleted) forgetDraft(f);
			if (r.failed.length) toast("error", t("diskSpace.notDeleted", { n: r.failed.length, error: r.failed[0].error }));
			for (const n of r.trashed.notMoved)
				toast("error", t("diskSpace.notMoved", { path: shortPath(n.path, home), error: n.error }));
			if (r.deleted.length || r.trashed.moved.length)
				toast("success", t("diskSpace.done", { deleted: r.deleted.length, moved: r.trashed.moved.length }));
			await loadSessions();
			onClose(true);
		} catch (e) {
			toast("error", t("diskSpace.failed", { error: (e as Error).message }));
			setWorking(false);
		}
	};

	const nothing = files.size === 0 && trash.length === 0;
	return (
		<Modal
			open
			wide
			onOpenChange={(o) => !o && !working && onClose(false)}
			title={t("diskSpace.dialogTitle", { name: row.name })}
			description={<span className="break-all">{shortPath(row.folder, home)}</span>}
		>
			<form
				data-testid="disk-cleanup"
				onSubmit={(e) => {
					e.preventDefault();
					if (!nothing) void confirm();
				}}
			>
				{error ? <p className="text-sm text-danger">{error}</p> : null}
				{preview === null && !error ? (
					<p className="flex items-center gap-2 text-xs text-muted">
						<Spinner size={12} /> {t("diskSpace.looking")}
					</p>
				) : null}
				{preview ? (
					<>
						<div className="mb-1 flex items-center justify-between">
							<h3 className="text-sm font-semibold">
								{t("diskSpace.conversationsHeading")} ({conversations.length})
							</h3>
							{tickable.length ? (
								<Button
									variant="ghost"
									size="sm"
									data-testid="disk-select-all"
									onClick={() =>
										setFiles(files.size === tickable.length ? new Set() : new Set(tickable.map((c) => c.file)))
									}
								>
									{files.size === tickable.length ? t("diskSpace.selectNone") : t("diskSpace.selectAll")}
								</Button>
							) : null}
						</div>
						{conversations.length ? (
							<ul
								data-testid="disk-conversations"
								className="mb-3 max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border bg-bg-soft p-2 text-sm"
							>
								{conversations.map((c) => (
									<li key={c.file}>
										<label className="flex cursor-pointer items-start gap-2 has-[:disabled]:cursor-default">
											<input
												type="checkbox"
												className="mt-1 accent-[var(--accent)]"
												data-testid="disk-conversation"
												checked={files.has(c.file)}
												disabled={c.busy}
												onChange={(e) => toggleFile(c.file, e.target.checked)}
											/>
											<span className="min-w-0 flex-1">
												<span className="block truncate">{c.title}</span>
												<span className="block text-xs text-muted">
													{fmtRelative(c.modifiedAt)} · {formatBytes(c.bytes)}
													{c.busy ? ` · ${t("diskSpace.busy")}` : ""}
												</span>
											</span>
										</label>
									</li>
								))}
							</ul>
						) : (
							<p className="mb-3 text-xs text-muted">{t("diskSpace.noConversations")}</p>
						)}
						<h3 className="mb-1 text-sm font-semibold">{t("diskSpace.folderHeading")}</h3>
						<FolderPart preview={preview} row={row} t={t} />
						{options ? (
							<div className={checking ? "opacity-60" : undefined}>
								<Options p={options} home={home} ticked={picks} toggle={togglePick} t={t} />
							</div>
						) : null}
						{folderPick && kept > 0 ? (
							<p className="mt-2 text-xs text-warning" data-testid="disk-kept-note">
								{kept === 1 ? t("diskSpace.keptNoteOne") : t("diskSpace.keptNote", { n: kept })}
							</p>
						) : null}
					</>
				) : null}
				<div className="mt-4 flex justify-end gap-2">
					<Button variant="ghost" disabled={working} onClick={() => onClose(false)}>
						{t("common.cancel")}
					</Button>
					<Button variant="danger" type="submit" data-testid="disk-confirm" disabled={working || checking || nothing}>
						{working ? <Spinner size={14} /> : null}
						{confirmLabel(files.size, trash.length, frees, t)}
					</Button>
				</div>
			</form>
		</Modal>
	);
}

/** Why the folder part offers nothing, when it does not. */
function FolderPart({ preview, row, t }: { preview: DiskPreview; row: DiskRow; t: TFunction }) {
	let why: string | null = null;
	if (row.kind === "protected") why = t("diskSpace.folderProtected");
	else if (row.real === null) why = t("diskSpace.folderGoneNote");
	else if (!preview.mayTrash) why = t("diskSpace.notAllowed");
	else if (!preview.trash) why = t("diskSpace.noTrash");
	return why ? <p className="text-xs text-muted">{why}</p> : null;
}

/** What the confirm button says it will do, and the room it frees. */
export function confirmLabel(conversations: number, items: number, frees: number, t: TFunction): string {
	const del = conversations
		? conversations === 1
			? t("diskSpace.confirmDeleteOne")
			: t("diskSpace.confirmDelete", { n: conversations })
		: null;
	const action =
		del && items
			? t("diskSpace.confirmBoth", {
					conversations: del,
					items: items === 1 ? t("diskSpace.confirmMoveLowerOne") : t("diskSpace.confirmMoveLower", { n: items }),
				})
			: (del ??
				(items
					? items === 1
						? t("diskSpace.confirmMoveOne")
						: t("diskSpace.confirmMove", { n: items })
					: t("diskSpace.confirmNothing")));
	return conversations || items ? t("diskSpace.confirmFrees", { action, size: formatBytes(frees) }) : action;
}
