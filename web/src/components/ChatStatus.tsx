import type { FamilyStats, SessionEntry } from "@shared/protocol.ts";
import { Clock, Cpu, FolderOpen, Target, TriangleAlert, Users, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { contextLevel } from "../lib/context-usage.ts";
import { fmtCost, fmtCostExact, shortPath } from "../lib/format.ts";
import { useCrampedRow } from "../lib/media.ts";
import { useStartConfig } from "../lib/model-config.ts";
import { useNow } from "../lib/now.ts";
import { fmtElapsed, fmtWindow } from "../lib/stat-format.ts";
import { statusItems } from "../lib/status-line.ts";
import { activeMs } from "../lib/turn-stats.ts";
import { usageLimitLabel } from "../lib/usage-limit.ts";
import { openAgent } from "../store/agents.ts";
import { refreshState, useApp } from "../store/app.ts";
import { useGit, useGitSync } from "../store/git.ts";
import type { LiveState } from "../store/live.ts";
import { useTurnClocks } from "../store/turn-clock.ts";
import { GitChips } from "./GitChips.tsx";
import { levelText } from "./ModelPicker.tsx";
import { cx, Tip } from "./ui.tsx";

/**
 * The TUI's bottom line, under the composer: how long the agent has worked, the model and its thinking level, the goal's
 * budget, the folder, the cost (this conversation's own and its subagents'), the context window and the agents running.
 * A narrow column keeps the model, the context and the agents here; the rest goes to the header's menu (`StatusMenuRows`).
 */

const ITEM = "inline-flex items-center gap-1 whitespace-nowrap";
const ICON = "shrink-0 text-faint";
/** The context meter's colour by how full it is (`contextLevel`; a subagent's figure has the same thresholds). */
const LEVEL_BAR = { ok: "bg-accent", warn: "bg-warning", high: "bg-danger" } as const;

/** Fewer characters of the branch than this (about five) are not worth showing: the chip is its icon instead. */
const BRANCH_MIN_PX = 32;

/**
 * Whether the narrow line, laid out with the branch's name on it, leaves that name truncated to less than
 * `BRANCH_MIN_PX`; or has no branch's name to give way first. Asked by `useCrampedRow` of the line with
 * `data-no-branch-name` off: the model's name keeps its whole width then (`min-w-max`), and the branch's is what shrinks.
 */
function branchCramps(line: HTMLElement): boolean {
	const branch = line.querySelector<HTMLElement>('[data-testid="status-git-name"]');
	if (!branch) return true;
	// To the fraction of a pixel: `scrollWidth` and `clientWidth` are whole pixels and can be equal while the name is short
	// of its width by a fraction, which is enough for an ellipsis ("ma…" for "main" on a line full to the pixel).
	const box = branch.getBoundingClientRect().width;
	const words = document.createRange();
	words.selectNodeContents(branch);
	return words.getBoundingClientRect().width > box + 0.01 && box < BRANCH_MIN_PX;
}

export interface StatusProps {
	live: LiveState | undefined;
	/** The conversation's saved entries. */
	entries: SessionEntry[];
	/** What the server adds up the whole file to, when the page holds only a part of it (see `activeMs`). */
	stats?: FamilyStats | null;
	/** US dollars: what the conversation's own requests cost, and what its subagents' and its advisors' did. */
	cost: { main: number; subagents: number; advisor: number };
	/** Subagents running now. */
	agentsRunning: number;
	/** The thinking level the conversation's journal leaves (`savedSettings`): `auto` for a resumed conversation that was on it. */
	savedThinking?: string;
}

/** The status line's figures as it writes them, counting up while a turn runs. */
function useStatus(
	live: LiveState | undefined,
	entries: SessionEntry[],
	savedThinking?: string,
	stats?: FamilyStats | null,
) {
	const t = useT();
	const saved = useMemo(() => activeMs(entries, stats), [entries, stats]);
	const clock = useTurnClocks((s) => (live ? s[live.info.liveId] : undefined)) ?? null;
	const now = useNow(live?.streaming && clock ? 1000 : null);
	const config = useStartConfig(live);
	const items = statusItems(live, saved, clock, now, savedThinking, config);
	const goal = items.goal;
	return {
		...items,
		/** How long the agent has worked; nothing for under a second, as in the TUI. */
		worked: items.activeMs >= 1000 ? fmtElapsed(items.activeMs) : null,
		goalText: goal
			? goal.budget
				? t("chat.statusGoal", { used: fmtWindow(goal.used), budget: fmtWindow(goal.budget) })
				: t("chat.statusGoalUsed", { used: fmtWindow(goal.used) })
			: null,
		/** What the goal's status adds to its figures: omp holds it, or has spent its budget. */
		goalNote:
			goal?.status === "paused"
				? t("chat.statusGoalPaused")
				: goal?.status === "budget-limited"
					? t("chat.statusGoalBudgetReached")
					: null,
	};
}

export function ChatStatus({
	live,
	entries,
	stats,
	cwd,
	cost,
	agentsRunning,
	savedThinking,
	compact,
}: StatusProps & {
	cwd: string | undefined;
	/** Only the primary items: the rest are in the header's menu. */
	compact: boolean;
}) {
	const t = useT();
	const home = useApp((s) => s.meta?.home);
	const status = useStatus(live, entries, savedThinking, stats);
	const { model, context: ctx, goal, fast, usageLimit } = status;
	const limitText = usageLimit ? usageLimitLabel(usageLimit, t) : null;

	// omp reports the context window with its state, which the page asks for when a turn ends. A turn can run for hours
	// (a goal), so ask again as each request ends: its saved entry is what says so.
	const liveId = live && !live.info.exited ? live.info.liveId : null;
	const streaming = Boolean(live?.streaming);
	const lastEntry = entries.at(-1)?.id;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new last entry is the trigger; it is not an input of the call.
	useEffect(() => {
		if (liveId && streaming) void refreshState(liveId);
	}, [liveId, streaming, lastEntry]);

	// The branch, the changed files and the pull request of the folder.
	useGitSync(cwd, streaming, lastEntry);
	const repo = useGit((s) => (cwd ? s.byCwd[cwd]?.git : undefined));
	// On the narrow one-row line the model's name has the room first: while the branch's name is on the line, the model's
	// keeps its whole width and the branch's is what gives way. Where that leaves less than a few readable characters of
	// the branch (or there is no branch), the branch is its icon and counts alone (`data-no-branch-name`, answered in
	// `GitChips`; its name is then the chip's title and is read out), and the model's name may give way in its turn.
	const [line, setLine] = useState<HTMLDivElement | null>(null);
	const noBranchName = useCrampedRow(compact ? line : null, "data-no-branch-name", branchCramps) && compact;

	const spent = cost.main > 0 || cost.subagents > 0 || cost.advisor > 0;
	const shown = compact
		? [model, ctx, agentsRunning, limitText, repo]
		: [status.worked, model, goal, cwd, spent, ctx, agentsRunning, limitText, repo];
	if (!shown.some(Boolean)) return null;
	return (
		<div
			ref={setLine}
			className={cx(
				"mt-1.5 flex min-h-6 items-center gap-x-3.5 gap-y-0.5 px-2 text-xs tabular-nums text-muted",
				// The narrow line keeps to one row (it has only the model, the context, the agents and the branch): the branch and
				// then the model give way with an ellipsis instead of the context figure going to a row of its own.
				compact ? "flex-nowrap" : "flex-wrap",
			)}
			data-testid="chat-status"
			data-no-branch-name={noBranchName ? "" : undefined}
		>
			{!compact && status.worked ? (
				<span className={ITEM} title={t("chat.statusWorked", { value: status.worked })} data-testid="status-time">
					<Clock size={11} className={ICON} aria-hidden />
					<span className="sr-only">{t("chat.statusWorkedLabel")} </span>
					{status.worked}
				</span>
			) : null}
			{model ? (
				<span
					className={cx(ITEM, compact ? "min-w-max [[data-no-branch-name]_&]:min-w-0" : "min-w-0")}
					data-testid="status-model"
				>
					<Cpu size={11} className={ICON} aria-hidden />
					<span className="truncate" data-testid="status-model-name">
						{model.name}
					</span>
					{model.thinking ? (
						<span className="shrink-0 text-faint" data-testid="status-thinking">
							{levelText(t, model.thinking, model.resolved)}
						</span>
					) : null}
					{fast ? (
						<span
							className="inline-flex shrink-0 items-center text-warning"
							title={t("chat.statusFast")}
							data-testid="status-fast"
						>
							<Zap size={11} className="shrink-0 fill-current" aria-hidden />
							<span className="sr-only">{t("chat.statusFast")}</span>
						</span>
					) : null}
				</span>
			) : null}
			{limitText && usageLimit ? (
				<span
					className={cx(ITEM, "min-w-0 text-warning")}
					title={limitText}
					data-testid="status-usage-limit"
					data-stage={usageLimit.stage}
				>
					<TriangleAlert size={11} className="shrink-0" aria-hidden />
					<span className="sr-only">{t("chat.statusUsageLimitLabel")} </span>
					<span className="truncate">{limitText}</span>
				</span>
			) : null}
			{compact ? <GitChips cwd={cwd} /> : null}
			{!compact && goal ? (
				<span className={ITEM} title={goal.objective} data-testid="status-goal" data-status={goal.status}>
					<Target size={11} className={ICON} aria-hidden />
					{status.goalText}
					{status.goalNote ? <span className="text-faint">{status.goalNote}</span> : null}
				</span>
			) : null}
			{!compact && cwd ? (
				<span className={cx(ITEM, "min-w-0 max-w-[14rem]")} title={cwd} data-testid="status-cwd">
					<FolderOpen size={11} className={ICON} aria-hidden />
					<span className="truncate">{shortPath(cwd, home)}</span>
				</span>
			) : null}
			{!compact ? <GitChips cwd={cwd} /> : null}
			{!compact && spent ? (
				<span
					className={ITEM}
					title={
						cost.advisor > 0
							? t("chat.statusCostTitleAdvisor", {
									main: fmtCostExact(cost.main),
									subagents: fmtCostExact(cost.subagents),
									advisor: fmtCostExact(cost.advisor),
								})
							: t("chat.statusCostTitle", {
									main: fmtCostExact(cost.main),
									subagents: fmtCostExact(cost.subagents),
								})
					}
					data-testid="status-cost"
					data-main={cost.main}
					data-subagents={cost.subagents}
					data-advisor={cost.advisor}
				>
					{fmtCost(cost.main)}
					{cost.subagents + cost.advisor > 0 ? (
						<span className="text-faint">(+{fmtCost(cost.subagents + cost.advisor)})</span>
					) : null}
				</span>
			) : null}
			{ctx ? (
				<span
					className={ITEM}
					title={t("chat.contextTip", {
						tokens: ctx.tokens.toLocaleString(),
						window: ctx.contextWindow.toLocaleString(),
					})}
					data-testid="status-context"
					data-percent={Math.round(ctx.percent)}
				>
					<span className="h-1.5 w-12 overflow-hidden rounded-full bg-hover" aria-hidden>
						<span
							className={cx("block h-full rounded-full", LEVEL_BAR[contextLevel(ctx.percent)])}
							style={{ width: `${Math.min(100, ctx.percent)}%` }}
						/>
					</span>
					<span className="sr-only">{t("chat.statusContextLabel")} </span>
					{Math.round(ctx.percent)}%<span className="text-faint">/ {fmtWindow(ctx.contextWindow)}</span>
				</span>
			) : null}
			{agentsRunning > 0 ? (
				<Tip label={t("chat.statusAgents", { n: agentsRunning })}>
					<button
						type="button"
						aria-label={t("chat.statusAgents", { n: agentsRunning })}
						data-testid="status-agents"
						data-running={agentsRunning}
						// A button the size of a fingertip without growing the line: the margins take back what the padding adds.
						className={`${ITEM} -mx-1.5 -my-1 rounded-md px-1.5 py-1 hover:bg-hover hover:text-fg`}
						onClick={() => openAgent(null)}
					>
						<Users size={11} className={ICON} aria-hidden />
						{agentsRunning}
					</button>
				</Tip>
			) : null}
		</div>
	);
}

/**
 * What a narrow column folds out of the line into the header's menu: how long the agent has worked and the goal's
 * budget. The folder and the cost are the header's own, and the menu lists the cost with its subagents' share.
 */
export function StatusMenuRows({ live, entries, stats }: Pick<StatusProps, "live" | "entries" | "stats">) {
	const t = useT();
	const { worked, goal, goalText, goalNote } = useStatus(live, entries, undefined, stats);
	if (!worked && !goal) return null;
	return (
		<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
			{worked ? (
				<>
					<dt className="text-faint">{t("chat.statusWorkedLabel")}</dt>
					<dd
						className="text-right tabular-nums text-muted"
						title={t("chat.statusWorked", { value: worked })}
						data-testid="status-time"
					>
						{worked}
					</dd>
				</>
			) : null}
			{goal ? (
				<>
					<dt className="text-faint">{t("chat.statusGoalLabel")}</dt>
					<dd
						className="text-right tabular-nums text-muted"
						title={goal.objective}
						data-testid="status-goal"
						data-status={goal.status}
					>
						{goalText}
						{goalNote ? <span className="ml-1 text-faint">{goalNote}</span> : null}
					</dd>
				</>
			) : null}
		</dl>
	);
}
