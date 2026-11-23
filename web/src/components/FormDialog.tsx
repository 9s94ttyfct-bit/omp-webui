import { Fragment, type KeyboardEvent, type ReactNode, useId, useMemo, useRef, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import {
	type ChoiceField,
	choiceValue,
	type FieldProblem,
	type FormBlock,
	type FormField,
	type FormSpan,
	fieldProblem,
	type HtmlFormData,
	type HtmlFormValue,
	isArrayChoice,
	type OptionRun,
	parseHtmlForm,
	spansText,
	type TextField,
	textValue,
} from "../lib/html-form.ts";
import { useImeGuard } from "../lib/ime.ts";
import { answerDialog as respond } from "../store/app.ts";
import type { UIRequest } from "../store/live.ts";
import { Button, cx } from "./ui.tsx";

/**
 * omp's `ask` form, sent whole (`extension_ui_request` `form`, omp 19.1.0 and later): drawn from omp's own reading of it
 * (`lib/html-form.ts`), checked on Submit by the rules omp checks it by, and answered with its data. Nothing is sent before
 * Submit; Skip cancels it. The markup itself never reaches the page: only its text, and a picture only from a `data:` URL
 * (the page loads nothing from elsewhere).
 */

const TOUCH = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const INPUT = "w-full rounded-lg border border-border bg-bg-soft px-3 py-1.5 text-sm outline-none focus:border-faint";
/** The input types the browser draws as the form asks; any other is a text box. */
const TYPES = new Set([
	"text",
	"number",
	"email",
	"url",
	"tel",
	"date",
	"time",
	"datetime-local",
	"month",
	"week",
	"color",
	"range",
	"password",
	"search",
]);

/** Each field's answer, by its place in the form's fields. */
type Answer = { checked: Set<number>; other: string } | { text: string };

function firstAnswers(fields: FormField[]): Answer[] {
	return fields.map((f) =>
		f.kind === "choice"
			? { checked: new Set(f.options.flatMap((o, i) => (o.checked ? [i] : []))), other: "" }
			: { text: f.value },
	);
}

function answerValue(field: FormField, answer: Answer): HtmlFormValue | undefined {
	if (field.kind === "choice")
		return "checked" in answer ? choiceValue(field, answer.checked, answer.other) : undefined;
	return "text" in answer ? textValue(field, answer.text) : undefined;
}

function Spans({ spans }: { spans: readonly FormSpan[] }) {
	return (
		<>
			{spans.map((s, i) =>
				s.style === "code" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: the spans of one text never move
					<code key={i} className="rounded bg-hover px-1 font-mono text-[0.9em]">
						{s.text}
					</code>
				) : s.style === "strong" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: as above
					<strong key={i}>{s.text}</strong>
				) : s.style === "em" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: as above
					<em key={i}>{s.text}</em>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: as above
					<Fragment key={i}>{s.text}</Fragment>
				),
			)}
		</>
	);
}

