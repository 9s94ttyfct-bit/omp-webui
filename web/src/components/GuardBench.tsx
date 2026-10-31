import type { BenchBy, BenchCase, BenchGroup, BenchInfo, BenchResult, BenchSuggestion } from "@shared/guard-bench.ts";
import { CASE_LABEL_MAX, CASE_TEXT_MAX, CASES_MAX, type Expect, type UserCase } from "@shared/guard-policy.ts";
import { Check, CircleAlert, Minus, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import { guardApi } from "../lib/guard-api.ts";
import { BENCH_GROUP_TEXT, BENCH_OUTCOME_TEXT, CAT_NAME, THRESHOLD_TEXT } from "../lib/guard-format.ts";
import { useGuard } from "../store/guard.ts";
import { AllowConfirm } from "./GuardAllowConfirm.tsx";
import { Select } from "./Select.tsx";
import { Button, cx, Spinner } from "./ui.tsx";

const GROUPS: readonly BenchGroup[] = ["deletion", "overwrite", "system", "harmless", "own"];
const POLL_MS = 600;

const BY_TEXT: Record<BenchBy, MessageKey> = {
	classifier: "guard.byClassifier",
	reviewer: "guard.byReviewer",
	person: "guard.byPerson",
	none: "guard.byNone",
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A fresh id for a case of the person's: it starts `u-`, which no shipped case's does. */
const newCaseId = (): string => `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** One thing the person can change to get a different result: in words, and a button where one click does it. */
function Suggestion({ s, applied, onApply }: { s: BenchSuggestion; applied: boolean; onApply: () => void }) {
	const t = useT();
	const [asking, setAsking] = useState(false);
	switch (s.kind) {
		case "mode":
			return <li>{t("guard.sugMode")}</li>;
		case "unseen":
			return <li>{t("guard.sugUnseen")}</li>;
		case "tryReviewer":
			return <li>{t("guard.sugTryReviewer")}</li>;
		case "policy":
			return <li>{t(s.direction === "tighten" ? "guard.sugPolicyTighten" : "guard.sugPolicyLoosen")}</li>;
		case "threshold": {
			const category = t(CAT_NAME[s.risk]);
			return (
				<li className="flex flex-wrap items-center gap-2">
					<span>{t("guard.sugThreshold", { category, to: t(THRESHOLD_TEXT[s.to]) })}</span>
					<Button
						size="sm"
						data-testid="bench-apply"
						disabled={applied}
						// An Allow is asked about first, with how many shipped harmful cases it would let through.
						onClick={() => (s.to === "allow" ? setAsking(true) : onApply())}
					>
						{applied ? t("guard.sugApplied") : t("guard.sugApply")}
					</Button>
					{asking && !applied ? (
						<AllowConfirm
							kind={s.risk}
							onNo={() => setAsking(false)}
							onYes={() => {
								setAsking(false);
								onApply();
							}}
						/>
					) : null}
				</li>
			);
		}
	}
}

/** One case, and what came of it once it has been tried. */
function Case({
	c,
	r,
	applied,
	apply,
}: {
	c: BenchCase;
	r: BenchResult | undefined;
	applied: Set<string>;
	apply: (s: BenchSuggestion) => void;
}) {
	const t = useT();
	const name = c.own ? c.label || c.text.slice(0, 60) : t(`guard.case_${c.id}` as MessageKey);
	const Mark = r?.ok === true ? Check : r?.ok === false ? X : Minus;
	return (
		<li
			className="rounded-xl border border-border bg-bg-soft px-3 py-2 text-sm"
			data-testid="bench-case"
			data-id={c.id}
			data-outcome={r?.outcome ?? "pending"}
			data-ok={r ? String(r.ok) : "pending"}
		>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span className="font-medium">{name}</span>
				<span className="rounded-full bg-hover px-2 py-0.5 text-xs text-muted">
					{c.expect === "harmful" ? t("guard.benchExpectHarmful") : t("guard.benchExpectHarmless")}
				</span>
			</div>
			<pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted">
				{c.text}
			</pre>
			{r ? (
				<div className="mt-2 space-y-1">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span
							className={cx(
								"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
								r.ok === true && "bg-success/15 text-success",
								r.ok === false && "bg-danger/10 text-danger",
								r.ok === null && "bg-warning/15 text-warning",
							)}
							data-testid="bench-got"
						>
							<Mark size={12} aria-hidden />
							{t(BENCH_OUTCOME_TEXT[r.outcome])}
							<span className="sr-only">
								{" — "}
								{r.ok === true
									? t("guard.benchOk")
									: r.ok === false
										? t("guard.benchMiss")
										: t("guard.benchNotDecided")}
							</span>
						</span>
						<span className="text-xs text-muted" data-testid="bench-by">
							{t("guard.benchBy", { by: t(BY_TEXT[r.by]) })}
							{r.model ? ` · ${r.model}` : ""}
						</span>
					</div>
					<p className="break-words text-xs" data-testid="bench-reason">
						{r.reason}
					</p>
					{r.suggestions.length > 0 ? (
						<div className="rounded-lg bg-surface px-2 py-1.5 text-xs" data-testid="bench-suggestions">
							<div className="font-medium">{t("guard.sugTitle")}</div>
							<ul className="mt-1 list-disc space-y-1 pl-4">
								{r.suggestions.map((s) => (
									<Suggestion
										key={JSON.stringify(s)}
										s={s}
										applied={applied.has(JSON.stringify(s))}
										onApply={() => apply(s)}
									/>
								))}
							</ul>
						</div>
					) : null}
				</div>
			) : null}
		</li>
	);
}

/**
 * Guard › Benchmark: a shipped set of harmful and harmless calls, and the person's own, put through what the guard is set to
 * now. The classifier and the category settings decide most of them; the reviewer model is asked, when the person says so, for
 * those the settings send to it. Nothing is run: every case is only read. What slipped through says which setting would stop it.
 */
export default function GuardBench() {
	const t = useT();
	const [info, setInfo] = useState<BenchInfo | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [applied, setApplied] = useState<Set<string>>(new Set());
	const own = useGuard((s) => s.rules?.cases) ?? [];
	const run = info?.run ?? null;
	const running = run?.state === "running";
	const ids = useId();

	const refresh = useCallback(
		() =>
			guardApi.bench().then(
				(i) => {
					setInfo(i);
					setProblem(null);
				},
				(e) => setProblem(messageOf(e)),
			),
		[],
	);

	useEffect(() => {
		void refresh();
		guardApi.rules().catch(() => {});
	}, [refresh]);

	// While a run is under way its results arrive: asked for again until it has ended.
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => void refresh(), POLL_MS);
		return () => clearInterval(timer);
	}, [running, refresh]);

	const start = async (reviewer: boolean) => {
		setProblem(null);
		setApplied(new Set());
		try {
			const { run: began } = await guardApi.startBench(reviewer);
			setInfo((i) => (i ? { ...i, run: began } : i));
		} catch (e) {
			setProblem(messageOf(e));
		}
	};

	const cancel = async () => {
		try {
			await guardApi.cancelBench();
			await refresh();
		} catch (e) {
			setProblem(messageOf(e));
		}
	};

	const apply = async (s: BenchSuggestion) => {
		if (s.kind !== "threshold") return;
		try {
			await guardApi.changeRules({ thresholds: { [s.risk]: s.to === "ask" ? null : s.to } });
			setApplied((a) => new Set(a).add(JSON.stringify(s)));
		} catch (e) {
			setProblem(messageOf(e));
		}
	};

	const cases = run?.cases ?? info?.cases ?? [];
	const results = useMemo(() => new Map((run?.results ?? []).map((r) => [r.id, r])), [run]);

	// ---- the person's own cases
	const [command, setCommand] = useState("");
	const [label, setLabel] = useState("");
	const [expect, setExpect] = useState<Expect>("harmful");
	const [ownProblem, setOwnProblem] = useState<string | null>(null);
	const saveCases = async (cases: UserCase[]): Promise<boolean> => {
		try {
			await guardApi.changeRules({ cases });
			setOwnProblem(null);
			await refresh();
			return true;
		} catch (e) {
			setOwnProblem(messageOf(e));
			return false;
		}
	};
	const add = async () => {
		if (command.trim() === "") return;
		const next: UserCase = { id: newCaseId(), label: label.trim(), command, expect };
		if (await saveCases([...own, next])) {
			setCommand("");
			setLabel("");
		}
	};

	const summary = run?.summary;
	const done = run?.results.length ?? 0;

	return (
		<div className="space-y-6 px-4 pb-6 pt-3 sm:px-6" data-testid="guard-bench">
			<section className="rounded-2xl border border-border bg-surface p-4">
				<h2 className="text-title font-semibold">{t("guard.benchTitle")}</h2>
				<p className="mt-1 max-w-prose text-xs text-muted">{t("guard.benchIntro")}</p>
				<div className="mt-3 flex flex-wrap items-center gap-2">
					<Button
						variant="primary"
						data-testid="bench-run"
						disabled={running || info === null}
						onClick={() => void start(false)}
					>
						{t("guard.benchRun")}
					</Button>
					<Button
						data-testid="bench-run-reviewer"
						disabled={running || !info?.reviewerAvailable}
						onClick={() => void start(true)}
					>
						{t("guard.benchRunReviewer")}
					</Button>
					{running ? (
						<Button variant="danger" data-testid="bench-cancel" onClick={() => void cancel()}>
							{t("guard.benchCancel")}
						</Button>
					) : null}
				</div>
				<p className="mt-2 max-w-prose text-xs text-muted" data-testid="bench-reviewer-note">
					{info?.reviewerAvailable
						? t("guard.benchReviewerHint", { max: info.maxRequests })
						: t("guard.benchNoReviewer")}
				</p>
				{run?.mode === "off" ? (
					<p className="mt-2 flex items-start gap-1.5 text-xs text-warning" data-testid="bench-off">
						<CircleAlert size={12} className="mt-0.5 shrink-0" aria-hidden /> {t("guard.benchOffWarn")}
					</p>
				) : null}
				{problem !== null ? (
					<p className="mt-2 text-xs text-danger" role="alert" data-testid="bench-error">
						{t("guard.benchFailed", { error: problem })}
					</p>
				) : null}

				<div
					className="mt-3 text-sm"
					role="status"
					aria-live="polite"
					data-testid="bench-status"
					data-state={run?.state ?? "idle"}
				>
					{running ? (
						<span className="inline-flex items-center gap-1.5 text-muted">
							<Spinner size={12} /> {t("guard.benchRunning", { done, total: run?.cases.length ?? 0 })}
						</span>
					) : null}
					{summary ? (
						<div className="mt-1 space-y-0.5" data-testid="bench-summary">
							<div className="font-medium" data-testid="bench-summary-line">
								{t("guard.benchSummary", {
									stopped: summary.harmful.stopped,
									harmful: summary.harmful.total,
									through: summary.harmless.letThrough,
									harmless: summary.harmless.total,
								})}
							</div>
							{summary.harmful.slipped > 0 ? (
								<div className="text-xs text-danger" data-testid="bench-slipped">
									{t("guard.benchSlipped", { count: summary.harmful.slipped })}
								</div>
							) : null}
							{summary.harmless.held > 0 ? (
								<div className="text-xs text-muted" data-testid="bench-held">
									{t("guard.benchHeld", { count: summary.harmless.held })}
								</div>
							) : null}
							{summary.harmful.undecided + summary.harmless.undecided > 0 && !running ? (
								<div className="text-xs text-muted" data-testid="bench-undecided">
									{t("guard.benchUndecided", { count: summary.harmful.undecided + summary.harmless.undecided })}
								</div>
							) : null}
							{run && !running ? (
								<div className="text-xs text-muted">
									{run.state === "cancelled"
										? t("guard.benchCancelled")
										: run.state === "failed"
											? t("guard.benchFailed", { error: run.error ?? "" })
											: t("guard.benchDone")}
									{run.reviewers.length > 0
										? ` · ${t("guard.benchReviewers", { models: run.reviewers.join(", ") })}`
										: ""}
									{run.requests > 0 ? ` · ${t("guard.benchRequests", { count: run.requests })}` : ""}
								</div>
							) : null}
							{run?.error && run.state !== "failed" ? (
								<div className="text-xs text-warning" data-testid="bench-run-error">
									{run.error}
								</div>
							) : null}
						</div>
					) : null}
				</div>
			</section>

			<section className="rounded-2xl border border-border bg-surface p-4">
				<h2 className="text-title font-semibold">{t("guard.ownTitle")}</h2>
				<p className="mt-1 max-w-prose text-xs text-muted">{t("guard.ownHint")}</p>
				<div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem]">
					<label className="block text-xs text-muted" htmlFor={`${ids}-name`}>
						<span className="mb-1 block">{t("guard.ownName")}</span>
						<input
							id={`${ids}-name`}
							className="h-9 w-full rounded-xl border border-border bg-bg-soft px-3 text-sm text-fg outline-none focus:border-faint"
							data-testid="bench-own-name"
							maxLength={CASE_LABEL_MAX}
							value={label}
							onChange={(e) => setLabel(e.target.value)}
						/>
					</label>
					<label className="block text-xs text-muted" htmlFor={`${ids}-expect`}>
						<span className="mb-1 block">{t("guard.ownExpect")}</span>
						<Select
							id={`${ids}-expect`}
							data-testid="bench-own-expect"
							value={expect}
							onValueChange={(v) => setExpect(v as Expect)}
						>
							<option value="harmful">{t("guard.ownHarmful")}</option>
							<option value="harmless">{t("guard.ownHarmless")}</option>
						</Select>
					</label>
					<label className="block text-xs text-muted sm:col-span-2" htmlFor={`${ids}-command`}>
						<span className="mb-1 block">{t("guard.ownCommand")}</span>
						<textarea
							id={`${ids}-command`}
							className="min-h-16 w-full rounded-xl border border-border bg-bg-soft p-2 font-mono text-xs text-fg outline-none focus:border-faint"
							data-testid="bench-own-command"
							spellCheck={false}
							maxLength={CASE_TEXT_MAX}
							value={command}
							onChange={(e) => setCommand(e.target.value)}
						/>
					</label>
				</div>
				<div className="mt-2 flex flex-wrap items-center gap-3">
					<Button
						data-testid="bench-own-add"
						disabled={command.trim() === "" || own.length >= CASES_MAX}
						onClick={() => void add()}
					>
						{t("guard.ownAdd")}
					</Button>
					{own.length >= CASES_MAX ? (
						<span className="text-xs text-muted">{t("guard.ownTooMany", { max: CASES_MAX })}</span>
					) : null}
					{ownProblem !== null ? (
						<span className="text-xs text-danger" role="alert" data-testid="bench-own-error">
							{t("guard.saveFailed", { error: ownProblem })}
						</span>
					) : null}
				</div>
				{own.length > 0 ? (
					<ul className="mt-3 space-y-1" data-testid="bench-own-list">
						{own.map((c) => (
							<li key={c.id} className="flex items-center gap-2 text-xs" data-testid="bench-own-item">
								<span className="min-w-0 flex-1 truncate">
									<span className="font-medium">{c.label || c.command.slice(0, 40)}</span>
									<span className="ml-2 font-mono text-muted">{c.command.split("\n")[0]}</span>
								</span>
								<Button
									size="sm"
									data-testid={`bench-own-remove-${c.id}`}
									aria-label={t("guard.ownRemove", { name: c.label || c.command.slice(0, 40) })}
									onClick={() => void saveCases(own.filter((x) => x.id !== c.id))}
								>
									{t("guard.ownRemoveShort")}
								</Button>
							</li>
						))}
					</ul>
				) : (
					<p className="mt-3 text-xs text-muted">{t("guard.ownNone")}</p>
				)}
			</section>

			{GROUPS.map((group) => {
				const inGroup = cases.filter((c) => c.group === group);
				if (inGroup.length === 0) return null;
				return (
					<section key={group} aria-labelledby={`${ids}-${group}`} data-testid={`bench-group-${group}`}>
						<h3 id={`${ids}-${group}`} className="mb-2 text-sm font-medium">
							{t(BENCH_GROUP_TEXT[group])}
						</h3>
						<ul className="space-y-2">
							{inGroup.map((c) => (
								<Case key={c.id} c={c} r={results.get(c.id)} applied={applied} apply={(s) => void apply(s)} />
							))}
						</ul>
					</section>
				);
			})}
		</div>
	);
}
