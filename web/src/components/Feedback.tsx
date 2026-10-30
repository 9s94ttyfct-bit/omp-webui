import { Bug, Check, Copy, ExternalLink, Lightbulb } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useLang, useT } from "../i18n/index.ts";
import { api, type Diagnostics } from "../lib/api.ts";
import {
	buildIssue,
	diagnosticsText,
	FEEDBACK_FIELDS,
	type FeedbackKind,
	fullText,
	issueLink,
	missingField,
	summaryMax,
} from "../lib/feedback.ts";
import { useScrolls } from "../lib/scrolls.ts";
import { useApp } from "../store/app.ts";
import { Button, cx, Modal } from "./ui.tsx";

const field = "w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint";

/** The label and hint of each guided field, by `FEEDBACK_FIELDS` key. */
const FIELD_TEXT: Record<string, { label: MessageKey; hint?: MessageKey }> = {
	happened: { label: "feedback.happened", hint: "feedback.happenedHint" },
	steps: { label: "feedback.steps", hint: "feedback.stepsHint" },
	expected: { label: "feedback.expected" },
	actual: { label: "feedback.actual" },
	problem: { label: "feedback.problem", hint: "feedback.problemHint" },
	solution: { label: "feedback.solution", hint: "feedback.solutionHint" },
};

/**
 * The Feedback dialog: a bug report or a feature request, guided field by field, previewed, then opened as a
 * prefilled new-issue page on GitHub (the macOS app hands the link to the default browser). Nothing is sent
 * from here; what is written is cleaned of secrets first (`sanitize`), and the diagnostics are optional.
 */
