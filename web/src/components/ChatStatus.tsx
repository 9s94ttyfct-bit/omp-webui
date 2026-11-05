import type { FamilyStats, SessionEntry } from "@shared/protocol.ts";
import { Clock, Cpu, FolderOpen, Target, TriangleAlert, Users, Zap } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { askChangeFolder } from "../lib/change-folder.ts";
import { contextLevel } from "../lib/context-usage.ts";
import { fmtCost, fmtCostExact, shortPath } from "../lib/format.ts";
import { useFitSteps } from "../lib/media.ts";
import { useStartConfig } from "../lib/model-config.ts";
import { useNow } from "../lib/now.ts";
import { fmtElapsed, fmtWindow } from "../lib/stat-format.ts";
import { type StatusFold, statusFolds, statusItems, statusSteps } from "../lib/status-line.ts";
import { levelText } from "../lib/thinking-levels.ts";
import { activeMs } from "../lib/turn-stats.ts";
import { usageLimitLabel } from "../lib/usage-limit.ts";
import { openAgent } from "../store/agents.ts";
import { refreshState, useApp } from "../store/app.ts";
import { useGit, useGitSync } from "../store/git.ts";
import type { LiveState } from "../store/live.ts";
import { useTurnClocks } from "../store/turn-clock.ts";
import { GitChips } from "./GitChips.tsx";
import { cx, PathTail, Tip } from "./ui.tsx";

/**
 * The TUI's bottom line, under the composer: how long the agent has worked, the model and its thinking level, the goal's
 * budget, the folder, the cost (this conversation's own and its subagents'), the context window and the agents running.
 * It is one row: where its column has too little room for all of it, its least needed items give way one at a time
 * (`STATUS_STEPS`), to the header (the folder) or to the header's menu (`StatusMenuRows`).
 */

const ITEM = "inline-flex items-center gap-1 whitespace-nowrap";
const ICON = "shrink-0 text-faint";
/** The context meter's colour by how full it is (`contextLevel`; a subagent's figure has the same thresholds). */
const LEVEL_BAR = { ok: "bg-accent", warn: "bg-warning", high: "bg-danger" } as const;

