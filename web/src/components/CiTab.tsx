import {
	CI_RUN_LIMIT,
	type CiAnswer,
	type CiJob,
	type CiProblem,
	type CiRun,
	type CiScope,
	type CiState,
	ciDurationMs,
	isActive,
} from "@shared/ci.ts";
import { PREF } from "@shared/prefs.ts";
import {
	Bell,
	BellOff,
	ChevronRight,
	CircleCheck,
	CircleDashed,
	CircleMinus,
	CircleSlash,
	CircleX,
	ExternalLink,
	Loader2,
	RefreshCw,
	Workflow,
} from "lucide-react";
import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { en } from "../i18n/ci.ts";
import { type MessageKey, registerStrings, type Translate, useT } from "../i18n/index.ts";
import { setNotifications, useNotify } from "../lib/attention.ts";
import { askJobs, ciNotifyPossible, ciWatcher, useCiRuns } from "../lib/ci-runs.ts";
import { fmtElapsed } from "../lib/clock.ts";
import { fmtRelative } from "../lib/format.ts";
import { onPrefsChanged, setPref } from "../lib/prefs.ts";
import { ScrollPane } from "./ScrollPane.tsx";
import { cx, Empty, IconButton, Spinner } from "./ui.tsx";

// This chunk carries its own English strings: the first page does not (see `registerStrings`).
registerStrings("ci", en);

/**
 * The side panel's CI tab: the GitHub Actions runs of the conversation's folder, of its current branch or of every branch,
 * asked of the person's `gh` by the server (`server/gh-runs.ts`) through the page's shared watcher (`lib/ci-runs.ts`). A run
 * unfolds to its jobs, each with how long it took, the step that failed and a link to its log on GitHub. Read only.
 */

const SCOPES: { value: CiScope; key: MessageKey }[] = [
	{ value: "branch", key: "ci.scopeBranch" },
	{ value: "all", key: "ci.scopeAll" },
];

const STATE_KEYS: Record<CiState, MessageKey> = {
	queued: "ci.stateQueued",
	running: "ci.stateRunning",
	success: "ci.stateSuccess",
	failure: "ci.stateFailure",
	cancelled: "ci.stateCancelled",
	skipped: "ci.stateSkipped",
};

function problemText(t: Translate, problem: CiProblem, message?: string): string {
	switch (problem) {
		case "no-gh":
			return t("ci.problemNoGh");
		case "signed-out":
			return t("ci.problemSignedOut");
		case "no-repo":
			return t("ci.problemNoRepo");
		case "unsafe":
			return t("ci.problemUnsafe", { why: message ?? "" });
		case "slow":
			return t("ci.problemSlow");
		case "rate-limited":
			return t("ci.problemRateLimited");
		case "failed":
			return message ? t("ci.problemFailed", { message }) : t("ci.problemFailedBare");
	}
}

function Problem({ answer }: { answer: { problem: CiProblem; message?: string } }) {
	const t = useT();
	return (
		<p
			className="rounded-lg border border-border bg-surface p-3 text-xs text-muted"
			role="alert"
			data-testid="ci-problem"
			data-problem={answer.problem}
		>
			{problemText(t, answer.problem, answer.message)}
		</p>
	);
}

/** A run's or a job's state as an icon, with its name for a screen reader. */
function StateIcon({ state, size = 14 }: { state: CiState; size?: number }) {
	const t = useT();
	const icon =
		state === "queued" ? (
			<CircleDashed size={size} className="text-muted" aria-hidden />
		) : state === "running" ? (
			<Loader2 size={size} className="animate-spin text-warning motion-reduce:animate-none" aria-hidden />
		) : state === "success" ? (
			<CircleCheck size={size} className="text-success" aria-hidden />
		) : state === "failure" ? (
			<CircleX size={size} className="text-danger" aria-hidden />
		) : state === "cancelled" ? (
			<CircleSlash size={size} className="text-muted" aria-hidden />
		) : (
			<CircleMinus size={size} className="text-muted" aria-hidden />
		);
	return (
		<span className="inline-flex shrink-0" title={t(STATE_KEYS[state])}>
			{icon}
			<span className="sr-only">{t(STATE_KEYS[state])}</span>
		</span>
	);
}

/** How long it took, or has run so far; null when it has not started. */
function durationText(t: Translate, started: string | undefined, ended: string | undefined, state: CiState) {
	const ms = ciDurationMs(started, ended, isActive(state), Date.now());
	if (ms === null || state === "queued") return null;
	return isActive(state)
		? t("ci.runningFor", { duration: fmtElapsed(ms) })
		: t("ci.took", { duration: fmtElapsed(ms) });
}

