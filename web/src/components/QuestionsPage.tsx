import type { Question, QuestionDrop, QuestionDropWhy, QuestionList } from "@shared/unattended.ts";
import { ChevronRight, MessageCircleQuestion } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import { fmtRelative } from "../lib/format.ts";
import { questionsApi } from "../lib/questions-api.ts";
import { useQuestionsStrings } from "../lib/questions-strings.ts";
import { useApp } from "../store/app.ts";
import { sessionLabel } from "./SessionItem.tsx";
import { Badge, Button, cx, Empty, Select, Spinner } from "./ui.tsx";

const TOUCH = "pointer-coarse:min-h-11";
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Every question, read again whenever the server's counts move (`questions`); the newest read wins. */
function useQuestionList(): { data: QuestionList | null; error: string | null; clearError: () => void } {
	const rev = useApp((s) => s.meta?.questions?.rev ?? 0);
	const [data, setData] = useState<QuestionList | null>(null);
	const [error, setError] = useState<string | null>(null);
	const load = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `rev` is the trigger: the counts moved, so the list did
	useEffect(() => {
		const mine = ++load.current;
		questionsApi.list().then(
			(list) => {
				if (mine !== load.current) return;
				setData(list);
				setError(null);
			},
			(e: unknown) => {
				if (mine === load.current) setError(messageOf(e));
			},
		);
	}, [rev]);
	return { data, error, clearError: () => setError(null) };
}

/**
 * The Questions page (#646): what the agents filed while their conversations were unattended, per conversation and across
 * all of them. A question opens to what the agent found and what it did meanwhile, with its options and a box for words; the
 * answer goes to the conversation as a message (queued while it works, waking it when it is idle or closed). The server tells
 * every page the counts on a change (`questions`), and this page reads the list again when they move.
 */
export default function QuestionsPage() {
	const t = useT();
	const ready = useQuestionsStrings();
	const view = useApp((s) => s.view);
	const setView = useApp((s) => s.setView);
	const sessions = useApp((s) => s.sessions);
	const { data, error, clearError } = useQuestionList();
	const [tab, setTab] = useState<"open" | "done">("open");
	const [scope, setScope] = useState<string>(view.kind === "questions" ? (view.file ?? "") : "");
	const [openId, setOpenId] = useState<string | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const titles = useMemo(() => new Map(sessions.map((s) => [s.file, sessionLabel(s)])), [sessions]);
	const shown = useMemo(
		() =>
			(data?.questions ?? []).filter(
				(q) => (tab === "open" ? q.state === "open" : q.state !== "open") && (scope === "" || q.session === scope),
			),
		[data, tab, scope],
	);
	const groups = useMemo(() => {
		const by = new Map<string, Question[]>();
		for (const q of shown) by.set(q.session, [...(by.get(q.session) ?? []), q]);
		return [...by.entries()];
	}, [shown]);
	const drops = useMemo(() => {
		const by = new Map<string, QuestionDrop[]>();
		for (const d of data?.dropped ?? []) by.set(d.session, [...(by.get(d.session) ?? []), d]);
		return by;
	}, [data]);
	const conversations = useMemo(() => [...new Set((data?.questions ?? []).map((q) => q.session))], [data]);
	if (!ready) return null;
	const nameOf = (session: string, q: Question) =>
		titles.get(session) ?? (q.title || q.cwd?.split("/").pop() || t("questions.conversationGone"));
	const open = data?.open ?? 0;
	return (
		<div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden" data-testid="questions-page">
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
					<div>
						<h1 ref={heading} tabIndex={-1} className="flex items-center gap-3 text-xl font-semibold outline-none">
							<MessageCircleQuestion className="shrink-0 text-accent" /> {t("questions.pageTitle")}
						</h1>
						<p className="mt-1 max-w-prose text-xs text-muted">{t("questions.pageIntro")}</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<fieldset className="m-0 flex gap-1 border-0 p-0">
							<legend className="sr-only">{t("questions.pageTitle")}</legend>
							{(["open", "done"] as const).map((v) => (
								<button
									key={v}
									type="button"
									aria-pressed={tab === v}
									data-testid={`questions-tab-${v}`}
									className={cx(
										"rounded-lg px-3 py-1.5 text-sm",
										TOUCH,
										tab === v ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg",
									)}
									onClick={() => setTab(v)}
								>
									{v === "open" ? `${t("questions.tabOpen")} (${open})` : t("questions.tabDone")}
								</button>
							))}
						</fieldset>
						<Select
							tone="compact"
							className="ml-auto w-auto min-w-40 max-w-full"
							aria-label={t("questions.filterLabel")}
							data-testid="questions-scope"
							value={scope}
							onChange={(e) => setScope(e.target.value)}
						>
							<option value="">{t("questions.filterAll")}</option>
							{conversations.map((file) => (
								<option key={file} value={file}>
									{titles.get(file) ?? data?.questions.find((q) => q.session === file)?.title ?? file.split("/").pop()}
								</option>
							))}
						</Select>
					</div>
					<div role="status" className="sr-only">
						{t("questions.openCount", { n: open })}
					</div>
					{error ? (
						<p className="text-sm text-danger" role="alert" data-testid="questions-error">
							{t("questions.loadFailed", { error })}{" "}
							<Button size="sm" onClick={clearError}>
								{t("questions.retry")}
							</Button>
						</p>
					) : null}
					{!data && !error ? (
						<div className="flex justify-center py-10">
							<Spinner />
						</div>
					) : null}
					{data && groups.length === 0 ? (
						<Empty title={tab === "open" ? t("questions.empty") : t("questions.emptyDone")}>
							{tab === "open" ? t("questions.emptyHint") : null}
						</Empty>
					) : null}
					{groups.map(([session, list]) => (
						<section
							key={session}
							aria-label={nameOf(session, list[0])}
							data-testid="questions-group"
							className="space-y-1.5"
						>
							<div className="flex items-center gap-2">
								<h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{nameOf(session, list[0])}</h2>
								<span className="shrink-0 text-xs text-muted">
									{list.length === 1 ? t("questions.countOne") : t("questions.countMany", { n: list.length })}
								</span>
								{titles.has(session) ? (
									<Button
										size="sm"
										variant="ghost"
										className={TOUCH}
										onClick={() => setView({ kind: "chat", file: session, liveId: null })}
									>
										{t("questions.openConversation")}
									</Button>
								) : null}
							</div>
							<ul className="space-y-1.5">
								{list.map((q) => (
									<li key={q.id}>
										<QuestionRow
											q={q}
											expanded={openId === q.id}
											onToggle={() => setOpenId(openId === q.id ? null : q.id)}
											onSettled={() => {
												setOpenId(null);
												heading.current?.focus();
											}}
										/>
									</li>
								))}
							</ul>
							<DroppedLine drops={drops.get(session) ?? []} />
						</section>
					))}
				</div>
			</div>
		</div>
	);
}

