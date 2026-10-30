import { GitBranch, GitPullRequest } from "lucide-react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { useGit } from "../store/git.ts";
import { cx } from "./ui.tsx";

const ITEM = "inline-flex items-center gap-1 whitespace-nowrap";

/**
 * The TUI's git segments of the status line: the branch with how many files are staged (`+`), changed (`~`) and
 * untracked (`?`), and the pull request of the branch when `gh` knows one. Nothing for a folder outside a repository.
 */
export function GitChips({ cwd }: { cwd: string | undefined }) {
	const t = useT();
	const folder = useGit((s) => (cwd ? s.byCwd[cwd] : undefined));
	const git = folder?.git;
	if (!git) return null;
	const counts = [
		{
			id: "staged",
			n: git.staged,
			mark: "+",
			tone: "text-success",
			label: t("chat.statusGitStaged", { n: git.staged }),
		},
		{
			id: "unstaged",
			n: git.unstaged,
			mark: "~",
			tone: "text-warning",
			label: t("chat.statusGitUnstaged", { n: git.unstaged }),
		},
		{
			id: "untracked",
			n: git.untracked,
			mark: "?",
			tone: "text-accent",
			label: t("chat.statusGitUntracked", { n: git.untracked }),
		},
	].filter((c) => c.n > 0);
	const clean = counts.length === 0;
	const title = [
		t(git.detached ? "chat.statusGitDetached" : "chat.statusGitBranch", { branch: git.branch }),
		clean ? t("chat.statusGitClean") : counts.map((c) => c.label).join(", "),
	].join(" · ");
	const pr = folder?.pr;
	return (
		<>
			<span
				// On the narrow one-row status line the branch's name gives way first, before the model's (which keeps its width
				// while this one is shown); when not even a few readable characters of it fit, the line sets `data-no-branch-name`
				// (see `ChatStatus`) and the chip is its icon and counts, the name in its title and kept for readers of the screen.
				className={cx(ITEM, "min-w-0 max-w-[16rem] [[data-no-branch-name]_&]:shrink-0")}
				title={title}
				data-testid="status-git"
				data-branch={git.branch}
				data-clean={clean}
			>
				<GitBranch size={11} className={cx("shrink-0", clean ? "text-success" : "text-warning")} aria-hidden />
				{git.detached ? <span className="sr-only">{t("chat.statusGitDetached", { branch: git.branch })}</span> : null}
				<span
					className="truncate [[data-no-branch-name]_&]:sr-only"
					aria-hidden={git.detached || undefined}
					data-testid="status-git-name"
				>
					{git.branch}
				</span>
				{counts.map((c) => (
					<span key={c.id} className={cx("shrink-0", c.tone)} data-testid={`status-git-${c.id}`} data-count={c.n}>
						<span aria-hidden>
							{c.mark}
							{c.n}
						</span>
						<span className="sr-only">{c.label}</span>
					</span>
				))}
			</span>
			{pr ? (
				<a
					className={cx(ITEM, "rounded-sm hover:text-fg hover:underline")}
					href={pr.url}
					target="_blank"
					rel="noreferrer noopener"
					title={t("chat.statusPullRequest", { n: pr.number })}
					data-testid="status-pr"
					data-number={pr.number}
				>
					<GitPullRequest size={11} className="shrink-0 text-faint" aria-hidden />#{pr.number}
				</a>
			) : null}
		</>
	);
}
