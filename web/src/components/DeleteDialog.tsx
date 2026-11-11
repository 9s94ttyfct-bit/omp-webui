import type {
	CleanupDep,
	CleanupFolder,
	DeletePreview,
	DeletePreviewAnswer,
	GitRisk,
	TrashPick,
	TrashResult,
	UsedBy,
} from "@shared/delete-cleanup.ts";
import type { SessionSummary } from "@shared/protocol.ts";
import { useEffect, useMemo, useState } from "react";
import { en } from "../i18n/delete-dialog.ts";
import { registerStrings, type Translate as TFunction, useT } from "../i18n/index.ts";
import { post } from "../lib/api.ts";
import { formatBytes } from "../lib/app-update.ts";
import { forgetDraft } from "../lib/drafts.ts";
import { shortPath } from "../lib/format.ts";
import { useApp } from "../store/app.ts";
import { sessionLabel } from "./SessionItem.tsx";
import { Button, Modal, Spinner } from "./ui.tsx";

// This chunk carries its own English strings: the first page does not (see `registerStrings`).
registerStrings("deleteDialog", en);

/**
 * The sidebar's delete dialogs, one conversation (its menu's Delete…) or the selected ones, with what the delete may move
 * to the Trash (docs/superpowers/specs/2026-11-11-delete-session-folder-design.md): each conversation's folder, or some of
 * the dependency folders in it, as the server previews them. Nothing is ticked at first; the server checks every ticked
 * path again when it moves it. A chunk of its own: the first page does not carry it.
 */

/** What a deleted conversation's moves came to, from either delete route. */
type Trashed = Record<string, TrashResult | undefined>;