/** The `ompw.ciNotify` switch, kept in step with another tab or window that changes it. */
function NotifyToggle() {
	const t = useT();
	const [on, setOn] = useState(() => localStorage.getItem(PREF.ciNotify) === "on");
	const [blocked, setBlocked] = useState(false);
	const enabled = useNotify((s) => s.enabled);
	useEffect(
		() =>
			onPrefsChanged((keys) => {
				if (keys.includes(PREF.ciNotify)) setOn(localStorage.getItem(PREF.ciNotify) === "on");
			}),
		[],
	);
	const toggle = async () => {
		if (on) {
			setPref(PREF.ciNotify, "off");
			setOn(false);
			setBlocked(false);
			return;
		}
		// The app's notifications are what tells it: turning this on turns them on (the browser asks the first time).
		if (!useNotify.getState().enabled) await setNotifications(true);
		if (!useNotify.getState().enabled) {
			setBlocked(true);
			return;
		}
		setPref(PREF.ciNotify, "on");
		setOn(true);
		setBlocked(false);
	};
	const pressed = on && enabled;
	return (
		<>
			<IconButton
				label={t("ci.notify")}
				size="sm"
				aria-pressed={pressed}
				active={pressed}
				onClick={() => void toggle()}
				data-testid="ci-notify"
			>
				{pressed ? <Bell size={14} /> : <BellOff size={14} />}
			</IconButton>
			{blocked ? (
				<p className="basis-full text-xs text-muted" role="status" data-testid="ci-notify-blocked">
					{t("ci.notifyBlocked")}
				</p>
			) : null}
		</>
	);
}

