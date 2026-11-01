import type { LiveInfo } from "@shared/protocol.ts";
import type { RestartMessage, RestartRefusal } from "@shared/restart.ts";
import { ChevronDown, RotateCcw, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { cx, IconButton } from "./ui.tsx";

/**
 * What the conversation shows of `restart_session` (`shared/restart.ts`): the agent ended its own omp, and the conversation
 * went on in a fresh process.
 */

/** Why a restart was refused, in the page's words. */
const REFUSAL_KEY: Record<RestartRefusal, MessageKey> = {
	asking: "chat.restartRefusedAsking",
	paused: "chat.restartRefusedPaused",
	subagents: "chat.restartRefusedSubagents",
	subagentsUnknown: "chat.restartRefusedSubagentsUnknown",
	rateLimit: "chat.restartRefusedRateLimit",
	noSession: "chat.restartRefusedNoSession",
};

/**
 * The message the server sent the conversation about a restart, drawn as the divider it stands for: where the old process
 * ended and the new one began ("Restarted by the agent: <reason>"), with what the agent asked to do next behind a
 * disclosure; or the refusal, which the agent was told. It is a user message in the session file (the server finds the
 * request's id there), so the divider is where it happened, on every page and after a reload.
 */
export function RestartDivider({ restart, entryId }: { restart: RestartMessage; entryId?: string }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const id = useId();
	const restarted = restart.kind === "restarted";
	const title = restarted
		? t("chat.restartedByAgent", { reason: restart.reason })
		: t("chat.restartRefused", { why: t(REFUSAL_KEY[restart.why]) });
	const details = restarted ? restart.continueWith : "";
	return (
		<div
			className="flex flex-col gap-1.5 fade-in"
			data-testid="restart-divider"
			data-kind={restart.kind}
			data-entry-id={entryId}
		>
			<div className="flex items-center gap-3 text-xs text-muted">
				<span className="h-px flex-1 bg-border" aria-hidden />
				<span className={cx("inline-flex min-w-0 items-center gap-1.5", !restarted && "text-warning")}>
					{restarted ? (
						<RotateCcw size={13} className="shrink-0" aria-hidden />
					) : (
						<TriangleAlert size={13} className="shrink-0" aria-hidden />
					)}
					<span className="break-words" data-testid="restart-divider-title">
						{title}
					</span>
					{details ? (
						<IconButton
							label={t("chat.restartContinueWith")}
							size="xs"
							aria-expanded={open}
							aria-controls={id}
							data-testid="restart-divider-toggle"
							onClick={() => setOpen(!open)}
						>
							<ChevronDown size={13} className={cx("transition-transform", open && "rotate-180")} />
						</IconButton>
					) : null}
				</span>
				<span className="h-px flex-1 bg-border" aria-hidden />
			</div>
			{details ? (
				<div
					id={id}
					hidden={!open}
					className="mx-auto max-w-[85%] rounded-lg bg-bg-soft px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words text-muted"
					data-testid="restart-divider-details"
				>
					<div className="mb-1 font-medium text-fg">{t("chat.restartContinueWith")}</div>
					{details}
				</div>
			) : null}
		</div>
	);
}

/**
 * What the process says of a restart at the end of the conversation: the person's Force restart (until the first turn of the
 * new process), a refusal the agent is told when the paused conversation runs again, and a restart that could not be made.
 * A restart that waits for the turn to end is said above the message box (`RetryStatus`).
 */
export function RestartNote({ info }: { info: LiveInfo }) {
	const t = useT();
	const lines: { key: string; text: string; warn: boolean }[] = [];
	if (info.restarted) lines.push({ key: "restarted", text: t("chat.restartedByYou"), warn: false });
	if (info.restartRefused)
		lines.push({
			key: "refused",
			text: t("chat.restartRefusedWhilePaused", { reason: info.restartRefused.reason }),
			warn: true,
		});
	if (info.restartFailed)
		lines.push({ key: "failed", text: t("chat.restartFailed", { message: info.restartFailed.message }), warn: true });
	if (!lines.length) return null;
	return (
		<>
			{lines.map((line) => (
				<div
					key={line.key}
					className={cx(
						"my-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-sm",
						line.warn ? "border-warning/40 bg-warning/10" : "border-border bg-bg-soft",
					)}
					data-testid="restart-note"
					data-kind={line.key}
				>
					{line.warn ? (
						<TriangleAlert size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
					) : (
						<RotateCcw size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
					)}
					<div className="min-w-0 break-words">{line.text}</div>
				</div>
			))}
		</>
	);
}
