import { parseRiskTitle, RISK_ALLOW, RISK_DENY, riskCommand } from "@shared/risk-confirm.ts";
import { MessageCircleQuestion, ShieldQuestion, Target } from "lucide-react";
import {
	type KeyboardEvent,
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useT } from "../i18n/index.ts";
import { useImeGuard } from "../lib/ime.ts";
import { revealed } from "../lib/invisible.ts";
import { useNow } from "../lib/now.ts";
import { RISK_KIND_LABEL } from "../lib/risk-kinds.ts";
import { resetShellScroll } from "../lib/shell-scroll.ts";
import { fmtCountdown } from "../lib/usage-limit.ts";
import { answerDialog as respond } from "../store/app.ts";
import { type AskQuestion, isApproval, type LiveState, type UIRequest } from "../store/live.ts";
import { Revealed } from "./Revealed.tsx";
import { Badge, Button, cx } from "./ui.tsx";

// UIRequests renders on the new-chat page, which is in the initial chunk; markdown loads on demand.
const Markdown = lazy(() => import("./Markdown.tsx").then((m) => ({ default: m.Markdown })));
// The goal omp proposes: only asked for when omp sends one, so its form is a chunk of its own.
const ProposalBody = lazy(() => import("./GuidedGoal.tsx").then((m) => ({ default: m.ProposalBody })));

/**
 * A finger needs 44 px to hit (Apple's guideline; WCAG 2.2 asks 24 at least): the choices of a request are that tall on a
 * touch screen, where taps that land beside one are taps on nothing or on the next choice.
 */
const TOUCH = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";