/**
 * One conversation's questions, as a tab of its right panel (#693): open and done ones, each opening to its answer form as on
 * the page, and a button to the page of every conversation's.
 */
export function QuestionsTab({ file }: { file: string | null }) {
	const t = useT();
	const ready = useQuestionsStrings();
	const setView = useApp((s) => s.setView);
	const { data, error, clearError } = useQuestionList();
	const [tab, setTab] = useState<"open" | "done">("open");
	const [openId, setOpenId] = useState<string | null>(null);
	const top = useRef<HTMLDivElement>(null);
	const mine = useMemo(() => (data?.questions ?? []).filter((q) => file !== null && q.session === file), [data, file]);
	const shown = mine.filter((q) => (tab === "open" ? q.state === "open" : q.state !== "open"));
	const drops = useMemo(() => (data?.dropped ?? []).filter((d) => d.session === file), [data, file]);
	if (!ready) return null;
	const open = mine.filter((q) => q.state === "open").length;
	return (
		<div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" data-testid="questions-tab" ref={top} tabIndex={-1}>
			<div className="flex flex-wrap items-center gap-1">
				{(["open", "done"] as const).map((v) => (
					<button
						key={v}
						type="button"
						aria-pressed={tab === v}
						data-testid={`questions-tab-${v}`}
						className={cx(
							"rounded-lg px-2.5 py-1 text-sm",
							TOUCH,
							tab === v ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg",
						)}
						onClick={() => setTab(v)}
					>
						{v === "open" ? `${t("questions.tabOpen")} (${open})` : t("questions.tabDone")}
					</button>
				))}
				<Button
					size="sm"
					variant="ghost"
					className={cx("ml-auto", TOUCH)}
					data-testid="questions-open-page"
					onClick={() => setView({ kind: "questions", ...(file ? { file } : {}) })}
				>
					{t("questions.openPage")}
				</Button>
			</div>
			{error ? (
				<p className="text-sm text-danger" role="alert" data-testid="questions-error">
					{t("questions.loadFailed", { error })}{" "}
					<Button size="sm" onClick={clearError}>
						{t("questions.retry")}
					</Button>
				</p>
			) : null}
			{file === null ? (
				<Empty icon={<MessageCircleQuestion size={22} />} title={t("questions.pageTitle")}>
					{t("questions.tabNoConversation")}
				</Empty>
			) : !data && !error ? (
				<div className="flex justify-center py-6">
					<Spinner />
				</div>
			) : data && shown.length === 0 ? (
				<Empty
					icon={<MessageCircleQuestion size={22} />}
					title={tab === "open" ? t("questions.empty") : t("questions.emptyDone")}
				>
					{tab === "open" ? t("questions.emptyHint") : null}
				</Empty>
			) : (
				<ul className="space-y-1.5">
					{shown.map((q) => (
						<li key={q.id}>
							<QuestionRow
								q={q}
								expanded={openId === q.id}
								onToggle={() => setOpenId(openId === q.id ? null : q.id)}
								onSettled={() => {
									setOpenId(null);
									top.current?.focus();
								}}
							/>
						</li>
					))}
				</ul>
			)}
			<DroppedLine drops={drops} />
		</div>
	);
}