export function Feedback() {
	const t = useT();
	const { lang } = useLang();
	const open = useApp((s) => s.feedbackOpen);
	const set = useApp((s) => s.set);
	const meta = useApp((s) => s.meta);
	const id = useId();
	const [kind, setKind] = useState<FeedbackKind>("bug");
	const [summary, setSummary] = useState("");
	const [values, setValues] = useState<Record<string, string>>({});
	const [attach, setAttach] = useState(true);
	const [previewing, setPreviewing] = useState(false);
	const [copied, setCopied] = useState<boolean | null>(null);
	const [server, setServer] = useState<Diagnostics | null>(null);
	const [bodyRef, bodyScrolls] = useScrolls<HTMLPreElement>();

	// What the server alone knows (the OS, the mode), fetched when the dialog first opens; the report goes without it if that fails.
	useEffect(() => {
		if (open && !server) api.diagnostics().then(setServer, () => {});
	}, [open, server]);
	// Back to the form, and the copy note forgotten, whenever the dialog is closed; the draft stays for the next visit.
	useEffect(() => {
		if (!open) {
			setPreviewing(false);
			setCopied(null);
		}
	}, [open]);

	const draft = { kind, summary, fields: values };
	const missing = missingField(draft);
	const issue = useMemo(() => {
		const diagnostics = attach
			? diagnosticsText({
					webui: meta?.serverVersion ?? "unknown",
					omp: meta?.ompVersion ?? "unknown",
					os: server?.os,
					mode: server?.mode,
					browser: navigator.userAgent,
					language: lang,
				})
			: null;
		return buildIssue({ kind, summary, fields: values }, diagnostics, meta?.home, meta?.user);
	}, [kind, summary, values, attach, meta, server, lang]);
	const link = useMemo(() => issueLink(issue), [issue]);

	const reset = () => {
		setSummary("");
		setValues({});
		setPreviewing(false);
	};
	// The whole report, never the cut body of the link: what a cut link leaves out is pasted from here.
	const copy = () => {
		navigator.clipboard.writeText(fullText(issue)).then(
			() => setCopied(true),
			() => setCopied(false),
		);
	};
	const KINDS = [
		["bug", "feedback.kindBug", Bug],
		["feature", "feedback.kindFeature", Lightbulb],
	] as const;

	return (
		<Modal
			open={open}
			onOpenChange={(o) => set({ feedbackOpen: o })}
			title={t("feedback.title")}
			description={t("feedback.intro")}
			wide
		>
			{previewing ? (
				<div className="space-y-3" data-testid="feedback-preview">
					<p className="text-sm text-muted">{t("feedback.previewIntro")}</p>
					<div>
						<div className="mb-1 text-xs font-medium">{t("feedback.previewTitle")}</div>
						<div
							className="rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm font-medium"
							data-testid="feedback-title"
						>
							{issue.title}
						</div>
					</div>
					<div className="text-xs text-muted">
						{t("feedback.previewLabels")}: <span data-testid="feedback-labels">{issue.labels.join(", ")}</span>
					</div>
					<div>
						<div className="mb-1 text-xs font-medium">{t("feedback.previewBody")}</div>
						<pre
							ref={bodyRef}
							// A preview taller than its box is scrolled from the keyboard too.
							tabIndex={bodyScrolls ? 0 : undefined}
							className="max-h-64 overflow-auto rounded-lg border border-border bg-bg-soft p-3 text-xs break-words whitespace-pre-wrap"
							data-testid="feedback-body"
						>
							{link.body}
						</pre>
					</div>
					{link.truncated ? (
						<p className="text-xs text-warning" role="status" data-testid="feedback-truncated">
							{t(link.truncated === "text" ? "feedback.truncatedText" : "feedback.truncatedDiagnostics")}
						</p>
					) : null}
					<div className="flex flex-wrap items-center justify-end gap-2">
						{copied !== null ? (
							<span className="mr-auto text-xs text-muted" role="status">
								{t(copied ? "feedback.copied" : "feedback.copyFailed")}
							</span>
						) : null}
						<Button variant="ghost" onClick={() => setPreviewing(false)} data-testid="feedback-back">
							{t("feedback.back")}
						</Button>
						<Button onClick={copy} data-testid="feedback-copy">
							{copied ? <Check size={14} /> : <Copy size={14} />} {t("feedback.copy")}
						</Button>
						<a
							href={link.url}
							target="_blank"
							rel="noreferrer noopener"
							data-testid="feedback-open"
							onClick={() => {
								// A cut text is still needed to finish the issue: it goes to the clipboard, and the form stays.
								if (link.truncated === "text") {
									copy();
									return;
								}
								// After the click has been handled (the link opens), the draft is spent.
								setTimeout(() => {
									reset();
									set({ feedbackOpen: false });
								}, 0);
							}}
							className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-fg transition-colors hover:brightness-110"
						>
							<ExternalLink size={14} /> {t("feedback.open")}
						</a>
					</div>
				</div>
			) : (
				<form
					className="space-y-4"
					data-testid="feedback-form"
					onSubmit={(e) => {
						e.preventDefault();
						if (!missing) setPreviewing(true);
					}}
				>
					<fieldset>
						<legend className="mb-1.5 text-xs font-medium">{t("feedback.kind")}</legend>
						<div className="flex gap-2">
							{KINDS.map(([value, label, Icon]) => (
								<label
									key={value}
									className={cx(
										"flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
										kind === value ? "border-accent bg-accent-soft" : "border-border hover:bg-hover",
									)}
								>
									<input
										type="radio"
										name={`${id}-kind`}
										value={value}
										className="sr-only"
										data-testid={`feedback-kind-${value}`}
										checked={kind === value}
										onChange={() => {
											setKind(value);
											// The other kind's prefix is longer or shorter: the summary must still fit the title.
											setSummary((s) => s.slice(0, summaryMax(value)));
										}}
									/>
									<Icon size={15} /> {t(label)}
								</label>
							))}
						</div>
					</fieldset>
					<div>
						<label className="mb-1 block text-xs font-medium" htmlFor={`${id}-summary`}>
							{t("feedback.summary")} <span className="font-normal text-faint">({t("feedback.required")})</span>
						</label>
						<input
							id={`${id}-summary`}
							data-testid="feedback-summary"
							className={field}
							required
							maxLength={summaryMax(kind)}
							placeholder={t(kind === "bug" ? "feedback.summaryBugHint" : "feedback.summaryFeatureHint")}
							value={summary}
							onChange={(e) => setSummary(e.target.value)}
						/>
					</div>
					{FEEDBACK_FIELDS[kind].map((f) => {
						const text = FIELD_TEXT[f.key];
						return (
							<div key={f.key}>
								<label className="mb-1 block text-xs font-medium" htmlFor={`${id}-${f.key}`}>
									{t(text.label)}{" "}
									<span className="font-normal text-faint">
										({t(f.required ? "feedback.required" : "feedback.optional")})
									</span>
								</label>
								<textarea
									id={`${id}-${f.key}`}
									data-testid={`feedback-${f.key}`}
									className={`${field} min-h-20`}
									required={f.required}
									placeholder={text.hint ? t(text.hint) : undefined}
									value={values[f.key] ?? ""}
									onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
								/>
							</div>
						);
					})}
					<label className="flex cursor-pointer items-start gap-3 text-sm">
						<input
							type="checkbox"
							className="mt-1 accent-[var(--accent)]"
							data-testid="feedback-diagnostics"
							checked={attach}
							onChange={(e) => setAttach(e.target.checked)}
						/>
						<span>
							{t("feedback.diagnostics")}
							<span className="block text-xs text-muted">{t("feedback.diagnosticsHint")}</span>
						</span>
					</label>
					<p className="text-xs text-muted">{t("feedback.cleaned")}</p>
					<div className="flex justify-end gap-2">
						<Button variant="ghost" onClick={() => set({ feedbackOpen: false })}>
							{t("common.cancel")}
						</Button>
						<Button type="submit" variant="primary" disabled={missing !== null} data-testid="feedback-preview-button">
							{t("feedback.preview")}
						</Button>
					</div>
				</form>
			)}
		</Modal>
	);
}