/** A text field, other than a button-like input: what the user may be typing into. */
function isTextEntry(el: Element): boolean {
	if (el instanceof HTMLTextAreaElement) return true;
	if (el instanceof HTMLInputElement)
		return ["", "text", "search", "email", "url", "tel", "password", "number"].includes(el.type);
	return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * Whether a request that just appeared may take focus from where it is. It may from the page itself, a button, a link
 * or an empty field (the composer before anything is typed); it may not from text the user has typed, nor from a
 * dialog they are in, which would pull the keyboard out from under them.
 */
function mayTakeFocus(card: HTMLElement): boolean {
	const el = document.activeElement;
	if (!el || el === document.body || el === document.documentElement || card.contains(el)) return true;
	if (el.closest('[role="dialog"], [role="alertdialog"]')) return false;
	if (isTextEntry(el))
		return ((el as HTMLInputElement | HTMLTextAreaElement).value ?? el.textContent ?? "").trim() === "";
	return true;
}

/**
 * What an approval is about (the command, the file, the code), all of it: the person decides on what they read here.
 * It is as tall as is useful and scrolls past that, with a bar that is always drawn (`.approval-scroll`: the system's own
 * hides until the box is scrolled) and a line under it for as long as there is more below. Characters that do not show
 * are written out (see `lib/invisible.ts`).
 */
function ApprovalDetails({ text }: { text: string }) {
	const t = useT();
	const box = useRef<HTMLPreElement>(null);
	// Whether the content is taller than the box, and whether any of it is below what shows.
	const [scrolls, setScrolls] = useState(false);
	const [more, setMore] = useState(false);
	const measure = useCallback(() => {
		const el = box.current;
		if (!el) return;
		setScrolls(el.scrollHeight > el.clientHeight);
		setMore(el.scrollHeight - el.clientHeight - el.scrollTop > 2);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new text is a new thing to measure
	useLayoutEffect(() => {
		measure();
		const el = box.current;
		if (!el) return;
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [text, measure]);
	return (
		<section className="mb-3 [[data-short]_&]:mb-2" aria-label={t("panel.reqDetails")}>
			<pre
				ref={box}
				// A box that scrolls is reached and scrolled from the keyboard; one that does not is no stop on the way to the choices.
				tabIndex={scrolls ? 0 : undefined}
				onScroll={measure}
				// In a short window the choices come first: what is asked about is read in a box of four or so lines.
				className="approval-scroll max-h-[min(20rem,45vh)] overflow-auto rounded-lg bg-bg-soft px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap [[data-short]_&]:max-h-20"
				data-testid="approval-details"
			>
				<Revealed text={text} />
			</pre>
			{more ? (
				<p className="mt-1 text-xs font-medium text-warning" data-testid="approval-more">
					{t("panel.reqMoreBelow")}
				</p>
			) : null}
		</section>
	);
}

/** Pending extension/tool dialogs (omp rpc.md "Extension UI Sub-Protocol"), rendered inline. */
export function UIRequests({ live }: { live: LiveState }) {
	const t = useT();
	const req = live.uiRequests[0];
	const card = useRef<HTMLDivElement>(null);
	/**
	 * A field of the request has had the keyboard: a short window gives it the room (`data-typing`, see index.css), until
	 * the request is answered. Not only while it has focus: a tap on a button takes focus off the field first, and the
	 * message box coming back then would move the button from under the finger.
	 */
	const [typing, setTyping] = useState(false);
	/** Where the keyboard was when the request took it, to give it back once the requests are settled. */
	const returnTo = useRef<HTMLElement | null>(null);
	const titleId = useId();
	const id = req?.id;
	// biome-ignore lint/correctness/useExhaustiveDependencies: another request is another field
	useEffect(() => setTyping(false), [id]);
	/** A request has been on the screen since the last time none was. */
	const shown = useRef(false);
	useEffect(() => {
		const el = card.current;
		if (id === undefined || !el) {
			// Settled: focus that fell to the page with the card goes back to where the user was. Without scrolling: the
			// transcript and the page are where the person left them.
			const back = returnTo.current;
			returnTo.current = null;
			if (back?.isConnected && (!document.activeElement || document.activeElement === document.body))
				back.focus({ preventScroll: true });
			// What a request moved (a focused field, a card taller than the window) is put back: the frame of the app has
			// no scroll bar to bring it back with.
			if (shown.current) resetShellScroll();
			shown.current = false;
			return;
		}
		shown.current = true;
		// Each new request is something omp waits on: the keyboard goes to it, unless that would cost the user what they typed.
		if (!mayTakeFocus(el)) return;
		const was = document.activeElement;
		if (!returnTo.current && was instanceof HTMLElement && was !== document.body && !el.contains(was))
			returnTo.current = was;
		// The card is where it is: taking the keyboard must not scroll the page or the block to it.
		el.focus({ preventScroll: true });
	}, [id]);
	const liveId = live.info.liveId;
	const approval = req ? isApproval(req) : false;
	// The gate's confirmation of a risky call has its own words (see `shared/risk-confirm.ts`).
	const risk = req ? parseRiskTitle(req.title) : null;
	// An approval's title is several lines: the tool first, then the command or path it is about.
	const [head, ...rest] = (req?.title ?? "").split("\n");
	// A shell command's labels are the gate's English: the page says them in its own words (#785).
	const shell = risk ? riskCommand(risk.detail.trim()) : null;
	const details = shell
		? t("panel.reqRiskCommand", { command: shell.command }) +
			(shell.cwd === undefined ? "" : `\n${t("panel.reqRiskIn", { cwd: shell.cwd })}`)
		: risk
			? risk.detail.trim()
			: rest.join("\n").trim();
	// What asks, named once (#785): the remote-access setting, or the guard. The guard's question after a reviewer's
	// denial, or when none could be reached, says why in its own block below; a title that does not say gets no note.
	const riskNote =
		risk?.by === "remote"
			? t("panel.reqRiskNote")
			: risk?.by === "guard" && !risk.denied && !risk.unavailable
				? t("panel.reqRiskNoteGuard")
				: null;
	const title = !req
		? ""
		: req.method === "propose_goal"
			? t("panel.proposalTitle")
			: risk
				? t("panel.reqRiskTitle", { tool: risk.tool })
				: approval
					? head
					: (req.title ?? (req.method === "ask" ? t("panel.reqHasQuestion") : t("panel.reqInputRequested")));
	// Always in the page, so that a request added to it is announced the moment it arrives, whatever has the focus.
	const announcement = (
		<div className="sr-only" role="alert" aria-live="assertive" data-testid="ui-request-announcement" data-keep>
			{req ? <p key={req.id}>{t("panel.reqAnnounce", { title: revealed(title) })}</p> : null}
		</div>
	);
	if (!req) return announcement;
	const Icon = req.method === "propose_goal" ? Target : approval ? ShieldQuestion : MessageCircleQuestion;
	return (
		<>
			{announcement}
			<div
				ref={card}
				tabIndex={-1}
				// A tool approval can be taller than the window leaves it (the chat's bottom block gives way to it, see `ChatView`):
				// it scrolls inside itself, so that its choices are reachable. In a short window with no keyboard (a phone on its
				// side) it is the message box that gives way instead, and the block scrolls: the choices are what is on the screen.
				className="mb-3 overflow-y-auto overscroll-contain rounded-2xl border border-accent/40 bg-surface p-(--pad) shadow-lg [--pad:1rem] fade-in [[data-short]:not([data-keyboard])_&]:shrink-0 [[data-short]_&]:mb-2 [[data-short]_&]:[--pad:0.75rem] [[data-short]_&]:data-typing:mb-0 [[data-short]_&]:data-typing:[--pad:0.5rem]"
				data-keep
				data-typing={typing || undefined}
				onFocus={(e) => {
					if (isTextEntry(e.target)) setTyping(true);
				}}
				role="dialog"
				aria-labelledby={titleId}
				data-testid="ui-request"
				data-method={req.method}
				data-approval={approval || undefined}
			>
				<div className="mb-2 flex items-center gap-2 text-sm font-semibold [[data-short]_&]:mb-1">
					<Icon size={16} className="shrink-0 text-accent" />
					<span id={titleId} className="min-w-0 break-words">
						<Revealed text={title} />
					</span>
					{live.uiRequests.length > 1 ? (
						<span className="ml-auto text-xs font-normal text-faint">
							{t("panel.reqMore", { n: live.uiRequests.length - 1 })}
						</span>
					) : null}
				</div>
				{risk ? (
					<>
						{riskNote ? (
							<p className="mb-2 text-xs text-muted [[data-short]_&]:hidden" data-testid="risk-note">
								{riskNote}
							</p>
						) : null}
						{risk.kinds.length > 0 ? (
							<p className="mb-2 text-xs font-medium text-warning" data-testid="risk-why">
								{t("panel.reqRiskWhy", { why: risk.kinds.map((k) => t(RISK_KIND_LABEL[k])).join("; ") })}
							</p>
						) : null}
						{risk.denied ? (
							// The reviewer's denial the person may overrule (#747): apart from the command, in the page's words; the
							// reason is the reviewer's own.
							<div className="mb-2 rounded-lg border border-warning/40 px-3 py-2 text-xs" data-testid="risk-denied">
								<p className="font-medium text-warning">{t("panel.reqRiskDenied", { model: risk.denied.model })}</p>
								<p className="mt-1 break-words text-fg" data-testid="risk-denied-reason">
									{risk.denied.reason
										? t("panel.reqRiskDeniedReason", { reason: risk.denied.reason })
										: t("panel.reqRiskDeniedNoReason")}
								</p>
							</div>
						) : null}
						{risk.unavailable ? (
							// No reviewer could be reached, so the person is asked instead (#764): apart from the command, in the page's
							// words; what went wrong is the guard's own.
							<div
								className="mb-2 rounded-lg border border-warning/40 px-3 py-2 text-xs"
								data-testid="risk-unavailable"
							>
								<p className="font-medium text-warning">{t("panel.reqRiskUnavailable")}</p>
								<p className="mt-1 break-words text-fg" data-testid="risk-unavailable-reason">
									{risk.unavailable.reason
										? t("panel.reqRiskUnavailableReason", { reason: risk.unavailable.reason })
										: t("panel.reqRiskUnavailableNoReason")}
								</p>
							</div>
						) : null}
					</>
				) : null}
				{approval && details ? <ApprovalDetails text={details} /> : null}
				{approval ? (
					// The message box says the same in its placeholder, and a short window has no room for both.
					<p className="mb-3 text-xs text-muted [[data-short]_&]:hidden" data-testid="approval-deny-hint">
						{t("panel.reqDenyOnSend")}
					</p>
				) : null}
				{req.message ? (
					<div className="mb-3 text-sm text-muted">
						<Suspense fallback={<p className="whitespace-pre-wrap">{req.message}</p>}>
							<Markdown text={req.message} />
						</Suspense>
					</div>
				) : null}
				{/* No key of its own: `Body` below has one, and two siblings with the same key make React render one of them twice. */}
				<Countdown req={req} approval={approval} />
				<Body key={req.id} req={req} liveId={liveId} />
			</div>
		</>
	);
}

/**
 * How long omp still waits for the answer to a dialog that has a deadline (`ask.timeout`, an extension's `timeout`): when
 * it passes, omp answers by itself. Not a live region: the ticking would be read out every second; the request itself was
 * announced when it came.
 */
function Countdown({ req, approval }: { req: UIRequest; approval: boolean }) {
	const t = useT();
	const now = useNow(req.deadline === undefined ? null : 250);
	if (req.deadline === undefined) return null;
	const key =
		req.method === "ask" ? "panel.reqCountdownAsk" : approval ? "panel.reqCountdownApproval" : "panel.reqCountdown";
	return (
		<p className="mb-3 text-xs text-muted tabular-nums" data-testid="ui-request-countdown">
			{t(key, { time: fmtCountdown(req.deadline - now) })}
		</p>
	);
}

function Body({ req, liveId }: { req: UIRequest; liveId: string }) {
	const t = useT();
	const cancel = () => respond(liveId, { id: req.id, cancelled: true });
	// The gate's confirmation has two answers that are values of the dialog: they are shown in the page's language.
	const risky = req.method === "select" && parseRiskTitle(req.title) !== null;
	const labelOf = (option: string): string =>
		risky && option === RISK_ALLOW
			? t("panel.reqRiskAllow")
			: risky && option === RISK_DENY
				? t("panel.reqRiskDeny")
				: option;
	switch (req.method) {
		case "confirm":
			return (
				<div className="flex justify-end gap-2">
					<Button variant="ghost" className={TOUCH} onClick={() => respond(liveId, { id: req.id, confirmed: false })}>
						{t("panel.reqDeny")}
					</Button>
					<Button variant="primary" className={TOUCH} onClick={() => respond(liveId, { id: req.id, confirmed: true })}>
						{t("panel.reqAllow")}
					</Button>
				</div>
			);
		case "select":
			return (
				// Side by side where the window is short and wide enough (a phone or a tablet on its side): one row, two at most.
				<div className="flex flex-col gap-1.5 [[data-short]_&]:grid [[data-short]_&]:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]">
					{(req.options ?? []).map((o, i) => (
						<button
							type="button"
							key={o}
							className={cx(
								"rounded-xl border border-border px-3 py-2 text-left text-sm",
								TOUCH,
								isApproval(req) && /^deny/i.test(o)
									? "text-danger hover:border-danger hover:bg-danger/10"
									: "hover:border-accent hover:bg-accent-soft",
							)}
							onClick={() => respond(liveId, { id: req.id, value: o })}
						>
							<div className="font-medium break-words">{labelOf(o)}</div>
							{req.optionDetails?.[i]?.description ? (
								<div className="text-xs text-muted break-words">{req.optionDetails[i].description}</div>
							) : null}
						</button>
					))}
					<div className="flex justify-end">
						<Button variant="ghost" size="sm" className={TOUCH} onClick={cancel}>
							{t("common.cancel")}
						</Button>
					</div>
				</div>
			);
		case "input":
		case "editor":
			return <TextBody req={req} liveId={liveId} multiline={req.method === "editor"} onCancel={cancel} />;
		case "ask":
			return <AskBody req={req} liveId={liveId} onCancel={cancel} />;
		case "propose_goal":
			return (
				<Suspense fallback={null}>
					<ProposalBody req={req} liveId={liveId} />
				</Suspense>
			);
		default:
			return null;
	}
}

function TextBody({
	req,
	liveId,
	multiline,
	onCancel,
}: {
	req: UIRequest;
	liveId: string;
	multiline: boolean;
	onCancel: () => void;
}) {
	const t = useT();
	const [value, setValue] = useState(String(req.prefill ?? req.text ?? ""));
	const cls = "w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint";
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				respond(liveId, { id: req.id, value });
			}}
		>
			{multiline ? (
				<textarea
					aria-label={t("panel.reqResponse")}
					className={cx(cls, "min-h-28 font-mono [[data-short]_&]:min-h-16")}
					value={value}
					placeholder={req.placeholder}
					onChange={(e) => setValue(e.target.value)}
				/>
			) : (
				<input
					aria-label={t("panel.reqResponse")}
					className={cls}
					value={value}
					placeholder={req.placeholder}
					onChange={(e) => setValue(e.target.value)}
				/>
			)}
			<div className="mt-2 flex justify-end gap-2 [[data-short]_&]:mt-1">
				<Button variant="ghost" className={TOUCH} onClick={onCancel}>
					{t("common.cancel")}
				</Button>
				<Button variant="primary" className={TOUCH} type="submit">
					{t("panel.reqSubmit")}
				</Button>
			</div>
		</form>
	);
}

interface Answer {
	selected: string[];
	custom: string;
}

/** What an answer says in one line: the choices, then the words typed in Other; `undefined` when there is nothing. */
function answerText(a: Answer): string | undefined {
	const parts = [...a.selected];
	const custom = a.custom.trim();
	if (custom) parts.push(custom);
	return parts.length > 0 ? parts.join(", ") : undefined;
}

/** What a field of a question hands the step: Enter on a choice or in Other moves on. */
interface StepKeys {
	onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
	onCompositionEnd: (e: { timeStamp: number }) => void;
}

/**
 * One question: its choices (a radio for one answer, a checkbox for several), each with its description, and a field for
 * an answer of the person's own. `of` is the question's place among several (a screen reader hears it first), `keys` is
 * what moves a stepper on; a lone question has neither.
 */
function QuestionFields({
	name,
	q,
	answer,
	onChange,
	of,
	keys,
}: {
	name: string;
	q: AskQuestion;
	answer: Answer;
	onChange: (fn: (a: Answer) => Answer) => void;
	of?: string;
	keys?: StepKeys;
}) {
	const t = useT();
	return (
		<fieldset className="space-y-1.5">
			<legend className="mb-1 text-sm font-medium">
				{of ? <span className="sr-only">{of}: </span> : null}
				{q.header ? <span className="mr-2 rounded bg-hover px-1.5 py-0.5 text-xs text-muted">{q.header}</span> : null}
				{q.question}
			</legend>
			{q.options.map((o, i) => {
				const on = answer.selected.includes(o.label);
				return (
					<label
						key={o.label}
						className={cx(
							"flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-sm",
							on ? "border-accent bg-accent-soft" : "border-border hover:bg-hover",
						)}
					>
						<input
							type={q.multi ? "checkbox" : "radio"}
							name={name}
							className="mt-1 accent-[var(--accent)]"
							checked={on}
							onKeyDown={keys?.onKeyDown}
							onChange={() =>
								onChange((a) => ({
									custom: q.multi ? a.custom : "",
									selected: q.multi
										? on
											? a.selected.filter((s) => s !== o.label)
											: [...a.selected, o.label]
										: [o.label],
								}))
							}
						/>
						<span>
							<span className="font-medium">{o.label}</span>
							{q.recommended === i ? (
								<Badge tone="accent" className="ml-2 align-middle">
									{t("panel.reqRecommended")}
								</Badge>
							) : null}
							{o.description ? <span className="block text-xs text-muted">{o.description}</span> : null}
						</span>
					</label>
				);
			})}
			<input
				aria-label={t("panel.reqOtherAria", { question: q.question })}
				placeholder={t("panel.reqOther")}
				className="w-full rounded-lg border border-border bg-bg-soft px-3 py-1.5 text-sm outline-none focus:border-faint"
				value={answer.custom}
				onKeyDown={keys?.onKeyDown}
				onCompositionEnd={keys?.onCompositionEnd}
				onChange={(e) =>
					onChange((a) => ({
						selected: q.multi ? a.selected : e.target.value ? [] : a.selected,
						custom: e.target.value,
					}))
				}
			/>
		</fieldset>
	);
}

/**
 * The questions of an `ask`. One question is shown whole; several are asked one at a time: the place among them (`1 / 3`),
 * the question, Back and Next, and on the last one Submit over a short review of every answer. Enter on a choice or in
 * Other moves on (on the last step it only reaches Submit: sending is a decision of its own). Nothing is sent before Submit.
 */
function AskBody({ req, liveId, onCancel }: { req: UIRequest; liveId: string; onCancel: () => void }) {
	const t = useT();
	const questions: AskQuestion[] = req.questions ?? [];
	const [answers, setAnswers] = useState<Answer[]>(() =>
		questions.map((q) => ({
			selected: q.recommended !== undefined && q.options[q.recommended] ? [q.options[q.recommended].label] : [],
			custom: "",
		})),
	);
	const [at, setAt] = useState(0);
	const body = useRef<HTMLDivElement>(null);
	/** The person moved the step: the new question takes the keyboard (the first render does not). */
	const moved = useRef(false);
	const ime = useImeGuard();
	const reviewId = useId();
	const listId = useId();
	const update = (i: number, fn: (a: Answer) => Answer) =>
		setAnswers((cur) => cur.map((a, j) => (j === i ? fn(a) : a)));
	const submit = () =>
		respond(liveId, {
			id: req.id,
			answers: questions.map((q, i) => ({
				id: q.id,
				selectedOptions: answers[i].selected,
				...(answers[i].custom.trim() ? { customInput: answers[i].custom.trim() } : {}),
			})),
		});
	const total = questions.length;
	const stepped = total > 1;
	const last = at >= total - 1;
	const go = (to: number) => {
		moved.current = true;
		setAt(Math.max(0, Math.min(total - 1, to)));
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: `at` is the trigger: another question is another set of fields
	useEffect(() => {
		if (!moved.current) return;
		moved.current = false;
		const el = body.current;
		// A new question is read from its top, and the card (which scrolls when a question is tall) starts over with it.
		el?.closest<HTMLElement>('[role="dialog"]')?.scrollTo({ top: 0 });
		// The chosen answer takes the keyboard, or the first choice, or Other: Space, the arrows and Enter go on from there.
		(el?.querySelector<HTMLElement>("input:checked") ?? el?.querySelector<HTMLElement>("input"))?.focus({
			preventScroll: true,
		});
	}, [at]);
	const keys: StepKeys = {
		onCompositionEnd: ime.onCompositionEnd,
		onKeyDown: (e) => {
			if (e.key !== "Enter" || ime.imeKey(e)) return;
			e.preventDefault();
			if (last) body.current?.querySelector<HTMLElement>("[data-ask-submit]")?.focus({ preventScroll: true });
			else go(at + 1);
		},
	};
	if (!stepped) {
		return (
			<div className="space-y-4" ref={body}>
				{questions.map((q, i) => (
					<QuestionFields
						key={q.id}
						name={`ask-${req.id}-${q.id}`}
						q={q}
						answer={answers[i]}
						onChange={(fn) => update(i, fn)}
					/>
				))}
				<div className="flex justify-end gap-2">
					<Button variant="ghost" className={TOUCH} onClick={onCancel}>
						{t("panel.reqSkip")}
					</Button>
					<Button variant="primary" className={TOUCH} onClick={submit}>
						{t("panel.reqSubmitAnswers")}
					</Button>
				</div>
			</div>
		);
	}
	const q = questions[at];
	const place = t("panel.reqStepAria", { n: at + 1, total });
	return (
		<div className="space-y-4" ref={body}>
			<div className="flex items-center gap-3">
				<span className="text-xs font-medium text-muted tabular-nums" data-testid="ask-step" aria-hidden="true">
					{t("panel.reqStep", { n: at + 1, total })}
				</span>
				<progress className="sr-only" max={total} value={at + 1} aria-label={place} />
				<div className="flex min-w-0 flex-1 gap-1" aria-hidden="true">
					{questions.map((s, i) => (
						<span key={s.id} className={cx("h-1 min-w-0 flex-1 rounded-full", i <= at ? "bg-accent" : "bg-border")} />
					))}
				</div>
			</div>
			<QuestionFields
				key={q.id}
				name={`ask-${req.id}-${q.id}`}
				q={q}
				answer={answers[at]}
				onChange={(fn) => update(at, fn)}
				of={place}
				keys={keys}
			/>
			{last ? (
				<section
					aria-labelledby={reviewId}
					className="rounded-xl border border-border bg-bg-soft px-3 py-2"
					data-testid="ask-review"
				>
					<h3 id={reviewId} className="mb-1 text-xs font-medium text-muted">
						{t("panel.reqReview")}
					</h3>
					<ul id={listId} className="space-y-0.5">
						{questions.map((s, i) => {
							const text = answerText(answers[i]);
							return (
								<li key={s.id} className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-2 text-xs">
									<span className="truncate text-muted">{s.header || s.question}</span>
									{text !== undefined ? (
										<span className="break-words font-medium">{text}</span>
									) : (
										<span className="text-faint">{t("panel.reqNoAnswer")}</span>
									)}
								</li>
							);
						})}
					</ul>
				</section>
			) : null}
			{/* Pinned to the card's foot (the card's padding is a variable of its own, and a sticky box measures from inside the padding): a question taller than the card scrolls under it, and Skip all, Back and Next stay in reach. */}
			<div className="sticky -bottom-(--pad) z-10 -mx-(--pad) -mb-(--pad) flex items-center justify-between gap-2 border-t border-border bg-surface px-(--pad) pt-3 pb-(--pad)">
				<Button variant="ghost" className={TOUCH} onClick={onCancel}>
					{t("panel.reqSkipAll")}
				</Button>
				<div className="flex gap-2">
					{at > 0 ? (
						<Button className={TOUCH} onClick={() => go(at - 1)}>
							{t("panel.reqBack")}
						</Button>
					) : null}
					{last ? (
						<Button variant="primary" className={TOUCH} onClick={submit} aria-describedby={listId} data-ask-submit>
							{t("panel.reqSubmitAnswers")}
						</Button>
					) : (
						<Button variant="primary" className={TOUCH} onClick={() => go(at + 1)}>
							{t("panel.reqNext")}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