export function DeleteDialog({
	sessions,
	bulk,
	busy,
	activeFile,
	returnTo,
	onClose,
}: {
	sessions: SessionSummary[];
	/** The selection's dialog: every conversation listed, each with its own options. */
	bulk: boolean;
	/** Replying, asking or paused: omp would refuse to delete it (the single dialog says so first). */
	busy: boolean;
	activeFile: string | null;
	returnTo: HTMLElement | null;
	/** `deleted`: something was deleted (the selection ends). */
	onClose: (deleted: boolean) => void;
}) {
	const t = useT();
	const home = useApp((s) => s.meta?.home);
	const [answer, setAnswer] = useState<DeletePreviewAnswer | null>(null);
	/** The ticked paths, by conversation file, by real path. */
	const [ticked, setTicked] = useState<Record<string, Record<string, TrashPick>>>({});
	const [working, setWorking] = useState(false);
	const files = useMemo(() => sessions.map((s) => s.file), [sessions]);

	useEffect(() => {
		let gone = false;
		post<DeletePreviewAnswer>("/api/session/delete-preview", { files })
			.then((a) => !gone && setAnswer(a))
			// No preview (an older server, a failure): the delete is offered as it always was.
			.catch(() => !gone && setAnswer({ trash: false, previews: [] }));
		return () => {
			gone = true;
		};
	}, [files]);

	const toggle = (file: string, pick: TrashPick, on: boolean) =>
		setTicked((all) => {
			const mine = { ...all[file] };
			if (on) mine[pick.real] = pick;
			else delete mine[pick.real];
			return { ...all, [file]: mine };
		});
	/** What goes with the delete: a ticked folder alone, else its ticked dependency folders. */
	const picksOf = (p: DeletePreview): TrashPick[] => {
		const mine = ticked[p.file] ?? {};
		const folder = p.folder ? mine[p.folder.real] : undefined;
		return folder ? [folder] : Object.values(mine);
	};
	const previews = answer?.previews ?? [];
	const count = previews.reduce((n, p) => n + picksOf(p).length, 0);

	const confirm = async () => {
		if (busy) return;
		setWorking(true);
		const { toast, setView, loadSessions } = useApp.getState();
		const trash = Object.fromEntries(previews.map((p) => [p.file, picksOf(p)]).filter(([, list]) => list.length));
		let deleted: string[] = [];
		let trashed: Trashed = {};
		try {
			if (bulk) {
				const r = await post<{ deleted: string[]; failed: { error: string }[]; trashed: Trashed }>(
					"/api/sessions/delete",
					{ files, trash },
				);
				deleted = r.deleted;
				trashed = r.trashed;
				if (r.failed.length)
					toast("error", t("deleteDialog.sidebarBulkDeleteFailed", { n: r.failed.length, error: r.failed[0].error }));
			} else {
				const file = files[0];
				const r = await post<{ trashed?: TrashResult }>("/api/session/delete", { file, trash: trash[file] ?? [] });
				deleted = [file];
				trashed = { [file]: r.trashed };
			}
		} catch (e) {
			toast("error", t("deleteDialog.sidebarDeleteFailed", { error: (e as Error).message }));
			setWorking(false);
			return;
		}
		const notMoved = Object.values(trashed).flatMap((r) => r?.notMoved ?? []);
		if (notMoved.length === 1)
			toast(
				"error",
				t("deleteDialog.cleanupNotMoved", { path: shortPath(notMoved[0].path, home), error: notMoved[0].error }),
			);
		else if (notMoved.length > 1)
			toast(
				"error",
				t("deleteDialog.cleanupNotMovedMore", {
					n: notMoved.length,
					path: shortPath(notMoved[0].path, home),
					error: notMoved[0].error,
				}),
			);
		if (activeFile && deleted.includes(activeFile)) setView({ kind: "new" });
		await loadSessions();
		// omp can report a failure for a delete that did remove the file: whatever the list no longer has is gone.
		const left = new Set(useApp.getState().sessions.map((s) => s.file));
		for (const file of files) if (deleted.includes(file) || !left.has(file)) forgetDraft(file);
		setWorking(false);
		onClose(true);
	};

	const single = sessions[0];
	return (
		<Modal
			open
			onOpenChange={(o) => !o && !working && onClose(false)}
			returnFocusTo={returnTo}
			title={
				bulk
					? t(
							sessions.length === 1 ? "deleteDialog.sidebarBulkDeleteTitleOne" : "deleteDialog.sidebarBulkDeleteTitle",
							{
								n: sessions.length,
							},
						)
					: t("deleteDialog.sidebarDeleteTitle")
			}
			description={
				bulk
					? t(
							sessions.length === 1
								? "deleteDialog.sidebarBulkDeleteDescriptionOne"
								: "deleteDialog.sidebarBulkDeleteDescription",
						)
					: t(busy ? "deleteDialog.sidebarDeleteBusy" : "deleteDialog.sidebarDeleteDescription", {
							title: sessionLabel(single),
						})
			}
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void confirm();
				}}
			>
				{bulk ? (
					<ul
						aria-label={t("deleteDialog.sidebarBulkDeleteList")}
						data-testid="bulk-delete-list"
						className="mb-3 max-h-80 space-y-1 overflow-y-auto rounded-lg border border-border bg-bg-soft p-2 text-sm"
					>
						{sessions.map((s, i) => {
							const p = previews[i];
							const offers = p ? offered(p) : 0;
							return (
								<li key={s.file}>
									{offers ? (
										<details>
											<summary className="cursor-pointer truncate">
												{sessionLabel(s)}{" "}
												<span className="text-xs text-muted">{t("deleteDialog.cleanupOffers", { n: offers })}</span>
											</summary>
											<Options p={p} home={home} ticked={ticked[s.file] ?? {}} toggle={toggle} t={t} />
										</details>
									) : (
										<div className="truncate">{sessionLabel(s)}</div>
									)}
								</li>
							);
						})}
					</ul>
				) : previews[0] ? (
					<Options p={previews[0]} home={home} ticked={ticked[single.file] ?? {}} toggle={toggle} t={t} />
				) : null}
				{answer === null && !busy ? (
					<p className="flex items-center gap-2 text-xs text-muted">
						<Spinner size={12} /> {t("deleteDialog.cleanupLooking")}
					</p>
				) : null}
				{count ? (
					<p className="mt-2 text-xs text-muted" data-testid="cleanup-summary">
						{t(count === 1 ? "deleteDialog.cleanupSummaryOne" : "deleteDialog.cleanupSummary", { n: count })}
					</p>
				) : null}
				<div className="mt-3 flex justify-end gap-2">
					<Button variant="ghost" disabled={working} onClick={() => onClose(false)}>
						{t("common.cancel")}
					</Button>
					<Button
						variant="danger"
						type="submit"
						data-testid={bulk ? "confirm-bulk-delete" : "confirm-session-action"}
						disabled={working || busy}
					>
						{working ? <Spinner size={14} /> : null}
						{t("common.delete")}
					</Button>
				</div>
			</form>
		</Modal>
	);
}

/** How many things a preview offers to move. */
function offered(p: DeletePreview): number {
	return (p.folder && p.folder.refused === null ? 1 : 0) + p.deps.filter((d) => d.refused === null).length;
}

function Options({
	p,
	home,
	ticked,
	toggle,
	t,
}: {
	p: DeletePreview;
	home: string | undefined;
	ticked: Record<string, TrashPick>;
	toggle: (file: string, pick: TrashPick, on: boolean) => void;
	t: TFunction;
}) {
	if (!p.folder && p.deps.length === 0) return null;
	const folderOn = p.folder ? ticked[p.folder.real] !== undefined : false;
	const size = (bytes: number | null) => (bytes === null ? t("deleteDialog.cleanupSizeUnknown") : formatBytes(bytes));
	return (
		<div className="mt-2 space-y-1.5 text-sm" data-testid="delete-cleanup">
			{p.folder ? (
				<FolderRow folder={p.folder} file={p.file} home={home} on={folderOn} toggle={toggle} size={size} t={t} />
			) : null}
			{p.deps.length ? (
				<>
					<p className="pt-1 text-xs text-muted">{t("deleteDialog.cleanupDeps")}</p>
					{p.deps.map((d) => (
						<DepRow
							key={d.real}
							dep={d}
							file={p.file}
							home={home}
							on={folderOn || ticked[d.real] !== undefined}
							disabled={folderOn || d.refused !== null}
							toggle={toggle}
							size={size}
							t={t}
						/>
					))}
				</>
			) : null}
		</div>
	);
}