export function CiTab({ cwd }: { cwd: string | null }) {
	const t = useT();
	const [scope, setScope] = useState<CiScope>("branch");
	const view = useCiRuns(cwd, scope);
	const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
	// Another conversation's folder is another repository.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `cwd` is the trigger.
	useEffect(() => setExpanded(new Set()), [cwd]);

	if (!cwd) {
		return (
			<ScrollPane className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="ci-tab">
				<Empty icon={<Workflow size={22} />} title={t("ci.noFolder")} />
			</ScrollPane>
		);
	}
	const answer = view?.answer ?? null;
	const list = answer?.ok ? answer.value : null;
	const toggle = (id: number) =>
		setExpanded((was) => {
			const next = new Set(was);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="ci-tab">
			<div className="flex flex-col gap-1.5 border-b border-border p-3">
				<div className="flex flex-wrap items-center gap-2">
					<fieldset className="flex rounded-lg border border-border p-0.5">
						<legend className="sr-only">{t("ci.scopeLabel")}</legend>
						{SCOPES.map((s) => (
							<button
								key={s.value}
								type="button"
								aria-pressed={scope === s.value}
								data-testid={`ci-scope-${s.value}`}
								onClick={() => setScope(s.value)}
								className={cx(
									"h-6 rounded-md px-2 text-xs text-muted hover:text-fg",
									scope === s.value && "bg-hover text-fg",
								)}
							>
								{t(s.key)}
							</button>
						))}
					</fieldset>
					<span className="flex-1" />
					{view?.loading ? <Spinner size={14} /> : null}
					{ciNotifyPossible() ? <NotifyToggle /> : null}
					<IconButton
						label={t("ci.refresh")}
						size="sm"
						onClick={() => ciWatcher.refresh(cwd, scope)}
						data-testid="ci-refresh"
					>
						<RefreshCw size={14} />
					</IconButton>
				</div>
				{list ? (
					<p className="truncate text-xs text-muted" data-testid="ci-branch">
						{list.branch === null ? t("ci.detached") : t("ci.branchIs", { branch: list.branch })}
					</p>
				) : null}
			</div>
			<ScrollPane className="min-h-0 flex-1 overflow-y-auto">
				{answer === null ? (
					<div className="flex justify-center py-10">
						<Spinner />
					</div>
				) : !answer.ok ? (
					<div className="p-3">
						<Problem answer={answer} />
					</div>
				) : list && list.runs.length === 0 ? (
					<Empty icon={<Workflow size={22} />} title={t("ci.empty")}>
						{list.scope === "branch" && list.branch !== null
							? t("ci.emptyBranch", { branch: list.branch })
							: t("ci.emptyAll")}
					</Empty>
				) : (
					<ul aria-label={t("ci.listLabel")} data-testid="ci-list">
						{list?.runs.map((run) => (
							<RunRow
								key={run.id}
								cwd={cwd}
								run={run}
								expanded={expanded.has(run.id)}
								onToggle={() => toggle(run.id)}
							/>
						))}
					</ul>
				)}
				{list && list.runs.length > 0 ? (
					<p className="px-3 py-2 text-xs text-muted">
						{t("ci.countShown", { n: Math.min(list.runs.length, CI_RUN_LIMIT) })}
						{" · "}
						{t("ci.readOnly")}
					</p>
				) : null}
			</ScrollPane>
		</div>
	);
}

function RunRow({
	cwd,
	run,
	expanded,
	onToggle,
}: {
	cwd: string;
	run: CiRun;
	expanded: boolean;
	onToggle: () => void;
}) {
	const t = useT();
	const when =
		run.state === "queued" || !run.startedAt
			? t("ci.queuedAt", { when: fmtRelative(run.createdAt) })
			: t("ci.startedAt", { when: fmtRelative(run.startedAt) });
	const took = durationText(t, run.startedAt, run.updatedAt, run.state);
	const jobsId = `ci-jobs-${run.id}`;
	return (
		<li className="border-b border-border" data-testid="ci-run" data-id={run.id} data-state={run.state}>
			<div className="flex items-start gap-1 px-2 py-2 hover:bg-hover">
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={expanded}
					aria-controls={expanded ? jobsId : undefined}
					data-testid="ci-run-toggle"
					className="flex min-w-0 flex-1 items-start gap-1.5 rounded-md text-left"
				>
					<ChevronRight
						size={14}
						className={cx("mt-0.5 shrink-0 text-muted transition-transform", expanded && "rotate-90")}
						aria-hidden
					/>
					<span className="mt-0.5">
						<StateIcon state={run.state} />
					</span>
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="break-words text-sm text-fg">{run.workflow}</span>
						<span className="break-words text-xs text-muted" data-testid="ci-run-title">
							{run.title}
						</span>
						<span className="flex flex-wrap gap-x-1.5 text-xs text-muted">
							<span className="break-all">{run.branch}</span>
							<span aria-hidden>·</span>
							<span>{run.event}</span>
							<span aria-hidden>·</span>
							<span>{when}</span>
							{took ? (
								<>
									<span aria-hidden>·</span>
									<span data-testid="ci-run-duration">{took}</span>
								</>
							) : null}
						</span>
					</span>
				</button>
				<a
					href={run.url}
					target="_blank"
					rel="noreferrer noopener"
					aria-label={t("ci.runOnGitHub", { workflow: run.workflow })}
					title={t("ci.openOnGitHub")}
					className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
					data-testid="ci-run-link"
				>
					<ExternalLink size={14} />
				</a>
			</div>
			{expanded ? <RunJobs id={jobsId} cwd={cwd} run={run} /> : null}
		</li>
	);
}

function RunJobs({ id, cwd, run }: { id: string; cwd: string; run: CiRun }) {
	const t = useT();
	const [answer, setAnswer] = useState<CiAnswer<CiJob[]> | null>(null);
	// Asked again whenever the run's own entry changes (the list is looked at every 10 s while it runs).
	// biome-ignore lint/correctness/useExhaustiveDependencies: the run's state and update time are the triggers.
	useEffect(() => {
		let current = true;
		void askJobs(cwd, run.id).then((got) => {
			if (current) setAnswer(got);
		});
		return () => {
			current = false;
		};
	}, [cwd, run.id, run.state, run.updatedAt]);
	return (
		<div id={id} className="pb-2 pl-9 pr-3">
			{answer === null ? (
				<p className="flex items-center gap-2 text-xs text-muted">
					<Spinner size={12} />
					{t("ci.jobsLoading")}
				</p>
			) : !answer.ok ? (
				<Problem answer={answer} />
			) : answer.value.length === 0 ? (
				<p className="text-xs text-muted">{t("ci.jobsEmpty")}</p>
			) : (
				<ul
					aria-label={t("ci.jobsLabel", { workflow: run.workflow })}
					className="flex flex-col gap-1"
					data-testid="ci-jobs"
				>
					{answer.value.map((job) => {
						const took = durationText(t, job.startedAt, job.completedAt, job.state);
						return (
							<li key={job.id} className="flex items-start gap-1.5 text-xs" data-testid="ci-job" data-state={job.state}>
								<span className="mt-px">
									<StateIcon state={job.state} size={13} />
								</span>
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="break-words text-fg">{job.name}</span>
									{took ? <span className="text-muted">{took}</span> : null}
									{job.failedStep ? (
										<span className="break-words text-danger" data-testid="ci-job-failed-step">
											{t("ci.failedStep", { step: job.failedStep })}
										</span>
									) : null}
								</span>
								<a
									href={job.url}
									target="_blank"
									rel="noreferrer noopener"
									aria-label={t("ci.logOf", { job: job.name })}
									className={cx(
										"inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-hover",
										job.state === "failure" ? "text-danger" : "text-muted hover:text-fg",
									)}
									data-testid="ci-job-log"
								>
									{t("ci.viewLog")}
									<ExternalLink size={12} aria-hidden />
								</a>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
