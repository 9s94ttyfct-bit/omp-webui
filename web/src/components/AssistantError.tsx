import { ChevronDown, CircleAlert, CircleDashed, Play, RotateCw } from "lucide-react";
import { useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import type { AgentMessage, RetryRecovery } from "../lib/messages.ts";
import { unresolvedStop } from "../lib/retry.ts";
import { Button, cx } from "./ui.tsx";

/**
 * A failure a retry got past is one dim line, folded: omp already got the turn through, so it is no longer news.
 * It unfolds to the error and what omp noted about the recovery.
 */
function RecoveredNote({ message, recovery }: { message: AgentMessage; recovery: RetryRecovery }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const attempts = recovery.attempt ?? 1;
	const details = [message.errorMessage?.trim(), recovery.note?.trim()].filter(
		(line, i, all): line is string => Boolean(line) && all.indexOf(line) === i,
	);
	return (
		<div className="mt-2 text-xs text-faint" data-testid="retry-recovered">
			<button
				type="button"
				aria-expanded={open}
				className="inline-flex items-center gap-1.5 rounded-md hover:text-muted"
				onClick={() => setOpen((o) => !o)}
			>
				<RotateCw size={12} aria-hidden />
				{t(attempts === 1 ? "chat.retryRecoveredOne" : "chat.retryRecovered", { n: attempts })}
				<ChevronDown size={12} className={cx("transition-transform", open && "rotate-180")} aria-hidden />
			</button>
			{open && details.length ? (
				<pre className="mt-1 font-mono text-xs whitespace-pre-wrap text-muted">{details.join("\n")}</pre>
			) : null}
		</div>
	);
}

/**
 * What a failed, interrupted or recovered assistant message ends with. A failure offers Retry (`onRetry`: given
 * for the one failure omp's `/retry` would redo); one that a retry got past is a note; one a later reply made moot
 * shows nothing.
 */
export function AssistantError({ message, onRetry }: { message: AgentMessage; onRetry?: () => void }) {
	const t = useT();
	const recovery = message.retryRecovery;
	if (recovery?.status === "recovered") return <RecoveredNote message={message} recovery={recovery} />;
	const stop = unresolvedStop(message);
	if (!stop) return null;
	return (
		<div
			className="mt-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
			data-testid="assistant-error"
		>
			<CircleAlert size={16} className="mt-0.5 shrink-0" />
			<span className="min-w-0 flex-1">
				{stop === "aborted" ? t("chat.interrupted") : message.errorMessage || t("chat.modelError")}
			</span>
			{onRetry ? (
				<Button size="sm" variant="outline" className="shrink-0" data-testid="retry-button" onClick={onRetry}>
					<RotateCw size={12} /> {t("common.retry")}
				</Button>
			) : null}
		</div>
	);
}

/**
 * What ends a conversation whose tool calls nobody answered: omp was killed while they ran. `/retry` has nothing to redo
 * there, so the way on is a message, which Continue sends.
 */
export function InterruptedCalls({ onContinue }: { onContinue: () => void }) {
	const t = useT();
	return (
		<div
			className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm text-muted"
			data-testid="interrupted-note"
		>
			<CircleDashed size={16} className="shrink-0" aria-hidden />
			<span className="min-w-0 flex-1">{t("chat.toolInterruptedNote")}</span>
			<Button size="sm" variant="outline" className="shrink-0" data-testid="resume-button" onClick={onContinue}>
				<Play size={12} /> {t("chat.toolResume")}
			</Button>
		</div>
	);
}
