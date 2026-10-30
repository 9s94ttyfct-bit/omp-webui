import type { Goal } from "@shared/goal.ts";
import { ChevronDown, Pause, Play, Target, X } from "lucide-react";
import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { fmtDuration, fmtTokens } from "../lib/format.ts";
import { type GoalOp, type GoalWait, goalOp } from "../lib/goal.ts";
import { parseTokenAmount } from "../lib/token-amount.ts";
import { useApp } from "../store/app.ts";
import { BudgetField } from "./BudgetField.tsx";
import { Button, cx, IconButton, Modal, Spinner } from "./ui.tsx";

/**
 * The conversation's goal above the composer (omp goal mode). Pausing a goal only pauses the goal: omp finishes
 * the step it is on and starts no more turns for it (`working` while that step runs). Freezing the whole
 * conversation is the composer's Pause, which a goal button does not end: on a paused conversation the goal's
 * state changes and the rest stays held. Without a running omp (`liveId` null: a goal set in the terminal, say)
 * the bar shows the saved goal, and an action first starts omp for the conversation (`ensureLive`). An active goal
 * that omp has stopped continuing (`waiting`) says it waits for the user instead of claiming work.
 *
 * The objective opens the goal in place (`expanded`, owned by the caller: the header's Goal control opens it too):
 * the objective in full, the status, the token budget and the time used. omp's `goal` rpc cannot change the objective
 * or the budget of a goal that is set, so the adjustments are Pause, Resume and Drop, and the panel says so.
 */
