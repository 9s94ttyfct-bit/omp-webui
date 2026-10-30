import { type SleepNote, type SleepThen, sleepThenOf } from "@shared/sleep.ts";
import type { QuestionDropNote, QuestionDropWhy } from "@shared/unattended.ts";
import {
	ArrowRightLeft,
	ChevronDown,
	CircleCheck,
	CircleX,
	Clock,
	HelpCircle,
	Info,
	Lightbulb,
	MessagesSquare,
	Moon,
	OctagonAlert,
	ShieldAlert,
	ShieldX,
	TriangleAlert,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useLang, useT } from "../i18n/index.ts";
import { fmtDuration } from "../lib/format.ts";
import {
	type AdvisorNote,
	type CustomNote,
	classifyCustom,
	type DaemonInfo,
	type IrcMode,
	type JobInfo,
	type LiveNotice,
	SEVERITIES,
	type Severity,
} from "../lib/notices.ts";
import { Markdown } from "./Markdown.tsx";
import { Badge, cx } from "./ui.tsx";

/** What followed a conversation the Mac's sleep cut, in the page's words (see `SleepThen`). */
const THEN_KEY: Record<SleepThen, MessageKey> = {
	retried: "chat.noteSleptRetried",
	error: "chat.noteSleptError",
	toolTimeout: "chat.noteSleptToolTimeout",
};

/**
 * A time inside a day, as the issue words it (`14:02`): the hour is 24-hour in both languages, because a sleep is named by
 * two of them close together and `02:02 PM–03:40 PM` reads as twice the room. The zone is the reader's.
 */
const sleepClock = (ts: number): string =>
	new Date(ts).toLocaleTimeString(useLang.getState().lang, {
		hour: "2-digit",
		minute: "2-digit",
		// `hourCycle`, not `hour12`: `hour12: false` lets some locales pick the 12-hour cycle with a `h24`-less pattern,
		// and the issue's own words are `14:02–15:40`.
		hourCycle: "h23",
	});

