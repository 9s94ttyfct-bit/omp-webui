import type { Worktree, WorktreeList } from "@shared/git.ts";
import { FolderGit2, Lock, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { autoRefresh } from "../lib/auto-refresh.ts";
import { loadWorktrees } from "../lib/worktrees-api.ts";
import { useApp } from "../store/app.ts";
import { Badge, cx, Empty, IconButton, Spinner } from "./ui.tsx";

/**
 * The Worktrees tab (#698): the worktrees of the repository the conversation works in, each with its branch (or the commit
 * of a detached HEAD), what is not committed there and how many of its commits the main branch lacks. Read again while it
 * is shown (as the Issues tab is), and at once with Refresh. The server only looks (see `server/git-worktrees.ts`).
 */
export function WorktreesTab({ cwd }: { cwd: string | null }) {
	const t = useT();
	const home = useApp((s) => s.meta?.home);
	const [list, setList] = useState<WorktreeList | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const asked = useRef(0);
	const load = useCallback(
		async (fresh: boolean) => {
			if (!cwd) return;
			const mine = ++asked.current;
			setBusy(true);
			try {
				const next = await loadWorktrees(cwd, fresh);
				if (mine !== asked.current) return;
				setList(next);
				setError(null);
			} catch (e) {
				if (mine === asked.current) setError(e instanceof Error ? e.message : String(e));
			} finally {
				if (mine === asked.current) setBusy(false);
			}
		},
		[cwd],
	);
	useEffect(() => {
		setList(null);
		setError(null);
		void load(false);
		return autoRefresh(() => void load(true));
	}, [load]);
	if (!cwd)
		return (
			<Empty icon={<FolderGit2 size={22} />} title={t("panel.tabWorktrees")}>
				{t("panel.worktreesNoConversation")}
			</Empty>
		);
	const shortPath = (p: string) => (home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
	return (
		<div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="worktrees-tab">
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-xs text-muted">
					{list?.state === "ok"
						? t(list.worktrees.length === 1 ? "panel.worktreesCountOne" : "panel.worktreesCount", {
								n: list.worktrees.length,
							})
						: null}
				</span>
				<IconButton
					label={t("panel.worktreesRefresh")}
					data-testid="worktrees-refresh"
					disabled={busy}
					onClick={() => void load(true)}
				>
					{busy ? <Spinner size={13} /> : <RefreshCw size={13} />}
				</IconButton>
			</div>
			{error ? (
				<p className="text-sm text-danger" role="alert" data-testid="worktrees-error">
					{t("panel.worktreesFailed", { error })}
				</p>
			) : null}
			{!list && !error ? (
				<div className="flex justify-center py-6">
					<Spinner />
				</div>
			) : null}
			{list && list.state !== "ok" ? (
				<Empty icon={<FolderGit2 size={22} />} title={t("panel.tabWorktrees")}>
					<span data-testid="worktrees-state" data-state={list.state}>
						{t(
							list.state === "unsafe"
								? "panel.worktreesUnsafe"
								: list.state === "slow"
									? "panel.worktreesSlow"
									: "panel.worktreesNone",
						)}
					</span>
				</Empty>
			) : null}
			{list?.state === "ok" ? (
				<ul className="space-y-1.5">
					{list.worktrees.map((w) => (
						<li key={w.path}>
							<WorktreeRow w={w} mainBranch={list.mainBranch} path={shortPath(w.path)} />
						</li>
					))}
				</ul>
			) : null}
			{list?.truncated ? <p className="text-xs text-faint">{t("panel.worktreesTruncated")}</p> : null}
		</div>
	);
}

function WorktreeRow({ w, mainBranch, path }: { w: Worktree; mainBranch: string | null; path: string }) {
	const t = useT();
	const dirty = w.changes ? w.changes.staged + w.changes.unstaged + w.changes.untracked > 0 : false;
	return (
		<div
			className={cx("rounded-xl border bg-surface px-3 py-2 text-sm", w.current ? "border-accent/50" : "border-border")}
			data-testid="worktree-row"
			data-path={w.path}
			data-dirty={dirty}
		>
			<div className="flex min-w-0 items-center gap-1.5">
				<span className="min-w-0 truncate font-medium" data-testid="worktree-branch">
					{w.branch ?? (w.head ? t("panel.worktreesDetached", { head: w.head }) : t("panel.worktreesBare"))}
				</span>
				{w.branch && w.head ? <span className="shrink-0 font-mono text-xs text-faint">{w.head}</span> : null}
				<span className="flex-1" />
				{w.current ? <Badge tone="accent">{t("panel.worktreesCurrent")}</Badge> : null}
				{w.main ? <Badge>{t("panel.worktreesMain")}</Badge> : null}
				{w.locked ? (
					<span title={t("panel.worktreesLocked")} className="shrink-0 text-muted">
						<Lock size={12} aria-label={t("panel.worktreesLocked")} />
					</span>
				) : null}
			</div>
			<div className="truncate font-mono text-xs text-faint" title={w.path}>
				{path}
			</div>
			<div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
				{w.prunable ? (
					<span className="text-warning">{t("panel.worktreesPrunable")}</span>
				) : w.changes === null ? (
					<span className="text-faint">{t("panel.worktreesNotLooked")}</span>
				) : dirty ? (
					<span className="text-warning" data-testid="worktree-changes">
						{t("panel.worktreesChanges", {
							staged: w.changes.staged,
							unstaged: w.changes.unstaged,
							untracked: w.changes.untracked,
						})}
					</span>
				) : (
					<span className="text-success" data-testid="worktree-changes">
						{t("panel.worktreesClean")}
					</span>
				)}
				{w.ahead !== null && mainBranch ? (
					<span className={w.ahead > 0 ? "text-accent" : "text-faint"} data-testid="worktree-ahead">
						{w.ahead > 0
							? t(w.ahead === 1 ? "panel.worktreesAheadOne" : "panel.worktreesAhead", {
									n: w.ahead,
									branch: mainBranch,
								})
							: t("panel.worktreesOnMain", { branch: mainBranch })}
					</span>
				) : null}
			</div>
		</div>
	);
}