export function GoalBar({
	liveId,
	goal,
	working,
	waiting,
	expanded,
	onExpandedChange,
	ensureLive,
}: {
	liveId: string | null;
	goal: Goal;
	working: boolean;
	waiting: GoalWait | null;
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
	ensureLive: () => Promise<string>;
}) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const [confirmDrop, setConfirmDrop] = useState(false);
	const failedKey = {
		pause: "panel.goalPauseFailed",
		resume: "panel.goalResumeFailed",
		drop: "panel.goalDropFailed",
	} as const;
	const act = async (op: GoalOp) => {
		try {
			await goalOp(liveId ?? (await ensureLive()), op);
		} catch (e) {
			toast("error", t(failedKey[op], { error: (e as Error).message }));
		}
	};
	const pct = goal.tokenBudget ? Math.min(100, ((goal.tokensUsed ?? 0) / goal.tokenBudget) * 100) : null;
	const paused = goal.status === "paused";
	// The budget is spent: omp wraps up and stays in goal mode, but there is nothing to resume (it ignores `resume`) and a
	// new goal is refused until this one is dropped.
	const spent = goal.status === "budget-limited";
	const label = spent
		? working
			? t("panel.goalBudgetWrapping")
			: t("panel.goalBudgetReached")
		: paused
			? working
				? t("panel.goalPausing")
				: t("panel.goalPaused")
			: waiting === "blocked"
				? t("panel.goalBlocked")
				: waiting
					? t("panel.goalWaiting")
					: t("panel.goalWorking");
	// What the user can do about a goal that is not going on by itself.
	const hint =
		spent && !working
			? t("panel.goalBudgetHint")
			: !spent && !paused && waiting
				? t(waiting === "blocked" ? "panel.goalBlockedHint" : "panel.goalWaitingHint")
				: null;
	return (
		<div
			className="mb-2 rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-sm"
			data-testid="goal-bar"
			data-status={goal.status}
		>
			<div className="flex items-center gap-2">
				<Target size={15} className="shrink-0 text-accent" />
				<button
					type="button"
					className="flex min-h-7 min-w-0 flex-1 items-center gap-1 rounded text-left font-medium"
					title={goal.objective}
					aria-expanded={expanded}
					data-testid="goal-toggle"
					onClick={() => onExpandedChange(!expanded)}
				>
					<span className="min-w-0 flex-1 truncate">{goal.objective}</span>
					<ChevronDown size={14} className={cx("shrink-0 text-muted transition-transform", expanded && "rotate-180")} />
				</button>
				{/* The status gives way before the objective does: a long one ("Pausing · finishing the current step") left the
				    objective two letters on a phone. Its whole text is in the details. */}
				<span className="min-w-0 max-w-[45%] truncate text-xs text-muted" title={label} data-testid="goal-state">
					{label}
				</span>
				{spent ? null : paused ? (
					<IconButton label={t("panel.goalResume")} size="sm" onClick={() => void act("resume")}>
						<Play size={14} />
					</IconButton>
				) : (
					<IconButton label={t("panel.goalPause")} size="sm" onClick={() => void act("pause")}>
						<Pause size={14} />
					</IconButton>
				)}
				<IconButton label={t("panel.goalDrop")} size="sm" onClick={() => setConfirmDrop(true)}>
					<X size={14} />
				</IconButton>
			</div>
			<div className="mt-1 flex items-center gap-2 text-xs text-muted tabular-nums">
				{pct !== null ? (
					<div className="h-1 w-24 overflow-hidden rounded-full bg-hover" aria-hidden>
						<div
							className={cx("h-full rounded-full", pct > 85 ? "bg-danger" : "bg-accent")}
							style={{ width: `${pct}%` }}
						/>
					</div>
				) : null}
				<span data-testid="goal-tokens">
					{t("panel.goalTokens", {
						used: `${fmtTokens(goal.tokensUsed)}${goal.tokenBudget ? ` / ${fmtTokens(goal.tokenBudget)}` : ""}`,
					})}
				</span>
				{goal.timeUsedSeconds ? <span>· {fmtDuration(goal.timeUsedSeconds * 1000)}</span> : null}
				{hint ? (
					<span className="min-w-0 truncate" title={hint} data-testid="goal-hint">
						· {hint}
					</span>
				) : null}
			</div>
			{expanded ? (
				<div className="mt-2 space-y-2 border-t border-accent/30 pt-2 text-xs" data-testid="goal-details">
					<p
						className="max-h-40 overflow-y-auto rounded-lg bg-bg-soft px-3 py-2 text-sm whitespace-pre-wrap"
						data-testid="goal-objective-full"
					>
						{goal.objective}
					</p>
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 tabular-nums">
						<dt className="text-muted">{t("panel.goalDetailStatus")}</dt>
						<dd data-testid="goal-detail-status">{label}</dd>
						<dt className="text-muted">{t("panel.goalDetailBudget")}</dt>
						<dd data-testid="goal-detail-budget">
							{goal.tokenBudget
								? t("panel.goalTokens", {
										used: `${(goal.tokensUsed ?? 0).toLocaleString()} / ${goal.tokenBudget.toLocaleString()} (${Math.round(pct ?? 0)}%)`,
									})
								: t("panel.goalDetailNoBudget", { used: (goal.tokensUsed ?? 0).toLocaleString() })}
						</dd>
						<dt className="text-muted">{t("panel.goalDetailTime")}</dt>
						<dd data-testid="goal-detail-time">
							{goal.timeUsedSeconds ? fmtDuration(goal.timeUsedSeconds * 1000) : "—"}
						</dd>
					</dl>
					<p className="text-muted" data-testid="goal-detail-fixed">
						{t("panel.goalDetailFixed")}
					</p>
				</div>
			) : null}
			<Modal
				open={confirmDrop}
				onOpenChange={setConfirmDrop}
				title={t("panel.goalDropTitle")}
				description={t("panel.goalDropDescription")}
			>
				<p className="mb-4 line-clamp-4 rounded-lg bg-bg-soft px-3 py-2 text-sm whitespace-pre-wrap">
					{goal.objective}
				</p>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={() => setConfirmDrop(false)}>
						{t("common.cancel")}
					</Button>
					<Button
						variant="danger"
						data-testid="goal-drop-confirm"
						onClick={() => {
							setConfirmDrop(false);
							void act("drop");
						}}
					>
						{t("panel.goalDrop")}
					</Button>
				</div>
			</Modal>
		</div>
	);
}