/** A one-line note that opens to its text: summaries, injected messages, applied rules. */
export function NoteRow({
	icon,
	title,
	text,
	testId,
	live,
}: {
	icon: ReactNode;
	title: string;
	text?: string;
	testId?: string;
	/** Announced while omp works; the saved transcript will have its own row for it. */
	live?: boolean;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div
			className="my-2 rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted"
			data-testid={testId}
			data-live={live || undefined}
		>
			<button
				type="button"
				className="flex w-full items-center gap-2 text-left"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
			>
				{icon}
				<span className="flex-1">{title}</span>
				{text ? <ChevronDown size={14} className={cx("transition-transform", open && "rotate-180")} /> : null}
			</button>
			{open && text ? (
				<div className="mt-2">
					<Markdown text={text} />
				</div>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------- advisor

const SEVERITY_VIEW: Record<
	Severity,
	{
		icon: typeof Info;
		iconClass: string;
		tone: "danger" | "warning" | "default";
		card: string;
		keys: [MessageKey, MessageKey];
	}
> = {
	blocker: {
		icon: OctagonAlert,
		iconClass: "text-danger",
		tone: "danger",
		card: "border-danger/40 bg-danger/10",
		keys: ["chat.advisorBlocker", "chat.advisorBlockers"],
	},
	concern: {
		icon: TriangleAlert,
		iconClass: "text-warning",
		tone: "warning",
		card: "border-warning/40 bg-warning/10",
		keys: ["chat.advisorConcern", "chat.advisorConcerns"],
	},
	nit: {
		icon: Lightbulb,
		iconClass: "text-muted",
		tone: "default",
		card: "border-border bg-bg-soft",
		keys: ["chat.advisorNit", "chat.advisorNits"],
	},
	note: {
		icon: Info,
		iconClass: "text-muted",
		tone: "default",
		card: "border-border bg-bg-soft",
		keys: ["chat.advisorNoteOne", "chat.advisorNoteMany"],
	},
};

/** As many notes as the terminal's card shows before "+N more". */
const SHOWN_NOTES = 3;

/** The advisor's notes, most severe first in the heading; stays on screen when a turn folds its steps. */
export function AdvisorCard({ notes, live }: { notes: AdvisorNote[]; live?: boolean }) {
	const t = useT();
	const [all, setAll] = useState(false);
	const shown = all ? notes : notes.slice(0, SHOWN_NOTES);
	const top = SEVERITIES.find((s) => notes.some((n) => n.severity === s)) ?? "note";
	const Icon = SEVERITY_VIEW[top].icon;
	const sources = [...new Set(notes.map((n) => n.advisor))];
	const several = sources.length > 1;
	return (
		<div
			className={cx("my-2 rounded-xl border px-3 py-2 text-sm", SEVERITY_VIEW[top].card)}
			data-testid="advisor-card"
			data-severity={top}
			data-live={live || undefined}
		>
			<div className="flex flex-wrap items-center gap-2">
				<Icon size={15} className={cx("shrink-0", SEVERITY_VIEW[top].iconClass)} aria-hidden />
				{SEVERITIES.map((s) => {
					const n = notes.filter((x) => x.severity === s).length;
					return n ? (
						<Badge key={s} tone={SEVERITY_VIEW[s].tone}>
							<span data-testid="advisor-badge" data-severity={s}>
								{t(SEVERITY_VIEW[s].keys[n === 1 ? 0 : 1], { n })}
							</span>
						</Badge>
					) : null;
				})}
				<span className="ml-auto text-xs text-faint">{(!several && sources[0]) || t("chat.advisorTitle")}</span>
			</div>
			<ul className="mt-1.5 space-y-1.5">
				{shown.map((n, i) => {
					const View = SEVERITY_VIEW[n.severity];
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: notes are a static list, never reordered
						<li key={i} className="flex items-start gap-2" data-testid="advisor-note" data-severity={n.severity}>
							<View.icon size={14} className={cx("mt-1 shrink-0", View.iconClass)} aria-hidden />
							<div className="min-w-0 flex-1 break-words">
								{several && n.advisor ? <span className="text-xs text-faint">{n.advisor} · </span> : null}
								<Markdown text={n.note} />
							</div>
						</li>
					);
				})}
			</ul>
			{notes.length > SHOWN_NOTES ? (
				<button
					type="button"
					data-testid="advisor-more"
					aria-expanded={all}
					className="mt-0.5 inline-flex min-h-6 items-center text-xs text-accent hover:underline"
					onClick={() => setAll((a) => !a)}
				>
					{all ? t("chat.advisorLess") : t("chat.advisorMore", { n: notes.length - SHOWN_NOTES })}
				</button>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------- rules and fallbacks

/** The rules omp applied: one row, with each rule's own text under it. */
export function RuleNote({ rules, live }: { rules: { name: string; text: string }[]; live?: boolean }) {
	const t = useT();
	const one = rules.length === 1;
	return (
		<NoteRow
			testId="rule-note"
			live={live}
			icon={<ShieldAlert size={14} className="shrink-0 text-warning" />}
			title={
				one
					? t("chat.noteRuleApplied", { name: rules[0].name })
					: t("chat.noteRulesApplied", { n: rules.length, names: rules.map((r) => r.name).join(", ") })
			}
			text={
				one
					? rules[0].text
					: rules
							.filter((r) => r.text)
							.map((r) => `**${r.name}**\n\n${r.text}`)
							.join("\n\n---\n\n")
			}
		/>
	);
}

/** omp moved the conversation to its fallback model. `reason` is why, when it said. */
export function FallbackNote({ title, reason, live }: { title: string; reason?: string; live?: boolean }) {
	return (
		<div
			className="my-2 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
			data-testid="fallback-note"
			data-live={live || undefined}
		>
			<ArrowRightLeft size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
			<div className="min-w-0">
				<div className="font-medium break-words">{title}</div>
				{reason ? (
					<div
						className="mt-0.5 max-h-24 overflow-auto text-xs whitespace-pre-wrap break-words text-muted"
						data-testid="fallback-reason"
					>
						{reason}
					</div>
				) : null}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------- background jobs, supervised processes, IRC

function StatusLine({ ok, children, testId, id }: { ok: boolean; children: ReactNode; testId: string; id?: string }) {
	const Icon = ok ? CircleCheck : CircleX;
	return (
		<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5" data-testid={testId} data-id={id}>
			<Icon size={13} className={cx("shrink-0 self-center", ok ? "text-success" : "text-danger")} aria-hidden />
			{children}
		</div>
	);
}

function JobNote({ jobs, result, live }: { jobs: JobInfo[]; result: string; live?: boolean }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	return (
		<div className="my-1.5 space-y-0.5 px-1 text-xs text-muted" data-testid="job-note" data-live={live || undefined}>
			{jobs.map((j) => (
				<div key={j.id}>
					<StatusLine ok testId="job-line" id={j.id}>
						<span className="font-medium text-success">{t("chat.noteJobDone")}</span>
						{j.type ? <span className="text-faint">[{j.type}]</span> : null}
						<span className="font-mono text-accent">{j.id}</span>
						{j.durationMs !== undefined ? <span className="text-faint">({fmtDuration(j.durationMs)})</span> : null}
						{j.label ? <span className="min-w-0 truncate">{j.label}</span> : null}
					</StatusLine>
					{j.artifactError ? <div className="pl-5 text-warning">{j.artifactError}</div> : null}
				</div>
			))}
			{result ? (
				<div className="pl-5">
					<button
						type="button"
						className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
						aria-expanded={open}
						onClick={() => setOpen((o) => !o)}
					>
						{t("chat.noteJobResult")}
						<ChevronDown size={12} className={cx("transition-transform", open && "rotate-180")} />
					</button>
					{open ? (
						<pre
							className="mt-1 max-h-60 overflow-auto rounded-lg bg-code p-2 font-mono leading-relaxed whitespace-pre-wrap"
							data-testid="job-result"
						>
							{result}
						</pre>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function DaemonNote({ daemons, text, live }: { daemons: DaemonInfo[]; text: string; live?: boolean }) {
	const t = useT();
	return (
		<div className="my-1.5 space-y-0.5 px-1 text-xs text-muted" data-testid="daemon-note" data-live={live || undefined}>
			{daemons.length === 0 ? (
				<StatusLine ok testId="daemon-line">
					<span>{text}</span>
				</StatusLine>
			) : (
				daemons.map((d) => (
					<StatusLine key={d.name} ok={!d.failed} testId="daemon-line" id={d.name}>
						<span className={cx("font-medium", d.failed ? "text-danger" : "text-success")}>
							{t(d.failed ? "chat.noteDaemonFailed" : "chat.noteDaemonDone")}
						</span>
						<span className="font-mono text-accent">{d.name}</span>
						{d.exitCode !== undefined ? (
							<span className="text-faint">({t("chat.noteDaemonExit", { code: d.exitCode })})</span>
						) : null}
						{d.durationMs !== undefined ? <span className="text-faint">({fmtDuration(d.durationMs)})</span> : null}
					</StatusLine>
				))
			)}
		</div>
	);
}

const IRC_TITLES: Record<IrcMode, MessageKey> = {
	incoming: "chat.noteIrcIncoming",
	relay: "chat.noteIrcRelay",
	autoreply: "chat.noteIrcAutoreply",
	workpool: "chat.noteIrcPool",
};

function IrcCard({ note, live }: { note: Extract<CustomNote, { kind: "irc" }>; live?: boolean }) {
	const t = useT();
	const unknown = t("chat.noteIrcUnknown");
	return (
		<div
			className="my-2 rounded-xl border border-border bg-bg-soft px-3 py-2 text-sm"
			data-testid="irc-card"
			data-mode={note.mode}
			data-live={live || undefined}
		>
			<div className="flex items-center gap-2 text-xs text-muted">
				<MessagesSquare size={14} className="shrink-0" aria-hidden />
				<span className="font-medium text-fg">
					{t(IRC_TITLES[note.mode], { from: note.from ?? unknown, to: note.to ?? unknown, pool: note.pool ?? unknown })}
				</span>
				{note.reply ? <Badge>{t("chat.noteIrcReply")}</Badge> : null}
			</div>
			{note.body ? (
				<div className="mt-1.5 max-h-60 overflow-auto break-words">
					<Markdown text={note.body} />
				</div>
			) : null}
		</div>
	);
}

/** A custom message omp has a card for (see `classifyCustom`). */
export function TypedNote({ note, live }: { note: CustomNote; live?: boolean }) {
	switch (note.kind) {
		case "advisor":
			return <AdvisorCard notes={note.notes} live={live} />;
		case "jobs":
			return <JobNote jobs={note.jobs} result={note.result} live={live} />;
		case "daemons":
			return <DaemonNote daemons={note.daemons} text={note.text} live={live} />;
		case "irc":
			return <IrcCard note={note} live={live} />;
	}
}

/**
 * The Mac slept while this conversation worked (#647): the line the process carries (`LiveInfo.slept`), with what came of
 * the turn under it once omp said so. Nothing was resent on the person's behalf, so a conversation that came back cleanly
 * has the line of the sleep alone.
 */
export function SleptNote({ note }: { note: SleepNote }) {
	const t = useT();
	// Only the three answers the page knows are drawn, whatever a newer server sends.
	const followed = sleepThenOf(note.followed);
	return (
		<div
			className="my-2 flex items-start gap-2 rounded-xl border border-border bg-bg-soft px-3 py-2 text-sm"
			data-testid="slept-note"
			data-then={followed ?? ""}
		>
			<Moon size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
			<div className="min-w-0">
				<div className="break-words" data-testid="slept-note-title">
					{t("chat.noteSlept", { from: sleepClock(note.from), to: sleepClock(note.to) })}
				</div>
				{followed ? (
					<div className="mt-0.5 text-xs text-muted" data-testid="slept-note-then">
						{t(THEN_KEY[followed])}
					</div>
				) : null}
			</div>
		</div>
	);
}

/**
 * Unattended mode could not keep the question this conversation filed (#650): `LiveInfo.questionDropped`, so a page that
 * attaches after it — or that was not listening when it happened — shows it too. The model was told it was recorded all the
 * same (it must not wait), so this row is the only word of it the person gets. It says what was asked, and why it was not kept.
 */
export function QuestionDroppedNote({ note }: { note: QuestionDropNote }) {
	const t = useT();
	return (
		<div
			className="my-2 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
			data-testid="question-dropped-note"
			data-why={note.why}
		>
			<HelpCircle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
			<div className="min-w-0">
				<div className="font-medium break-words">{t(DROPPED_TITLE[note.why])}</div>
				{note.question ? (
					<div className="mt-0.5 break-words text-xs text-muted" data-testid="question-dropped-question">
						{t("chat.noteQuestionDroppedWhat", { question: note.question })}
					</div>
				) : null}
				<div className="mt-0.5 text-xs text-muted">{t(DROPPED_WHY[note.why])}</div>
			</div>
		</div>
	);
}

/** A question unattended mode could not keep (#650): the line, and why it was not kept. */
export const DROPPED_TITLE: Record<QuestionDropWhy, MessageKey> = {
	full: "chat.noteQuestionDroppedFull",
	empty: "chat.noteQuestionDroppedEmpty",
	unwritable: "chat.noteQuestionDroppedUnwritable",
};

export const DROPPED_WHY: Record<QuestionDropWhy, MessageKey> = {
	full: "chat.noteQuestionDroppedFullWhy",
	empty: "chat.noteQuestionDroppedEmptyWhy",
	unwritable: "chat.noteQuestionDroppedUnwritableWhy",
};

/** What omp announced while it worked, as the row it is. */
export function LiveNoticeRow({ notice }: { notice: LiveNotice }) {
	const t = useT();
	switch (notice.kind) {
		case "rules":
			return <RuleNote rules={notice.rules} live />;
		case "fallback":
			return (
				<FallbackNote
					live
					title={
						notice.from
							? t("chat.noteFallbackLive", { from: notice.from, to: notice.to })
							: t("chat.noteFallbackSaved", { model: notice.to })
					}
					reason={notice.reason}
				/>
			);
		case "fallbackDone":
			return (
				<div className="my-1 flex items-center gap-2 px-1 text-xs text-muted" data-testid="fallback-ok" data-live>
					<CircleCheck size={13} className="shrink-0 text-success" aria-hidden />
					{t("chat.noteFallbackDone", { model: notice.model })}
				</div>
			);
		case "dialogTimeout":
			return (
				<div
					className="my-2 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
					data-testid="dialog-timeout-note"
					data-live
				>
					<Clock size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
					<div className="min-w-0">
						<div className="font-medium break-words">
							{notice.title
								? t("chat.noteDialogTimeout", { title: notice.title })
								: t("chat.noteDialogTimeoutUntitled")}
						</div>
						{notice.chosen.length ? (
							<div className="mt-0.5 text-xs text-muted" data-testid="dialog-timeout-chosen">
								<div>{t("chat.noteDialogTimeoutChose")}</div>
								{notice.chosen.map((c) => (
									<div key={c.question} className="break-words">
										{t("chat.noteDialogTimeoutAnswer", c)}
									</div>
								))}
							</div>
						) : (
							<div className="mt-0.5 text-xs text-muted">{t("chat.noteDialogTimeoutNone")}</div>
						)}
					</div>
				</div>
			);
		case "approvalDenied":
			return (
				<div
					className="my-1 flex items-center gap-2 px-1 text-xs text-muted"
					data-testid="approval-denied-note"
					data-live
				>
					<ShieldX size={13} className="shrink-0 text-warning" aria-hidden />
					{t("chat.noteApprovalDenied", { tools: notice.tools.join(", ") })}
				</div>
			);
		case "irc": {
			const note = classifyCustom(notice.message.customType, notice.message.details, notice.message.content);
			return note ? <TypedNote note={note} live /> : null;
		}
		case "command":
			return (
				<pre
					className="rounded-xl border border-border bg-bg-soft p-3 font-mono text-xs whitespace-pre-wrap"
					data-testid="command-output"
				>
					{notice.text}
				</pre>
			);
	}
}