function FolderRow({
	folder,
	file,
	home,
	on,
	toggle,
	size,
	t,
}: {
	folder: CleanupFolder;
	file: string;
	home: string | undefined;
	on: boolean;
	toggle: (file: string, pick: TrashPick, on: boolean) => void;
	size: (bytes: number | null) => string;
	t: TFunction;
}) {
	const refusal = refusalText(folder, t);
	return (
		<div>
			<label className="flex cursor-pointer items-start gap-2 has-[:disabled]:cursor-default">
				<input
					type="checkbox"
					className="mt-1 accent-[var(--accent)]"
					data-testid="cleanup-folder"
					checked={on}
					disabled={folder.refused !== null}
					onChange={(e) => toggle(file, { path: folder.path, real: folder.real, git: folder.git }, e.target.checked)}
				/>
				<span className="min-w-0">
					<span className="block">{t("deleteDialog.cleanupFolder")}</span>
					<span className="block break-all text-xs text-muted">
						{shortPath(folder.path, home)} · {size(folder.bytes)}
					</span>
				</span>
			</label>
			{refusal ? <p className="ml-6 text-xs text-muted">{refusal}</p> : null}
			{folder.git && folder.refused === null ? (
				<p className="ml-6 text-xs text-warning" data-testid="cleanup-git">
					⚠ {gitText(folder.git, t)}
				</p>
			) : null}
			{folder.worktree && folder.refused === null ? (
				<p className="ml-6 text-xs text-muted">{t("deleteDialog.cleanupWorktree")}</p>
			) : null}
		</div>
	);
}

function DepRow({
	dep,
	file,
	home,
	on,
	disabled,
	toggle,
	size,
	t,
}: {
	dep: CleanupDep;
	file: string;
	home: string | undefined;
	on: boolean;
	disabled: boolean;
	toggle: (file: string, pick: TrashPick, on: boolean) => void;
	size: (bytes: number | null) => string;
	t: TFunction;
}) {
	return (
		<div>
			<label className="flex cursor-pointer items-start gap-2 has-[:disabled]:cursor-default">
				<input
					type="checkbox"
					className="mt-1 accent-[var(--accent)]"
					data-testid="cleanup-dep"
					checked={on}
					disabled={disabled}
					onChange={(e) => toggle(file, { path: dep.path, real: dep.real, git: null }, e.target.checked)}
				/>
				<span className="min-w-0 break-all text-xs">
					{shortPath(dep.path, home)} <span className="text-muted">· {size(dep.bytes)}</span>
				</span>
			</label>
			{dep.refused ? (
				<p className="ml-6 text-xs text-muted">
					{dep.refused === "unchecked"
						? t("deleteDialog.cleanupRefusedUnchecked")
						: t("deleteDialog.cleanupDepRunning", { who: whoText(dep.usedBy, t) })}
				</p>
			) : null}
		</div>
	);
}

function refusalText(folder: CleanupFolder, t: TFunction): string | null {
	switch (folder.refused) {
		case null:
			return null;
		case "home":
			return t("deleteDialog.cleanupRefusedHome");
		case "system":
			return t("deleteDialog.cleanupRefusedSystem");
		case "data":
			return t("deleteDialog.cleanupRefusedData");
		case "unchecked":
			return t("deleteDialog.cleanupRefusedUnchecked");
		case "inUse":
			return t("deleteDialog.cleanupRefusedInUse", { who: whoText(folder.usedBy, t) });
		case "containsOther":
			return t("deleteDialog.cleanupRefusedContains", { who: whoText(folder.usedBy, t) });
	}
}

function gitText(git: GitRisk, t: TFunction): string {
	if (git.uncommitted === null || git.unpushed === null) return t("deleteDialog.cleanupGitUnknown");
	const parts: string[] = [];
	if (git.uncommitted) parts.push(t("deleteDialog.cleanupGitUncommitted", { n: git.uncommitted }));
	if (git.unpushed) parts.push(t("deleteDialog.cleanupGitUnpushed", { n: git.unpushed }));
	return parts.join(" · ");
}

/** Who uses a folder, the first two by name and the rest counted. */
function whoText(users: UsedBy[], t: TFunction): string {
	const name = (u: UsedBy): string => {
		if (u.kind === "terminal") return t("deleteDialog.cleanupWhoTerminal");
		if (u.kind === "process") return t("deleteDialog.cleanupWhoProcess", { name: u.name, pid: u.pid ?? "" });
		if (u.kind === "project") return t("deleteDialog.cleanupWhoProject", { name: u.name });
		return u.name ? t("deleteDialog.cleanupWhoConversation", { name: u.name }) : t("deleteDialog.cleanupWhoNewChat");
	};
	const shown = users.slice(0, 2).map(name).join(", ");
	return users.length > 2 ? t("deleteDialog.cleanupWhoMore", { list: shown, n: users.length - 2 }) : shown;
}
