import { Target } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { cancelGuidedGoal, confirmProposal, reviseProposal } from "../lib/goal.ts";
import { parseTokenAmount } from "../lib/token-amount.ts";
import { requestGoal, useApp } from "../store/app.ts";
import type { LiveState, UIRequest } from "../store/live.ts";
import { BudgetField } from "./BudgetField.tsx";
import { Button, Spinner } from "./ui.tsx";

/** Above the composer while omp interviews the user: what is going on, and the two ways out. */
export function GuidedGoalBar({ live }: { live: LiveState }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const [busy, setBusy] = useState(false);
	/** Cancelling leaves no goal; `direct` also opens the form for typing the objective instead. */
	const end = async (direct: boolean) => {
		setBusy(true);
		try {
			await cancelGuidedGoal(live);
			if (direct) requestGoal("direct");
		} catch (e) {
			toast("error", t("chat.runError", { label: t("chat.errGoal"), error: (e as Error).message }));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div
			// Wraps: on a phone the two buttons take a row of their own, not the text, which a column beside them wrapped to seven lines.
			className="mb-2 flex flex-wrap items-start gap-x-2 gap-y-1.5 rounded-xl border border-accent/40 bg-accent-soft px-3 py-2 text-sm"
			data-testid="guided-bar"
		>
			<Target size={15} className="mt-0.5 shrink-0 text-accent" />
			<p className="min-w-0 flex-1 basis-56">
				<span className="font-medium">{t("panel.guidedBarTitle")}</span>
				<span className="text-muted"> · {t("panel.guidedBarText")}</span>
			</p>
			<Button
				size="sm"
				variant="ghost"
				className="ml-auto"
				disabled={busy}
				data-testid="guided-direct"
				onClick={() => void end(true)}
			>
				{t("panel.guidedBarDirect")}
			</Button>
			<Button size="sm" variant="ghost" disabled={busy} data-testid="guided-cancel" onClick={() => void end(false)}>
				{t("panel.guidedBarCancel")}
			</Button>
		</div>
	);
}

const field = "w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint";

/**
 * The goal omp proposes at the end of the interview. Everything is editable; nothing starts before the user
 * confirms, and a refusal from omp (a goal already running, plan mode) stays here, with what was typed.
 */
export function ProposalBody({ req, liveId }: { req: UIRequest; liveId: string }) {
	const t = useT();
	const proposal = req.proposal;
	const [objective, setObjective] = useState(proposal?.objective ?? "");
	const [criteria, setCriteria] = useState(proposal?.criteria.join("\n") ?? "");
	const [budget, setBudget] = useState(proposal?.tokenBudget ? String(proposal.tokenBudget) : "");
	const [changing, setChanging] = useState(false);
	const [feedback, setFeedback] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const live = useApp((s) => s.lives[liveId]);
	const changesBox = useRef<HTMLDivElement>(null);
	const pinnedBar = useRef<HTMLDivElement>(null);
	// The pinned bar sits over the bottom of what scrolls. The form for changes opens (and a refusal makes the bar taller)
	// under it, where its field and its Send are out of sight: scroll what scrolls up by as much as the bar covers of it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `error` is what grows the bar; it is not read here.
	useLayoutEffect(() => {
		const box = changesBox.current;
		const bar = pinnedBar.current;
		if (!changing || !box || !bar) return;
		let scroller = box.parentElement;
		while (scroller && getComputedStyle(scroller).overflowY === "visible") scroller = scroller.parentElement;
		const covered = box.getBoundingClientRect().bottom - bar.getBoundingClientRect().top;
		if (scroller && covered > 0) scroller.scrollTop += covered + 4;
	}, [changing, error]);
	if (!proposal) return null;
	const tokenBudget = parseTokenAmount(budget);
	const confirm = async () => {
		if (tokenBudget === null) return;
		setBusy(true);
		setError(null);
		try {
			await confirmProposal(liveId, req.id, {
				objective: objective.trim(),
				criteria: criteria.split("\n").map((c) => c.trim()),
				tokenBudget,
			});
		} catch (e) {
			setError((e as Error).message);
			setBusy(false);
		}
	};
	return (
		<div className="space-y-3" data-testid="proposal">
			<p className="text-xs text-muted">{t("panel.proposalHint")}</p>
			<div>
				<label className="mb-1 block text-xs font-medium" htmlFor={`proposal-objective-${req.id}`}>
					{t("panel.proposalObjective")}
				</label>
				<textarea
					id={`proposal-objective-${req.id}`}
					data-testid="proposal-objective"
					className={`${field} min-h-16`}
					value={objective}
					onChange={(e) => {
						setObjective(e.target.value);
						setError(null);
					}}
				/>
			</div>
			<div>
				<label className="mb-1 block text-xs font-medium" htmlFor={`proposal-criteria-${req.id}`}>
					{t("panel.proposalCriteria")}
				</label>
				<textarea
					id={`proposal-criteria-${req.id}`}
					data-testid="proposal-criteria"
					className={`${field} min-h-24`}
					value={criteria}
					onChange={(e) => {
						setCriteria(e.target.value);
						setError(null);
					}}
				/>
			</div>
			<div>
				<label className="mb-1 block text-xs font-medium" htmlFor={`proposal-budget-${req.id}`}>
					{t("panel.proposalBudget")}
				</label>
				<BudgetField
					id={`proposal-budget-${req.id}`}
					testId="proposal-budget"
					className={`${field} w-44 py-1.5`}
					placeholder={t("panel.proposalBudgetPlaceholder")}
					value={budget}
					onChange={(v) => {
						setBudget(v);
						setError(null);
					}}
				/>
			</div>
			{changing ? (
				<div className="space-y-2" ref={changesBox}>
					<textarea
						aria-label={t("panel.proposalChangesPlaceholder")}
						data-testid="proposal-feedback"
						className={`${field} min-h-16`}
						placeholder={t("panel.proposalChangesPlaceholder")}
						value={feedback}
						onChange={(e) => setFeedback(e.target.value)}
						// biome-ignore lint/a11y/noAutofocus: the field just opened by the user's own click
						autoFocus
					/>
					<div className="flex justify-end gap-2">
						<Button variant="ghost" size="sm" onClick={() => setChanging(false)}>
							{t("common.cancel")}
						</Button>
						<Button
							variant="outline"
							size="sm"
							data-testid="proposal-send"
							disabled={!feedback.trim()}
							onClick={() => {
								setError(null);
								reviseProposal(liveId, req.id, feedback.trim());
							}}
						>
							{t("panel.proposalSendChanges")}
						</Button>
					</div>
				</div>
			) : null}
			{/* Pinned to the card's foot, with the refusal above its buttons: the card is taller than the window leaves it once
			    the refusal is in it and scrolls, and Start goal was half below its edge (and a refusal under the fold went unseen).
			    It spans the card's padding so what scrolls under it does not show beside it, nor below it: a sticky box measures
			    from inside the padding, so it is pinned a padding lower (`-bottom-(--pad)`), as the question card's buttons are. */}
			<div
				ref={pinnedBar}
				data-testid="proposal-bar"
				className="sticky -bottom-(--pad) z-10 -mx-(--pad) -mb-(--pad) space-y-2 border-t border-border bg-surface px-(--pad) pt-2 pb-(--pad)"
			>
				{error ? (
					<p className="text-xs text-danger" role="alert" data-testid="proposal-error">
						{t("panel.proposalFailed", { error })}
					</p>
				) : null}
				<div className="flex flex-wrap items-center justify-end gap-2">
					<Button
						variant="ghost"
						className="mr-auto"
						disabled={busy}
						data-testid="proposal-cancel"
						onClick={() => live && void cancelGuidedGoal(live).catch(() => {})}
					>
						{t("panel.proposalCancel")}
					</Button>
					{changing ? null : (
						<Button variant="outline" disabled={busy} data-testid="proposal-changes" onClick={() => setChanging(true)}>
							{t("panel.proposalChanges")}
						</Button>
					)}
					<Button
						variant="primary"
						disabled={busy || !objective.trim() || tokenBudget === null}
						data-testid="proposal-start"
						onClick={() => void confirm()}
					>
						{busy ? <Spinner size={14} /> : null}
						{t("panel.proposalStart")}
					</Button>
				</div>
			</div>
		</div>
	);
}
