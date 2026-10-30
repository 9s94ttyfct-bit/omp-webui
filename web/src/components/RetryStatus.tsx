import type { CompactQueued } from "@shared/compact-queue.ts";
import { Archive, CircleAlert, CircleCheck, Hand, Hourglass, Info, X } from "lucide-react";
import { useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { cancelCompact } from "../lib/compact-queue.ts";
import { fmtTokens } from "../lib/format.ts";
import { useNow } from "../lib/now.ts";
import { type RetryWait, retryLeftMs, retryPhase } from "../lib/retry-wait.ts";
import { setSoftStop } from "../lib/soft-stop.ts";
import { STEP_UNAVAILABLE_TEXT } from "../lib/step-unavailable.ts";
import { fmtCountdown, resetTime } from "../lib/usage-limit.ts";
import { abortRetry, retryNow, useApp } from "../store/app.ts";
import type { CompactionOutcome, LiveState } from "../store/live.ts";
import { IconButton, Spinner } from "./ui.tsx";

/** Why omp compacts, in the TUI's words: a threshold is the ordinary case and goes unsaid. */
const REASONS: Record<string, MessageKey> = {
	overflow: "chat.compactingReasonOverflow",
	incomplete: "chat.compactingReasonIncomplete",
	idle: "chat.compactingReasonIdle",
};

/** What omp does about it, by omp's action name; anything it adds later reads as the plain compaction, as in the TUI. */
const ACTIONS: Record<string, { running: MessageKey; name: MessageKey }> = {
	remote: { running: "chat.compactingRemote", name: "chat.compactionRemote" },
	handoff: { running: "chat.compactingHandoff", name: "chat.compactionHandoff" },
	shake: { running: "chat.compactingShake", name: "chat.compactionShake" },
	snapcompact: { running: "chat.compactingSnapcompact", name: "chat.compactionSnapcompact" },
};
const DEFAULT_ACTION = { running: "chat.compactingContextFull", name: "chat.compactionContextFull" } as const;

const actionOf = (action: string | undefined) =>
	action !== undefined && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : DEFAULT_ACTION;

/** A finished compaction's line stays this long on screen; a failed one stays until it is dismissed. */
const OUTCOME_SHOWN_MS = 20_000;

function OutcomeRow({ outcome }: { outcome: CompactionOutcome }) {
	const t = useT();
	const [dismissed, setDismissed] = useState<number | null>(null);
	const failed = outcome.kind === "failed";
	const now = useNow(failed ? null : 1000);
	if (dismissed === outcome.at || (!failed && now - outcome.at > OUTCOME_SHOWN_MS)) return null;
	const action = t(actionOf(outcome.action).name);
	const text =
		outcome.kind === "cancelled"
			? t("chat.compactionCancelled", { action })
			: outcome.kind === "completed"
				? outcome.tokensBefore
					? t("chat.compactionCompletedTokens", { action, tokens: fmtTokens(outcome.tokensBefore) })
					: t("chat.compactionCompleted", { action })
				: outcome.message
					? t("chat.compactionFailedWith", { action, message: outcome.message })
					: t("chat.compactionFailed", { action });
	const Icon = failed ? CircleAlert : outcome.kind === "completed" ? CircleCheck : Info;
	return (
		<div
			className="mb-2 flex items-start gap-2 text-xs text-muted"
			role="status"
			data-testid="compaction-outcome"
			data-kind={outcome.kind}
		>
			<Icon
				size={13}
				className={
					failed
						? "mt-px shrink-0 text-warning"
						: outcome.kind === "completed"
							? "mt-px shrink-0 text-success"
							: "mt-px shrink-0"
				}
				aria-hidden
			/>
			<span className="min-w-0 flex-1 break-words">{text}</span>
			<IconButton
				label={t("chat.compactionDismiss")}
				size="sm"
				className="-mt-1 -mr-1"
				data-testid="compaction-outcome-dismiss"
				onClick={() => setDismissed(outcome.at)}
			>
				<X size={13} />
			</IconButton>
		</div>
	);
}

/**
 * omp backing off before it retries a failed turn, as it announced it: the countdown, with a Cancel (omp's
 * `abort_retry`). A usage limit is the same retry with a wait of hours (omp's `retry.waitForUsageReset`), so it is a
 * card of its own, with Retry now. When the time is up and omp has neither started the turn nor ended the retry for
 * more than half a minute, the page says omp has not retried and offers Retry now, which does not rely on omp's timer.
 * The ticking countdown is no live region: a screen reader is told once for each stage.
 */
function RetryWaiting({ live, wait }: { live: LiveState; wait: RetryWait }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const [pending, setPending] = useState(false);
	const paused = live.info.pausedAt !== null;
	// Once omp has started the retried turn nothing counts down.
	const now = useNow(wait.resumed ? null : 250);
	const phase = retryPhase(wait, now, paused, live.resumedAt);
	const left = retryLeftMs(wait, now);
	const late = now - (wait.startedAt + wait.delayMs);
	const vars = { attempt: wait.attempt, max: wait.maxAttempts };
	const overdue = phase === "overdue";
	const canCancel = phase === "counting" || overdue;
	const canRetryNow = phase !== "running" && (wait.usageLimit || overdue);
	const onRetryNow = () => {
		setPending(true);
		retryNow(live.info.liveId)
			.catch((e) => toast("error", t("chat.retryNowFailed", { error: (e as Error).message })))
			.finally(() => setPending(false));
	};
	const announcement = overdue
		? t("chat.retryAnnounceOverdue")
		: phase === "counting"
			? wait.usageLimit
				? t("chat.retryAnnounceUsage")
				: t("chat.retryAnnounce", vars)
			: t("chat.retryingNow", vars);
	const countdown =
		phase === "counting"
			? wait.usageLimit
				? t("chat.usageLimitResumes", {
						time: fmtCountdown(left),
						at: resetTime((wait.startedAt + wait.delayMs) / 1000, now),
					})
				: t("chat.retrying", { ...vars, time: fmtCountdown(left) })
			: overdue
				? t("chat.retryOverdue", { late: fmtCountdown(late) })
				: wait.usageLimit
					? t("chat.usageLimitReset")
					: t("chat.retryingNow", vars);
	const announce = (
		<span className="sr-only" role="status" data-testid="retry-announce">
			{announcement}
		</span>
	);
	const kind = overdue ? "overdue" : wait.usageLimit ? "usage-limit" : "backoff";
	const Icon = overdue ? CircleAlert : Hourglass;
	// Every wait is a card: a backoff of seconds was a line of small muted text that went unseen next to the usage limit's.
	return (
		<div
			className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-fg"
			data-testid="retry-wait"
			data-kind={kind}
		>
			{announce}
			{kind === "backoff" ? (
				<Spinner size={15} className="shrink-0 text-warning" />
			) : (
				<Icon size={15} className="shrink-0 text-warning" aria-hidden />
			)}
			<div className="min-w-0 flex-1 basis-56">
				{kind === "backoff" ? (
					<div className="font-medium tabular-nums" data-testid="retry-countdown">
						{countdown}
					</div>
				) : (
					<>
						<div className="font-medium">{overdue ? t("chat.retryOverdueTitle") : t("chat.usageLimitTitle")}</div>
						<div className="text-xs text-muted tabular-nums" data-testid="retry-countdown">
							{countdown}
						</div>
					</>
				)}
				{paused && phase !== "running" ? <div className="text-xs text-muted">{t("chat.retryPausedNote")}</div> : null}
			</div>
			<div className="flex flex-wrap gap-2">
				{canCancel ? (
					<button
						type="button"
						data-testid="retry-cancel"
						className="inline-flex h-8 items-center rounded-full border border-border bg-surface px-3 text-xs font-medium hover:bg-hover"
						onClick={() => abortRetry(live.info.liveId)}
					>
						{t("common.cancel")}
					</button>
				) : null}
				{canRetryNow ? (
					<button
						type="button"
						data-testid="retry-now"
						disabled={pending}
						className="inline-flex h-8 items-center rounded-full bg-accent px-3 text-xs font-medium text-accent-fg hover:brightness-110 disabled:opacity-50"
						onClick={onRetryNow}
					>
						{t("chat.retryNow")}
					</button>
				) : null}
			</div>
		</div>
	);
}

/**
 * A compact asked for while the agent worked (#651): it waits for the end of the turn, or for the next point between two steps,
 * with the messages queued behind it, and then runs. The server holds it (`LiveInfo.compactQueued`), so this is the same line
 * on every page and after a reload. A compact made between steps leaves the turn going: the messages behind it wait for its end.
 */
function QueuedCompactLine({ live, queued }: { live: LiveState; queued: CompactQueued }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	if (queued.phase === "running") {
		return (
			<div className="flex items-center gap-2" role="status" data-testid="compact-queued-line" data-phase="running">
				<Spinner size={13} className="text-accent" />
				<span>{t("chat.compacting")}</span>
			</div>
		);
	}
	const behind = queued.held.length;
	if (queued.phase === "following") {
		return (
			<div
				className="flex flex-wrap items-center gap-x-2 gap-y-1"
				role="status"
				data-testid="compact-queued-line"
				data-phase="following"
			>
				<Archive size={13} className="shrink-0 text-accent" aria-hidden />
				<span>
					{t("chat.compactFollowing")}
					{behind > 0
						? ` ${behind === 1 ? t("chat.compactFollowingHeldOne") : t("chat.compactFollowingHeld", { n: behind })}`
						: ""}
				</span>
			</div>
		);
	}
	return (
		<div
			className="flex flex-col gap-1"
			role="status"
			data-testid="compact-queued-line"
			data-phase="queued"
			data-where={queued.where}
		>
			{/* Icon, text and Cancel stay together: the text wraps in its own column on a phone, Cancel never breaks, and on a wide line Cancel follows the text instead of standing at the far edge. */}
			<div className="flex items-start gap-2">
				<Archive size={13} className="mt-0.5 shrink-0 text-accent" aria-hidden />
				<span className="min-w-0">
					{t(queued.where === "step" ? "chat.compactQueuedStep" : "chat.compactQueued")}
					{behind > 0
						? ` ${behind === 1 ? t("chat.compactQueuedHeldOne") : t("chat.compactQueuedHeld", { n: behind })}`
						: ""}
				</span>
				<button
					type="button"
					data-testid="compact-queued-cancel"
					className="shrink-0 whitespace-nowrap underline hover:text-fg"
					onClick={() =>
						void cancelCompact(live.info.liveId).catch((e) =>
							toast("error", t("chat.compactCancelFailed", { error: (e as Error).message })),
						)
					}
				>
					{t("common.cancel")}
				</button>
			</div>
			{queued.stepUnavailable ? (
				<span data-testid="compact-step-unavailable" data-reason={queued.stepUnavailable}>
					{t(STEP_UNAVAILABLE_TEXT[queued.stepUnavailable])}
				</span>
			) : null}
		</div>
	);
}

/**
 * A soft stop asked for (#658): the agent writes its handoff, and when the turn ends the server ends the process. Held by
 * the server (`LiveInfo.softStop`), so every page shows it; Cancel takes it back (the turn goes on as usual).
 */
function SoftStopLine({ live }: { live: LiveState }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	return (
		<div className="flex items-start gap-2" role="status" data-testid="soft-stop-line">
			<Hand size={13} className="mt-0.5 shrink-0 text-accent" aria-hidden />
			<span className="min-w-0">{t("chat.softStopPending")}</span>
			<button
				type="button"
				data-testid="soft-stop-cancel"
				className="shrink-0 whitespace-nowrap underline hover:text-fg"
				onClick={() =>
					void setSoftStop(live.info.liveId, false).catch((e) =>
						toast("error", t("chat.softStopCancelFailed", { error: (e as Error).message })),
					)
				}
			>
				{t("common.cancel")}
			</button>
		</div>
	);
}

/**
 * What omp is doing by itself between turns: backing off before it retries a failed one (see `RetryWaiting`), or
 * compacting a full context, with the reason and what it does about it as the TUI words them. A retry that gave up
 * stays until the next turn starts; a compaction leaves a line saying how it ended.
 */
export function RetryStatus({ live }: { live: LiveState }) {
	const t = useT();
	const { retry, compacting, compactionOutcome } = live;
	const queued = live.info.compactQueued;
	const softStop = live.info.softStop && !live.exited;
	if (!retry && !compacting && !compactionOutcome && !queued && !softStop) return null;
	return (
		<>
			{retry || compacting || queued || softStop ? (
				<div className="mb-2 flex flex-col gap-1 text-xs text-muted" data-testid="retry-status">
					{retry?.phase === "waiting" ? <RetryWaiting live={live} wait={retry} /> : null}
					{softStop ? <SoftStopLine live={live} /> : null}
					{queued ? <QueuedCompactLine live={live} queued={queued} /> : null}
					{retry?.phase === "failed" ? (
						<div
							className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-fg"
							role="status"
							data-testid="retry-failed"
						>
							<CircleAlert size={15} className="mt-0.5 shrink-0 text-danger" aria-hidden />
							<span className="min-w-0 break-words">
								{t(retry.attempt === 1 ? "chat.retryFailedOne" : "chat.retryFailed", {
									n: retry.attempt,
									error: retry.finalError || t("chat.retryUnknownError"),
								})}
							</span>
						</div>
					) : null}
					{compacting ? (
						<div className="flex items-center gap-2" role="status" data-testid="compaction-line">
							<Spinner size={13} className="text-accent" />
							<span>
								{compacting.action === undefined
									? t("chat.compacting")
									: t("chat.compactingBy", {
											reason:
												compacting.reason && Object.hasOwn(REASONS, compacting.reason)
													? t(REASONS[compacting.reason])
													: "",
											action: t(actionOf(compacting.action).running),
										})}
							</span>
						</div>
					) : null}
				</div>
			) : null}
			{!compacting && compactionOutcome ? <OutcomeRow outcome={compactionOutcome} /> : null}
		</>
	);
}
