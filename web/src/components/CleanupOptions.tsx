import type { CleanupDep, CleanupFolder, DeletePreview, GitRisk, TrashPick, UsedBy } from "@shared/delete-cleanup.ts";
import { en } from "../i18n/delete-dialog.ts";
import { registerStrings, type Translate as TFunction } from "../i18n/index.ts";
import { formatBytes } from "../lib/app-update.ts";
import { shortPath } from "../lib/format.ts";

// This chunk carries its own English strings: the first page does not (see `registerStrings`).
registerStrings("deleteDialog", en);

/**
 * What a folder offers to the Trash, as the delete dialogs and the Disk space page's dialog show it
 * (docs/superpowers/specs/2026-11-11-delete-session-folder-design.md): the folder itself, or some of the dependency folders
 * in it, each with why it is not offered when it is not.
 */

/** How many things a preview offers to move. */
export function offered(p: DeletePreview): number {
	return (p.folder && p.folder.refused === null ? 1 : 0) + p.deps.filter((d) => d.refused === null).length;
}

export function Options({
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

export function refusalText(folder: CleanupFolder, t: TFunction): string | null {
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
		case "holdsConversations":
			return t("deleteDialog.cleanupRefusedHoldsConversations");
	}
}

export function gitText(git: GitRisk, t: TFunction): string {
	if (git.uncommitted === null || git.unpushed === null || git.stashes === null)
		return t("deleteDialog.cleanupGitUnknown");
	const parts: string[] = [];
	if (git.uncommitted) parts.push(t("deleteDialog.cleanupGitUncommitted", { n: git.uncommitted }));
	if (git.unpushed) parts.push(t("deleteDialog.cleanupGitUnpushed", { n: git.unpushed }));
	if (git.stashes) parts.push(t("deleteDialog.cleanupGitStashes", { n: git.stashes }));
	return parts.join(" · ");
}

/** Who uses a folder, the first two by name and the rest counted. */
export function whoText(users: UsedBy[], t: TFunction): string {
	const name = (u: UsedBy): string => {
		if (u.kind === "terminal") return t("deleteDialog.cleanupWhoTerminal");
		if (u.kind === "process") return t("deleteDialog.cleanupWhoProcess", { name: u.name, pid: u.pid ?? "" });
		if (u.kind === "project") return t("deleteDialog.cleanupWhoProject", { name: u.name });
		return u.name ? t("deleteDialog.cleanupWhoConversation", { name: u.name }) : t("deleteDialog.cleanupWhoNewChat");
	};
	const shown = users.slice(0, 2).map(name).join(", ");
	return users.length > 2 ? t("deleteDialog.cleanupWhoMore", { list: shown, n: users.length - 2 }) : shown;
}