function QuestionRow({
	q,
	expanded,
	onToggle,
	onSettled,
}: {
	q: Question;
	expanded: boolean;
	onToggle: () => void;
	onSettled: () => void;
}) {
	const t = useT();
	const panel = useId();
	return (
		<div className="rounded-xl border border-border bg-surface" data-testid="question-row" data-state={q.state}>
			<button
				type="button"
				aria-expanded={expanded}
				aria-controls={panel}
				className={cx("flex w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left hover:bg-hover", TOUCH)}
				onClick={onToggle}
			>
				<ChevronRight
					size={14}
					aria-hidden
					className={cx("mt-1 shrink-0 transition-transform", expanded && "rotate-90")}
				/>
				<span className="min-w-0 flex-1">
					<span className="block break-words text-sm font-medium">{q.question}</span>
					<span className="mt-0.5 block text-xs text-muted">
						{t("questions.asked", { when: fmtRelative(q.askedAt) })} ·{" "}
						{q.source === "ask" ? t("questions.fromAsk") : t("questions.fromTool")}
					</span>
				</span>
				{q.state === "answered" ? <Badge tone="success">{t("questions.stateAnswered")}</Badge> : null}
				{q.state === "dismissed" ? <Badge>{t("questions.stateDismissed")}</Badge> : null}
			</button>
			{expanded ? (
				<div id={panel} className="space-y-3 border-t border-border px-3 py-3">
					{q.context ? (
						<div>
							<h3 className="text-xs font-medium text-muted">{t("questions.contextLabel")}</h3>
							<p className="mt-1 whitespace-pre-wrap break-words text-sm">{q.context}</p>
						</div>
					) : null}
					{q.meanwhile ? (
						<div>
							<h3 className="text-xs font-medium text-muted">{t("questions.meanwhileLabel")}</h3>
							<p className="mt-1 whitespace-pre-wrap break-words text-sm">{q.meanwhile}</p>
						</div>
					) : null}
					{q.state === "open" ? (
						<AnswerForm q={q} onSettled={onSettled} />
					) : q.answer ? (
						<div data-testid="question-answer">
							<h3 className="text-xs font-medium text-muted">{t("questions.yourAnswer")}</h3>
							{q.answer.options.length ? (
								<p className="mt-1 text-sm">
									{t("questions.chosen")}: {q.answer.options.join("; ")}
								</p>
							) : null}
							{q.answer.text ? <p className="mt-1 whitespace-pre-wrap break-words text-sm">{q.answer.text}</p> : null}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * What could not be kept of this conversation (#650): a short line per reason, under its questions, so the person knows some
 * were lost. It is the server's memory (not the questions file), so it says what happened since the server started.
 */
function DroppedLine({ drops }: { drops: QuestionDrop[] }) {
	const t = useT();
	if (drops.length === 0) return null;
	const by = new Map<QuestionDropWhy, number>();
	for (const d of drops) by.set(d.why, (by.get(d.why) ?? 0) + 1);
	return (
		<div className="space-y-0.5 pt-0.5 text-xs text-warning" data-testid="questions-dropped" data-count={drops.length}>
			{[...by.entries()].map(([why, n]) => (
				<p key={why} data-why={why}>
					{t(DROPPED_TEXT[why])}
					{n > 1 ? ` ${t("questions.droppedCount", { n })}` : null}
				</p>
			))}
		</div>
	);
}

/** The line for each reason a question could not be kept (#650). */
const DROPPED_TEXT: Record<QuestionDropWhy, MessageKey> = {
	full: "questions.droppedFull",
	empty: "questions.droppedEmpty",
	unwritable: "questions.droppedUnwritable",
};

function AnswerForm({ q, onSettled }: { q: Question; onSettled: () => void }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const group = useId();
	const field = useId();
	const [chosen, setChosen] = useState<string[]>([]);
	const [text, setText] = useState("");
	const [delivery, setDelivery] = useState<"followUp" | "steer">("followUp");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ready = chosen.length > 0 || text.trim() !== "";
	const pick = (label: string, on: boolean) =>
		setChosen(q.multi ? (on ? [...chosen, label] : chosen.filter((c) => c !== label)) : on ? [label] : []);
	const send = async () => {
		if (!ready || busy) return;
		setBusy(true);
		setError(null);
		try {
			await questionsApi.answer(q.id, { options: chosen, text, delivery });
			toast("success", t("questions.sent"));
			onSettled();
		} catch (e) {
			setError(t("questions.errAnswer", { error: messageOf(e) }));
			setBusy(false);
		}
	};
	const dismiss = async () => {
		setBusy(true);
		try {
			await questionsApi.dismiss(q.id);
			toast("info", t("questions.dismissedToast"));
			onSettled();
		} catch (e) {
			setError(t("questions.errDismiss", { error: messageOf(e) }));
			setBusy(false);
		}
	};
	return (
		<form
			className="space-y-3"
			data-testid="question-form"
			onSubmit={(e) => {
				e.preventDefault();
				void send();
			}}
		>
			{q.options.length ? (
				<fieldset className="space-y-1.5">
					<legend className="text-xs font-medium text-muted">
						{t("questions.optionsLabel")}
						{q.multi ? ` · ${t("questions.multiHint")}` : ""}
					</legend>
					{q.options.map((o, i) => (
						<label
							key={o.label}
							className={cx(
								"flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:border-accent",
								TOUCH,
							)}
						>
							<input
								type={q.multi ? "checkbox" : "radio"}
								name={group}
								className="mt-1"
								checked={chosen.includes(o.label)}
								onChange={(e) => pick(o.label, e.target.checked)}
								data-testid="question-option"
							/>
							<span className="min-w-0">
								<span className="break-words font-medium">{o.label}</span>
								{q.recommended === i ? (
									<span className="ml-2 text-xs text-accent">{t("questions.recommended")}</span>
								) : null}
								{o.description ? <span className="block break-words text-xs text-muted">{o.description}</span> : null}
							</span>
						</label>
					))}
				</fieldset>
			) : (
				<p className="text-xs text-muted">{t("questions.noOptionsHint")}</p>
			)}
			<div>
				<label htmlFor={field} className="text-xs font-medium text-muted">
					{t("questions.textLabel")}
				</label>
				<textarea
					id={field}
					rows={3}
					maxLength={6000}
					value={text}
					placeholder={t("questions.textPlaceholder")}
					data-testid="question-text"
					className="mt-1 w-full resize-y rounded-xl border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint"
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
							e.preventDefault();
							void send();
						}
					}}
				/>
			</div>
			<fieldset className="space-y-1.5" data-testid="question-delivery">
				<legend className="text-xs font-medium text-muted">{t("questions.deliveryLabel")}</legend>
				<div className="flex flex-wrap gap-2">
					{(["followUp", "steer"] as const).map((d) => (
						<label
							key={d}
							className={cx(
								"flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:border-accent",
								delivery === d && "border-accent",
								TOUCH,
							)}
						>
							<input
								type="radio"
								name={`${group}-delivery`}
								value={d}
								checked={delivery === d}
								onChange={() => setDelivery(d)}
								data-testid={`question-delivery-${d}`}
							/>
							{t(d === "steer" ? "questions.deliverySteer" : "questions.deliveryFollowUp")}
						</label>
					))}
				</div>
			</fieldset>
			<p className="text-xs text-muted">{t("questions.answerHint")}</p>
			{error ? (
				<p className="text-sm text-danger" role="alert" data-testid="question-error">
					{error}
				</p>
			) : null}
			<div className="flex justify-end gap-2">
				<Button
					variant="ghost"
					className={TOUCH}
					disabled={busy}
					onClick={() => void dismiss()}
					data-testid="question-dismiss"
				>
					{t("questions.dismiss")}
				</Button>
				<Button
					variant="primary"
					type="submit"
					className={TOUCH}
					disabled={!ready || busy}
					title={ready ? undefined : t("questions.answerNeeded")}
					data-testid="question-answer-send"
				>
					{busy ? <Spinner size={14} /> : null}
					{busy ? t("questions.sending") : t("questions.answer")}
				</Button>
			</div>
		</form>
	);
}
