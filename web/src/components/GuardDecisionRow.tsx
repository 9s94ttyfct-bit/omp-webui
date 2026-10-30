import type { GuardDecision } from "@shared/guard.ts";
import type { SessionSummary } from "@shared/protocol.ts";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { useT } from "../i18n/index.ts";
import { BY_TEXT, CHIP_TEXT, CHIP_TONE, money, secondsOf, tokens, verdictKind } from "../lib/guard-format.ts";
import { RISK_KIND_LABEL } from "../lib/risk-kinds.ts";
import { useApp } from "../store/app.ts";
import { conversationOf } from "../store/guard.ts";
import { cx } from "./ui.tsx";

/**
 * One decision of the guard, as the Guard page lists it: what it was, who decided and why, the conversation it was made in
 * and the exact call behind a button. Everything shown is text: a decision's words come from a reviewer model or from the
 * processes the agent runs in.
 */
export function DecisionRow({ d, session }: { d: GuardDecision; session: SessionSummary | undefined }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const callId = useId();
	const kind = verdictKind(d);
	const reasons = d.kinds.map((k) => (RISK_KIND_LABEL[k] ? t(RISK_KIND_LABEL[k]) : k));
	const conversation = conversationOf(d.file);
	const named = conversation.split("/").pop() || conversation;
	const facts = [
		d.by === "reviewer" && d.model ? t("guard.logReviewer", { model: d.model }) : "",
		d.usage && d.usage.requests > 0
			? `${t("guard.logTokens", { input: tokens(d.usage.input), output: tokens(d.usage.output) })} · ${money(d.usage.cost)}`
			: "",
		d.ms > 0 ? t("guard.seconds", { s: secondsOf(d.ms) }) : "",
	].filter(Boolean);
	return (
		<div
			className="rounded-xl border border-border bg-bg-soft px-3 py-2 text-sm"
			data-testid="guard-log-row"
			data-verdict={d.verdict}
			data-by={d.by}
			data-outcome={kind}
		>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span
					className={cx("rounded-full px-2 py-0.5 text-xs font-medium", CHIP_TONE[kind])}
					data-testid="guard-log-chip"
				>
					{t(CHIP_TEXT[kind])}
				</span>
				<span className="rounded-full bg-hover px-2 py-0.5 text-xs text-muted" data-testid="guard-log-by">
					{t(BY_TEXT[d.by])}
				</span>
				<span className="font-medium">{d.tool}</span>
				<span className="text-xs text-muted" data-testid="guard-log-agent">
					{d.subagent ? d.agent : t("guard.logAgentMain")}
				</span>
				<time className="ml-auto text-xs text-faint" dateTime={new Date(d.at).toISOString()}>
					{new Date(d.at).toLocaleString()}
				</time>
			</div>
			<p className="mt-1 line-clamp-2 whitespace-pre-wrap break-all font-mono text-xs" data-testid="guard-log-command">
				{d.detail}
			</p>
			{conversation !== "" ? (
				session ? (
					<button
						type="button"
						className="mt-1 block max-w-full truncate text-left text-xs text-accent hover:underline"
						data-testid="guard-log-conversation"
						onClick={() => useApp.getState().setView({ kind: "chat", file: session.file, liveId: null })}
					>
						{t("guard.decConversation", { title: session.title || named })}
					</button>
				) : (
					<p className="mt-1 truncate text-xs text-muted" data-testid="guard-log-conversation">
						{t("guard.decConversation", { title: named })}
					</p>
				)
			) : null}
			{reasons.length > 0 ? (
				<p className="mt-1 text-xs text-muted">{t("guard.logKinds", { kinds: reasons.join("; ") })}</p>
			) : null}
			{d.reason ? <p className="mt-1 break-words text-xs">{t("guard.logWhy", { reason: d.reason })}</p> : null}
			{facts.length > 0 ? <p className="mt-1 break-words text-xs text-muted">{facts.join(" · ")}</p> : null}
			{d.tried && d.tried.length > 1 ? (
				<p className="mt-1 break-words text-xs text-muted">{t("guard.logTried", { models: d.tried.join(", ") })}</p>
			) : null}
			<button
				type="button"
				className="mt-1 inline-flex min-h-6 items-center gap-1 text-xs text-accent hover:underline"
				aria-expanded={open}
				aria-controls={callId}
				data-testid="guard-log-call-toggle"
				onClick={() => setOpen((o) => !o)}
			>
				<ChevronRight size={12} className={cx("transition-transform", open && "rotate-90")} aria-hidden />
				{open ? t("guard.logHideCall") : t("guard.logShowCall")}
			</button>
			<div id={callId}>
				{open ? (
					<div className="mt-1 space-y-1">
						{d.intent ? (
							<p className="break-words text-xs text-muted">{t("guard.logIntent", { intent: d.intent })}</p>
						) : null}
						{d.cwd ? <p className="break-all text-xs text-muted">{t("guard.logFolder", { cwd: d.cwd })}</p> : null}
						{/* A region that scrolls is reachable from the keyboard, or its content cannot be read without a mouse. */}
						<section
							// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard to be read (axe: scrollable-region-focusable).
							tabIndex={0}
							aria-label={t("guard.logCallLabel")}
							className="max-h-48 overflow-auto rounded-lg bg-surface p-2"
						>
							<pre className="whitespace-pre-wrap break-all font-mono text-xs" data-testid="guard-log-call">
								{d.detail}
							</pre>
						</section>
					</div>
				) : null}
			</div>
		</div>
	);
}
