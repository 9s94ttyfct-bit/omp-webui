import type { RulesPatch } from "@shared/guard.ts";
import {
	DEFAULT_POLICY,
	DEFAULT_POLICY_VERSION,
	DEFAULT_THRESHOLD,
	normalizePolicy,
	POLICY_MAX,
	policyProblem,
	policyStatus,
	SETTABLE_KINDS,
	type SettableKind,
	settableTo,
	THRESHOLDS,
	type Threshold,
	thresholdOf,
} from "@shared/guard-policy.ts";
import { Check, CircleAlert, Lock } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useT } from "../i18n/index.ts";
import { guardApi } from "../lib/guard-api.ts";
import { CAT_NAME, THRESHOLD_TEXT } from "../lib/guard-format.ts";
import { RISK_KIND_LABEL } from "../lib/risk-kinds.ts";
import { useGuard } from "../store/guard.ts";
import { AllowConfirm } from "./GuardAllowConfirm.tsx";
import { Button, cx, Spinner } from "./ui.tsx";

/** What the last change came to: saving it, saved, or what the server said against it. */
type Outcome = { state: "idle" } | { state: "saving" } | { state: "saved" } | { state: "error"; error: string };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Guard › Policy: how strict the guard is for each kind of call the classifier recognises (Allow, Ask, Block), and the
 * rules the reviewer follows, which the person can edit and always restore to the default that ships with the app. What cannot
 * be loosened (a kind with a floor, the guard's own files) says so where it is. A change is sent at once and kept on this
 * computer, in the guard's settings file, which moves with the rest of them.
 */
export default function GuardPolicy() {
	const t = useT();
	const rules = useGuard((s) => s.rules);
	const [outcome, setOutcome] = useState<Outcome>({ state: "idle" });
	/** What the person chose for a kind and the server has not answered yet. */
	const [pending, setPending] = useState<Record<string, Threshold>>({});
	/** The rules as they are being typed; null while the text is what is kept. */
	const [draft, setDraft] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [showNew, setShowNew] = useState(false);
	const rulesId = useId();
	const problemId = useId();

	useEffect(() => {
		guardApi.rules().catch((e) => setOutcome({ state: "error", error: messageOf(e) }));
	}, []);

	const kept = rules?.policy?.text ?? DEFAULT_POLICY;
	const status = policyStatus(rules?.policy);
	const shown = draft ?? kept;
	const problem = policyProblem(shown);
	const changed = draft !== null && normalizePolicy(draft) !== normalizePolicy(kept);
	const custom = rules?.policy !== undefined;

	/** The kind whose Allow is being asked about (see `AllowConfirm`). */
	const [confirm, setConfirm] = useState<SettableKind | null>(null);
	const apply = async (patch: RulesPatch): Promise<boolean> => {
		setOutcome({ state: "saving" });
		try {
			await guardApi.changeRules(patch);
			setOutcome({ state: "saved" });
			return true;
		} catch (e) {
			setOutcome({ state: "error", error: messageOf(e) });
			return false;
		}
	};

	const choose = async (kind: SettableKind, to: Threshold, confirmed = false) => {
		// An Allow is asked about first: the shipped harmful cases are tried with it, and the person sees how many would then run unasked.
		if (to === "allow" && !confirmed && thresholdOf(kind, rules?.thresholds) !== "allow") {
			setConfirm(kind);
			return;
		}
		setConfirm(null);
		setPending((p) => ({ ...p, [kind]: to }));
		await apply({ thresholds: { [kind]: to === DEFAULT_THRESHOLD ? null : to } });
		setPending((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== kind)));
	};

	const save = async () => {
		if (draft === null || problem !== null) return;
		if (await apply({ policy: { text: draft, basedOn: rules?.policy?.basedOn ?? DEFAULT_POLICY_VERSION } }))
			setDraft(null);
	};

	const restore = async () => {
		setConfirming(false);
		if (await apply({ policy: null })) {
			setDraft(null);
			setShowNew(false);
		}
	};

	const keepMine = async () => {
		if (rules?.policy && (await apply({ policy: { text: rules.policy.text, basedOn: DEFAULT_POLICY_VERSION } })))
			setShowNew(false);
	};

	const anyChanged = SETTABLE_KINDS.some((k) => thresholdOf(k, rules?.thresholds) !== DEFAULT_THRESHOLD);

	return (
		<div className="space-y-6 px-4 pb-6 pt-3 sm:px-6" data-testid="guard-policy">
			<section className="rounded-2xl border border-border bg-surface p-4" aria-labelledby={`${rulesId}-th`}>
				<h2 id={`${rulesId}-th`} className="text-title font-semibold">
					{t("guard.polThresholdsTitle")}
				</h2>
				<p className="mt-1 max-w-prose text-xs text-muted">{t("guard.polThresholdsHint")}</p>
				<div className="mt-3 space-y-2" data-testid="guard-thresholds">
					{SETTABLE_KINDS.map((kind) => {
						const now = pending[kind] ?? thresholdOf(kind, rules?.thresholds);
						const why = RISK_KIND_LABEL[kind];
						return (
							<fieldset
								key={kind}
								className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-border bg-bg-soft px-3 py-2"
								data-testid={`guard-threshold-${kind}`}
								data-value={now}
								disabled={rules === null}
							>
								<legend className="sr-only">{t(CAT_NAME[kind])}</legend>
								<div className="min-w-48 flex-1">
									<div className="text-sm font-medium">{t(CAT_NAME[kind])}</div>
									<div className="text-xs text-muted">{t("guard.catWhen", { why: t(why) })}</div>
									{/* A kind the guard always looks at has no Allow: said here, in words, where a greyed button on a touch screen is mute. */}
									{settableTo(kind, "allow") ? null : (
										<div
											id={`${rulesId}-floor-${kind}`}
											className="mt-1 flex items-start gap-1 text-xs text-muted"
											data-testid={`guard-threshold-${kind}-floor`}
										>
											<Lock size={12} className="mt-0.5 shrink-0" aria-hidden />
											{t("guard.thFloor")}
										</div>
									)}
								</div>
								<div className="flex gap-1">
									{THRESHOLDS.map((to) => {
										const allowed = settableTo(kind, to);
										const on = now === to;
										return (
											<label
												key={to}
												className={cx(
													"cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
													on
														? to === "block"
															? "border-danger bg-danger/10 text-danger"
															: to === "allow"
																? "border-warning bg-warning/10"
																: "border-accent bg-accent-soft"
														: "border-border hover:bg-hover",
													!allowed && "cursor-not-allowed opacity-40 hover:bg-transparent",
												)}
												title={allowed ? undefined : t("guard.thFloor")}
											>
												<input
													type="radio"
													className="sr-only"
													name={`guard-th-${kind}`}
													value={to}
													checked={on}
													disabled={!allowed}
													aria-describedby={allowed ? undefined : `${rulesId}-floor-${kind}`}
													data-testid={`guard-threshold-${kind}-${to}`}
													onChange={() => void choose(kind, to)}
												/>
												{t(THRESHOLD_TEXT[to])}
											</label>
										);
									})}
								</div>
								{confirm === kind ? (
									<AllowConfirm
										kind={kind}
										onNo={() => setConfirm(null)}
										onYes={() => {
											setConfirm(null);
											void choose(kind, "allow", true);
										}}
									/>
								) : null}
							</fieldset>
						);
					})}
				</div>
				<div className="mt-3 flex flex-wrap items-center gap-3">
					<Button
						size="sm"
						data-testid="guard-thresholds-reset"
						disabled={!anyChanged}
						onClick={() => void apply({ thresholds: Object.fromEntries(SETTABLE_KINDS.map((k) => [k, null])) })}
					>
						{t("guard.thReset")}
					</Button>
					<span className="flex items-start gap-1.5 text-xs text-muted">
						<Lock size={12} className="mt-0.5 shrink-0" aria-hidden />
						{t("guard.polFixedBody")}
					</span>
				</div>
			</section>

			<section className="rounded-2xl border border-border bg-surface p-4" aria-labelledby={`${rulesId}-rules`}>
				<h2 id={`${rulesId}-rules`} className="text-title font-semibold">
					{t("guard.polRulesTitle")}
				</h2>
				<p className="mt-1 max-w-prose text-xs text-muted">{t("guard.polRulesHint")}</p>
				<p className="mt-1 max-w-prose text-xs text-muted">{t("guard.polLanguage")}</p>

				<p className="mt-3 text-xs" data-testid="guard-policy-state" data-status={status}>
					{status === "default"
						? t("guard.polStatusDefault")
						: t("guard.polStatusCustom", { version: rules?.policy?.basedOn ?? DEFAULT_POLICY_VERSION })}
				</p>

				{status === "outdated" ? (
					<div
						className="mt-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm"
						role="status"
						data-testid="guard-policy-outdated"
					>
						<div className="font-medium">{t("guard.polDefaultChangedTitle")}</div>
						<p className="mt-1 text-xs">
							{t("guard.polDefaultChangedBody", {
								based: rules?.policy?.basedOn ?? 0,
								version: DEFAULT_POLICY_VERSION,
							})}
						</p>
						<div className="mt-2 flex flex-wrap gap-2">
							<Button
								size="sm"
								data-testid="guard-policy-show-new"
								aria-expanded={showNew}
								onClick={() => setShowNew((s) => !s)}
							>
								{showNew ? t("guard.polHideDefault") : t("guard.polShowDefault")}
							</Button>
							<Button size="sm" data-testid="guard-policy-keep" onClick={() => void keepMine()}>
								{t("guard.polKeepMine")}
							</Button>
						</div>
						{showNew ? (
							<section
								className="mt-2 max-h-64 overflow-auto rounded-lg bg-surface p-2"
								// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard to be read (axe: scrollable-region-focusable).
								tabIndex={0}
								aria-label={t("guard.polDefaultLabel")}
							>
								<pre className="whitespace-pre-wrap font-mono text-xs" data-testid="guard-policy-new-default">
									{DEFAULT_POLICY}
								</pre>
							</section>
						) : null}
					</div>
				) : null}

				<label htmlFor={rulesId} className="mt-3 block text-sm">
					{t("guard.polRulesLabel")}
				</label>
				<textarea
					id={rulesId}
					className="mt-1 min-h-72 w-full rounded-xl border border-border bg-bg-soft p-3 font-mono text-xs outline-none focus:border-faint"
					data-testid="guard-policy-text"
					spellCheck={false}
					value={shown}
					aria-invalid={problem !== null}
					aria-describedby={problem !== null ? problemId : undefined}
					onChange={(e) => setDraft(e.target.value)}
				/>
				<div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
					<span data-testid="guard-policy-chars">{t("guard.polChars", { count: shown.length, max: POLICY_MAX })}</span>
					{problem !== null ? (
						<span id={problemId} className="text-danger" role="alert" data-testid="guard-policy-problem">
							{problem === "empty"
								? t("guard.polProblemEmpty")
								: problem === "tooLong"
									? t("guard.polProblemTooLong", { max: POLICY_MAX })
									: t("guard.polProblemInvalid")}
						</span>
					) : null}
				</div>

				<div className="mt-3 flex flex-wrap items-center gap-2">
					<Button
						variant="primary"
						data-testid="guard-policy-save"
						disabled={!changed || problem !== null || outcome.state === "saving"}
						onClick={() => void save()}
					>
						{t("guard.polSave")}
					</Button>
					<Button
						data-testid="guard-policy-restore"
						onClick={() => {
							if (custom) setConfirming(true);
							else setDraft(null);
						}}
					>
						{t("guard.polRestore")}
					</Button>
				</div>
				{confirming ? (
					<div
						className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-bg-soft p-3 text-sm"
						role="alertdialog"
						aria-label={t("guard.polRestoreConfirm")}
						data-testid="guard-policy-confirm"
					>
						<span className="flex-1">{t("guard.polRestoreConfirm")}</span>
						<Button variant="danger" size="sm" data-testid="guard-policy-restore-yes" onClick={() => void restore()}>
							{t("guard.polRestoreYes")}
						</Button>
						<Button size="sm" data-testid="guard-policy-restore-no" onClick={() => setConfirming(false)}>
							{t("guard.polRestoreNo")}
						</Button>
					</div>
				) : null}

				<div
					className="mt-2 min-h-5 text-xs"
					role="status"
					data-testid="guard-policy-status"
					data-state={outcome.state}
				>
					{outcome.state === "saving" ? (
						<span className="inline-flex items-center gap-1.5 text-muted">
							<Spinner size={12} /> {t("guard.saving")}
						</span>
					) : outcome.state === "saved" ? (
						<span className="inline-flex items-center gap-1.5 text-success">
							<Check size={12} aria-hidden /> {t("guard.saved")}
						</span>
					) : outcome.state === "error" ? (
						<span className="inline-flex items-start gap-1.5 text-danger" data-testid="guard-policy-error">
							<CircleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
							<span className="break-words">{t("guard.saveFailed", { error: outcome.error })}</span>
						</span>
					) : null}
				</div>
				<p className="mt-2 max-w-prose text-xs text-muted">{t("guard.polLocal")}</p>
			</section>
		</div>
	);
}