/** The least of the folder's path worth showing (about a dozen characters): shorter than that, it goes to the header. */
const CWD_MIN_PX = 80;

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
	file,
	cost,
	agentsRunning,
	savedThinking,
	onFolds,
}: StatusProps & {
	cwd: string | undefined;
	/** The conversation's session file (null before its first reply): what "Change folder…" moves. */
	file: string | null;
	/** Told what the line has put elsewhere for want of room, whenever that changes: the header shows it instead. */
	onFolds: (folds: StatusFold[]) => void;
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
	const pr = useGit((s) => (cwd ? s.byCwd[cwd]?.pr?.number : undefined));

	const spent = cost.main > 0 || cost.subagents > 0 || cost.advisor > 0;
	// The line is one row, and shows as much of itself as its room holds: what does not fit gives way one item at a time,
	// the least needed first (`STATUS_STEPS`). Until then nothing on it is cut short: an item gives way whole, and only
	// the item whose turn it is ends in an ellipsis on its way out (the folder, the branch's name, at last the model's).
	const steps = statusSteps({
		cwd: Boolean(cwd),
		time: Boolean(status.worked),
		goal: Boolean(goal),
		cost: spent,
		branch: Boolean(repo),
		model: Boolean(model || limitText),
	});
	const [line, setLine] = useState<HTMLDivElement | null>(null);
	// What the line holds, but for the figures that only grow as a turn runs (the time, the cost, the context): a change
	// of it starts the line again from its fullest form.
	const holds = JSON.stringify([
		steps,
		model?.name,
		model?.thinking,
		model?.resolved,
		fast,
		usageLimit?.stage,
		cwd,
		repo?.branch,
		pr,
		goal?.status,
		Boolean(ctx),
		agentsRunning > 0,
	]);
	// The header shows what the line has put elsewhere once the line has found its form, not each form on the way to it.
	const told = useRef<string | null>(null);
	const tell = (folds: StatusFold[]) => {
		const key = folds.join(" ");
		if (key === told.current) return;
		told.current = key;
		onFolds(folds);
	};
	const taken = useFitSteps(line, steps.length, holds, (k) => tell(statusFolds(steps, k)));
	const off = new Set(steps.slice(0, taken));
	// A line with nothing on it has put nothing elsewhere; nor has one that is gone.
	useLayoutEffect(() => {
		if (!line) tell([]);
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: on unmount only; `onFolds` is the parent's state setter.
	useLayoutEffect(() => () => onFolds([]), []);

	const shown = [status.worked, model, goal, cwd, spent, ctx, agentsRunning, limitText, repo];
	if (!shown.some(Boolean)) return null;
	// The model's name, and the usage limit beside it, keep their whole width until everything before them has given way.
	const modelShrinks = off.has("model-short") ? "min-w-0" : "shrink-0";
	return (
		<div
			ref={setLine}
			className="mt-1.5 flex min-h-6 flex-nowrap items-center gap-x-3.5 px-2 text-xs tabular-nums text-muted"
			data-testid="chat-status"
			data-folds={statusFolds(steps, taken).join(" ") || undefined}
			data-no-branch-name={off.has("branch-icon") ? "" : undefined}
		>
			{status.worked && !off.has("time") ? (
				<span
					className={cx(ITEM, "shrink-0")}
					title={t("chat.statusWorked", { value: status.worked })}
					data-testid="status-time"
				>
					<Clock size={11} className={ICON} aria-hidden />
					<span className="sr-only">{t("chat.statusWorkedLabel")} </span>
					{status.worked}
				</span>
			) : null}
			{model ? (
				<span className={cx(ITEM, modelShrinks)} data-testid="status-model">
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
					className={cx(ITEM, modelShrinks, "text-warning")}
					title={limitText}
					data-testid="status-usage-limit"
					data-stage={usageLimit.stage}
				>
					<TriangleAlert size={11} className="shrink-0" aria-hidden />
					<span className="sr-only">{t("chat.statusUsageLimitLabel")} </span>
					<span className="truncate">{limitText}</span>
				</span>
			) : null}
			{goal && !off.has("goal") ? (
				<span
					className={cx(ITEM, "shrink-0")}
					title={goal.objective}
					data-testid="status-goal"
					data-status={goal.status}
				>
					<Target size={11} className={ICON} aria-hidden />
					{status.goalText}
					{status.goalNote ? <span className="text-faint">{status.goalNote}</span> : null}
				</span>
			) : null}
			{cwd && !off.has("cwd") ? (
				// The folder is also the way to another one (omp's `/move`, see `ChangeFolderDialog`); not while a turn runs.
				<button
					type="button"
					className={cx(
						ITEM,
						off.has("cwd-short") ? "min-w-0" : "shrink-0",
						"max-w-[14rem] rounded-sm hover:text-fg disabled:hover:text-inherit",
					)}
					title={t("shell.changeFolderStatus", { folder: cwd })}
					disabled={streaming}
					onClick={() => askChangeFolder({ file, liveId, cwd })}
					data-testid="status-cwd"
				>
					<FolderOpen size={11} className={ICON} aria-hidden />
					<PathTail path={shortPath(cwd, home)} data-fit-min={off.has("cwd-short") ? CWD_MIN_PX : undefined} />
				</button>
			) : null}
			<GitChips cwd={cwd} name={off.has("branch-icon") ? "icon" : off.has("branch-short") ? "short" : "whole"} />
			{spent && !off.has("cost") ? (
				<span
					className={cx(ITEM, "shrink-0")}
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
					className={cx(ITEM, "shrink-0")}
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
						className={`${ITEM} -mx-1.5 -my-1 shrink-0 rounded-md px-1.5 py-1 hover:bg-hover hover:text-fg`}
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
 * What the line has put in the header's menu for want of room (`folds`): how long the agent has worked and the goal's
 * budget. The folder and the cost it puts elsewhere are the header's own: its path, and its cost chip (on the header, or
 * in this menu with its subagents' share).
 */
export function StatusMenuRows({
	live,
	entries,
	stats,
	folds,
}: Pick<StatusProps, "live" | "entries" | "stats"> & { folds: readonly StatusFold[] }) {
	const t = useT();
	const status = useStatus(live, entries, undefined, stats);
	const worked = folds.includes("time") ? status.worked : null;
	const goal = folds.includes("goal") ? status.goal : undefined;
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
						{status.goalText}
						{status.goalNote ? <span className="ml-1 text-faint">{status.goalNote}</span> : null}
					</dd>
				</>
			) : null}
		</dl>
	);
}