/** A picture of the form: only a `data:` URL (an inline `<svg>` is one), else what it is said to show. */
function Picture({ src, alt }: { src: string; alt: string }) {
	if (/^data:image\//i.test(src))
		return <img src={src} alt={alt} className="max-h-72 max-w-full rounded-lg border border-border bg-white" />;
	return <p className="text-xs text-faint italic break-all">{alt || src}</p>;
}

function svgSource(markup: string): string {
	const svg = /^<svg\b[^>]*\bxmlns=/i.test(markup)
		? markup
		: markup.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export default function FormBody({ req, liveId, onCancel }: { req: UIRequest; liveId: string; onCancel: () => void }) {
	const t = useT();
	const html = typeof req.html === "string" ? req.html : "";
	const form = useMemo(() => parseHtmlForm(html), [html]);
	const [answers, setAnswers] = useState<Answer[]>(() => firstAnswers(form.fields));
	const [problems, setProblems] = useState<Map<number, FieldProblem>>(new Map());
	const root = useRef<HTMLFormElement>(null);
	const ime = useImeGuard();
	const base = useId();
	const index = useMemo(() => new Map(form.fields.map((f, i) => [f, i])), [form]);
	/** The run of a group that draws its last option draws its Other too. */
	const lastRun = useMemo(() => {
		const runs = new Map<FormField, OptionRun>();
		for (const section of form.sections)
			for (const b of section.blocks) if (b.kind === "field" || b.kind === "options") runs.set(b.field, b);
		return runs;
	}, [form]);

	const update = (i: number, fn: (a: Answer) => Answer) => {
		setAnswers((cur) => cur.map((a, j) => (j === i ? fn(a) : a)));
		setProblems((cur) => {
			if (!cur.has(i)) return cur;
			const next = new Map(cur);
			next.delete(i);
			return next;
		});
	};

	const problemText = (p: FieldProblem): string => {
		switch (p.kind) {
			case "required":
				return t("panel.formRequired");
			case "selectOne":
				return t("panel.formSelectOne");
			case "number":
				return t("panel.formNumber");
			case "email":
				return t("panel.formEmail");
			case "url":
				return t("panel.formUrl");
			case "min":
				return t("panel.formMin", { n: p.n });
			case "max":
				return t("panel.formMax", { n: p.n });
			case "minLength":
				return t("panel.formMinLength", { n: p.n });
			case "maxLength":
				return t("panel.formMaxLength", { n: p.n });
			case "pattern":
				return t("panel.formPattern", { pattern: p.pattern.length > 40 ? `${p.pattern.slice(0, 39)}…` : p.pattern });
		}
	};

	const submit = (e: { preventDefault(): void }) => {
		e.preventDefault();
		const data: HtmlFormData = {};
		const found = new Map<number, FieldProblem>();
		form.fields.forEach((field, i) => {
			// omp reads only named controls: an unnamed one is shown, and neither sent nor checked.
			if (!field.name) return;
			const value = answerValue(field, answers[i]);
			const problem = fieldProblem(field, value);
			if (problem) found.set(i, problem);
			if (value !== undefined) data[field.name] = value;
		});
		setProblems(found);
		if (found.size > 0) {
			const first = Math.min(...found.keys());
			requestAnimationFrame(() =>
				root.current?.querySelector<HTMLElement>(`[data-field-index="${first}"]`)?.focus({ preventScroll: false }),
			);
			return;
		}
		respond(liveId, { id: req.id, data });
	};

	/** Enter in a one-line field or on a choice goes to the next field (the last reaches Submit): sending is a decision of its own. */
	const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
		if (e.key !== "Enter" || ime.imeKey(e)) return;
		e.preventDefault();
		const all = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-field-index]") ?? []);
		const at = all.indexOf(e.currentTarget);
		const next = all.slice(at + 1).find((el) => el.dataset.fieldIndex !== e.currentTarget.dataset.fieldIndex);
		(next ?? root.current?.querySelector<HTMLElement>("[data-form-submit]"))?.focus();
	};

	const errorId = (i: number) => `${base}-err-${i}`;
	const errorOf = (i: number): ReactNode => {
		const p = problems.get(i);
		return p ? (
			<p id={errorId(i)} className="text-xs text-danger" data-testid="form-field-error">
				{problemText(p)}
			</p>
		) : null;
	};
	const invalid = (i: number) =>
		problems.has(i) ? { "aria-invalid": true as const, "aria-describedby": errorId(i) } : {};

	const optionRows = (field: ChoiceField, i: number, run: OptionRun) => {
		const answer = answers[i] as { checked: Set<number>; other: string };
		const many = field.multi;
		const rows = run.options.map((o) => {
			const option = field.options[o];
			const on = answer.checked.has(o);
			return (
				<label
					key={o}
					className={cx(
						"flex items-start gap-2 rounded-xl border px-3 py-2 text-sm",
						TOUCH,
						option.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
						on ? "border-accent bg-accent-soft" : "border-border hover:bg-hover",
					)}
				>
					<input
						type={many ? "checkbox" : "radio"}
						name={`${base}-f${i}`}
						className="mt-1 accent-[var(--accent)]"
						checked={on}
						disabled={option.disabled}
						data-field-index={i}
						onKeyDown={onKeyDown}
						{...invalid(i)}
						onChange={() =>
							update(i, (a) => {
								const cur = a as { checked: Set<number>; other: string };
								if (!many) return { checked: new Set([o]), other: "" };
								const checked = new Set(cur.checked);
								if (checked.has(o)) checked.delete(o);
								else checked.add(o);
								return { checked, other: cur.other };
							})
						}
					/>
					<span className="min-w-0 break-words whitespace-pre-line">
						<Spans spans={option.label} />
					</span>
				</label>
			);
		});
		const withOther = field.other && lastRun.get(field) === run;
		return (
			<>
				{rows}
				{withOther ? (
					<input
						aria-label={t("panel.reqOtherAria", { question: spansText(field.label) || field.name })}
						placeholder={t("panel.reqOther")}
						className={INPUT}
						value={answer.other}
						data-field-index={i}
						data-testid="form-other"
						onKeyDown={onKeyDown}
						onCompositionEnd={ime.onCompositionEnd}
						onChange={(e) => {
							const other = e.target.value;
							// A radio's Other stands in for its choice: typing in it clears the one checked.
							update(i, (a) => ({
								checked: many || !other ? (a as { checked: Set<number> }).checked : new Set(),
								other,
							}));
						}}
					/>
				) : null}
			</>
		);
	};

	const choice = (field: ChoiceField, i: number, run: OptionRun) => {
		const answer = answers[i] as { checked: Set<number>; other: string };
		if (field.select && !isArrayChoice(field)) {
			const at = [...answer.checked][0];
			return (
				<label className="block space-y-1 text-sm" data-field={field.name}>
					{field.label.length > 0 ? (
						<span className="block font-medium">
							<Spans spans={field.label} />
						</span>
					) : null}
					<select
						className={cx(INPUT, TOUCH)}
						value={at === undefined ? "" : String(at)}
						data-field-index={i}
						onKeyDown={onKeyDown}
						{...invalid(i)}
						onChange={(e) => update(i, () => ({ checked: new Set([Number(e.target.value)]), other: "" }))}
					>
						{field.options.map((o, j) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: two options may share a value; the place is what is answered
							<option key={j} value={String(j)} disabled={o.disabled}>
								{spansText(o.label)}
							</option>
						))}
					</select>
					{errorOf(i)}
				</label>
			);
		}
		// Radios, checkboxes and a multiple select (drawn as checkboxes): the run's options, and Other after the last.
		const head = run.kind === "field";
		return (
			<div
				className="space-y-1.5"
				data-field={head ? field.name : undefined}
				role={head && !field.multi ? "radiogroup" : undefined}
			>
				{head && field.label.length > 0 ? (
					<p className="text-sm font-medium">
						<Spans spans={field.label} />
					</p>
				) : null}
				{optionRows(field, i, run)}
				{lastRun.get(field) === run ? errorOf(i) : null}
			</div>
		);
	};

	const text = (field: TextField, i: number) => {
		const answer = answers[i] as { text: string };
		const common = {
			className: cx(INPUT, field.multiline && "font-sans"),
			value: answer.text,
			placeholder: field.placeholder || undefined,
			"data-field-index": i,
			...invalid(i),
			onChange: (e: { target: { value: string } }) => update(i, () => ({ text: e.target.value })),
		};
		return (
			// biome-ignore lint/a11y/noLabelWithoutControl: the control is in it (`common` spread onto the input or the textarea)
			<label className="block space-y-1 text-sm" data-field={field.name}>
				{field.label.length > 0 ? (
					<span className="block font-medium whitespace-pre-line">
						<Spans spans={field.label} />
						{field.required ? <span className="text-danger"> *</span> : null}
					</span>
				) : null}
				{field.multiline ? (
					<textarea {...common} rows={Math.min(Math.max(field.rows, 2), 12)} />
				) : (
					<input
						{...common}
						type={TYPES.has(field.type) ? field.type : "text"}
						min={field.min}
						max={field.max}
						onKeyDown={onKeyDown}
						onCompositionEnd={ime.onCompositionEnd}
					/>
				)}
				{errorOf(i)}
			</label>
		);
	};

	const block = (b: FormBlock, key: number): ReactNode => {
		switch (b.kind) {
			case "text":
				return b.heading ? (
					<p key={key} className="text-sm font-semibold break-words whitespace-pre-line">
						<Spans spans={b.spans} />
					</p>
				) : (
					<p key={key} className="text-sm break-words whitespace-pre-line">
						<Spans spans={b.spans} />
					</p>
				);
			case "list": {
				const List = b.ordered ? "ol" : "ul";
				return (
					<List key={key} className={cx("space-y-0.5 pl-5 text-sm", b.ordered ? "list-decimal" : "list-disc")}>
						{b.items.map((item, j) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the items of one list never move
							<li key={j} className="break-words whitespace-pre-line">
								<Spans spans={item} />
							</li>
						))}
					</List>
				);
			}
			case "pre":
				return (
					<pre key={key} className="overflow-x-auto rounded-lg bg-bg-soft px-3 py-2 font-mono text-xs select-text">
						{b.text}
					</pre>
				);
			case "table":
				return (
					<div key={key} className="overflow-x-auto">
						<table className="w-full border-collapse text-xs">
							<tbody>
								{b.rows.map((row, r) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: the rows of one table never move
									<tr key={r} className="border-b border-border">
										{row.map((cell, c) => {
											const Cell = r < b.headerRows ? "th" : "td";
											return (
												// biome-ignore lint/suspicious/noArrayIndexKey: as above
												<Cell key={c} className="px-2 py-1 text-left align-top break-words">
													<Spans spans={cell} />
												</Cell>
											);
										})}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				);
			case "image":
				return <Picture key={key} src={b.src} alt={b.alt} />;
			case "svg":
				return <Picture key={key} src={svgSource(b.markup)} alt={b.alt} />;
			case "field":
			case "options": {
				const i = index.get(b.field) ?? 0;
				return <Fragment key={key}>{b.field.kind === "choice" ? choice(b.field, i, b) : text(b.field, i)}</Fragment>;
			}
		}
	};

	return (
		<form ref={root} noValidate onSubmit={submit} className="space-y-4" data-testid="ask-form">
			{form.sections.map((section, s) => {
				// A `<fieldset>` of the form stays one, its legend the section's title; loose content between them is a plain box.
				const Box = section.fieldset ? "fieldset" : "div";
				const Title = section.fieldset ? "legend" : "p";
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: the sections of one form never move
					<Box key={s} className="space-y-2">
						{section.title.length > 0 ? (
							<Title className="mb-1 text-sm font-semibold">
								<Spans spans={section.title} />
							</Title>
						) : null}
						{section.blocks.map((b, k) => block(b, k))}
					</Box>
				);
			})}
			{problems.size > 0 ? (
				<p role="alert" className="text-xs text-danger">
					{t("panel.formFix", { n: problems.size })}
				</p>
			) : null}
			{/* Pinned to the card's foot, as the steps of an `ask` are: a form taller than the card scrolls under it. */}
			<div className="sticky -bottom-(--pad) z-10 -mx-(--pad) -mb-(--pad) flex justify-end gap-2 border-t border-border bg-surface px-(--pad) pt-3 pb-(--pad)">
				<Button variant="ghost" className={TOUCH} onClick={onCancel}>
					{t("panel.reqSkip")}
				</Button>
				<Button variant="primary" type="submit" className={TOUCH} data-form-submit>
					{t("panel.reqSubmitAnswers")}
				</Button>
			</div>
		</form>
	);
}