/**
 * Set a goal. By default omp interviews the user in the chat first (`onGuided`), which is what the
 * rough objective here is for; the objective can also be typed directly (`onCreate`), skipping the interview.
 * Either resolves `true` once it has taken effect: only then are the fields cleared, so a failed attempt
 * keeps what was typed. Closing the dialog is the caller's job.
 */
export function GoalDialog({
	open,
	onOpenChange,
	initialMode = "guided",
	onGuided,
	onCreate,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	/** The form the dialog opens on. */
	initialMode?: "guided" | "direct";
	onGuided: (rough: string) => Promise<boolean> | boolean | undefined;
	onCreate: (objective: string, budget: number | undefined) => Promise<boolean> | boolean | undefined;
}) {
	const t = useT();
	const [mode, setMode] = useState(initialMode);
	const [rough, setRough] = useState("");
	const [objective, setObjective] = useState("");
	const [budget, setBudget] = useState("");
	const [busy, setBusy] = useState(false);
	// Each opening starts on the form asked for.
	useEffect(() => {
		if (open) setMode(initialMode);
	}, [open, initialMode]);
	const guided = mode === "guided";
	const submit = async () => {
		setBusy(true);
		try {
			if (guided) {
				if ((await onGuided(rough.trim())) === true) setRough("");
				return;
			}
			const amount = parseTokenAmount(budget);
			if (amount === null) return;
			if ((await onCreate(objective.trim(), amount)) === true) {
				setObjective("");
				setBudget("");
			}
		} finally {
			setBusy(false);
		}
	};
	const field = "w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint";
	const link = "mr-auto text-xs text-muted underline underline-offset-2 hover:text-fg";
	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			title={t("panel.goalDialogTitle")}
			description={guided ? t("panel.goalGuidedDescription") : t("panel.goalDialogDescription")}
		>
			<form
				data-testid={guided ? "goal-guided-form" : "goal-direct-form"}
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				{guided ? (
					<>
						<label className="mb-1 block text-xs font-medium" htmlFor="goal-rough">
							{t("panel.goalRoughLabel")}
						</label>
						<textarea
							id="goal-rough"
							data-testid="goal-rough"
							className={`${field} min-h-24`}
							placeholder={t("panel.goalRoughPlaceholder")}
							value={rough}
							onChange={(e) => setRough(e.target.value)}
						/>
					</>
				) : (
					<>
						<label className="mb-1 block text-xs font-medium" htmlFor="goal-objective">
							{t("panel.goalObjective")}
						</label>
						<textarea
							id="goal-objective"
							data-testid="goal-objective"
							className={`${field} min-h-28`}
							placeholder={t("panel.goalObjectivePlaceholder")}
							value={objective}
							onChange={(e) => setObjective(e.target.value)}
						/>
						<label className="mt-3 mb-1 block text-xs font-medium" htmlFor="goal-budget">
							{t("panel.goalBudget")}
						</label>
						<BudgetField
							id="goal-budget"
							testId="goal-budget"
							className={`${field} w-40 py-1.5`}
							placeholder={t("panel.goalBudgetPlaceholder")}
							value={budget}
							onChange={setBudget}
						/>
					</>
				)}
				{/* Wraps on a phone: the link takes its own row rather than squeezing the buttons until their labels spill out. */}
				<div className="mt-4 flex flex-wrap items-center justify-end gap-2">
					<button
						type="button"
						className={link}
						data-testid={guided ? "goal-direct-toggle" : "goal-guided-toggle"}
						onClick={() => setMode(guided ? "direct" : "guided")}
					>
						{guided ? t("panel.goalSkipInterview") : t("panel.goalBackToGuided")}
					</button>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						{t("common.cancel")}
					</Button>
					<Button
						variant="primary"
						type="submit"
						disabled={(!guided && (!objective.trim() || parseTokenAmount(budget) === null)) || busy}
						data-testid={guided ? "goal-guided-start" : "goal-create"}
					>
						{busy ? <Spinner size={14} /> : null}
						{guided ? t("panel.goalGuidedStart") : t("panel.goalStart")}
					</Button>
				</div>
			</form>
		</Modal>
	);
}
