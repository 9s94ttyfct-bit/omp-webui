/**
 * omp's `ask` tool hands the person one HTML `<form>`. From omp 19.1.0 an RPC host is sent it whole (`extension_ui_request`
 * `form`, with its `html`) and answers with the submitted data (`{ data }`) or a cancel; before, omp asked its fields one at
 * a time as `select`/`input`/`editor` dialogs (`ask-form.ts`, `ask-checks.ts`).
 *
 * omp checks the data against its own reading of the form and fails the call on any mismatch, so the page reads it the same
 * way: this is omp's reader (`@oh-my-pi/pi-tui`, `html-form/parse.ts` and `html-form/data.ts` of 19.1.1, MIT License,
 * Copyright (c) 2025 Mario Zechner) on the browser's `DOMParser`, which runs and loads nothing. The model it gives is small:
 * sections (one per top-level `<fieldset>`, plus untitled runs between them), context blocks (paragraphs, headings, lists,
 * preformatted text, tables, pictures) and fields. Radios and checkboxes join one choice per `type` + `name` wherever they
 * are; buttons are dropped (the page has Submit and Cancel).
 */

export type FormSpanStyle = "code" | "strong" | "em";

/** A run of inline text; `"\n"` inside `text` is a hard line break (`<br>`). */
export interface FormSpan {
	text: string;
	style?: FormSpanStyle;
}

export interface ChoiceOption {
	value: string;
	label: FormSpan[];
	checked: boolean;
	disabled: boolean;
}

/** A radio group (`multi: false`), a checkbox group (`multi: true`) or a `<select>` (`select: true`). */
export interface ChoiceField {
	kind: "choice";
	name: string;
	multi: boolean;
	select: boolean;
	/** The page adds a free-text "Other" answer: a radio or checkbox group of two or more options with none of its own. */
	other: boolean;
	/** The control's own label; empty for radio and checkbox groups, whose question is the text before them. */
	label: FormSpan[];
	options: ChoiceOption[];
	required: boolean;
}

/** A single-line `<input>` or a `<textarea>` (`multiline`). */
export interface TextField {
	kind: "text";
	name: string;
	/** The `<input type>` (`text`, `number`, `url`, …); `textarea` for a textarea. */
	type: string;
	multiline: boolean;
	label: FormSpan[];
	value: string;
	placeholder: string;
	required: boolean;
	min?: number;
	max?: number;
	pattern?: string;
	minLength?: number;
	maxLength?: number;
	rows: number;
}

export type FormField = ChoiceField | TextField;

export type FormBlock =
	| { kind: "text"; spans: FormSpan[]; heading: boolean }
	| { kind: "list"; items: FormSpan[][]; ordered: boolean }
	| { kind: "pre"; text: string }
	| { kind: "table"; rows: FormSpan[][][]; headerRows: number }
	| { kind: "image"; src: string; alt: string }
	| { kind: "svg"; markup: string; alt: string }
	| OptionRun;

/**
 * A field (`field`), or more options of a radio or checkbox group that come after other blocks (`options`): text between
 * a group's options stays between them. `options` are the indices into the field's options drawn here.
 */
export interface OptionRun {
	kind: "field" | "options";
	field: FormField;
	options: number[];
}

export interface FormSection {
	title: FormSpan[];
	blocks: FormBlock[];
	fieldset: boolean;
}

export interface HtmlForm {
	sections: FormSection[];
	fields: FormField[];
	hidden: [name: string, value: string][];
}

/** One control's submitted value: text, a number for `number`/`range`, or a group's checked values. */
export type HtmlFormValue = string | number | string[];
export type HtmlFormData = Record<string, HtmlFormValue>;

const SKIPPED = new Set([
	"button",
	"head",
	"iframe",
	"link",
	"meta",
	"noscript",
	"script",
	"style",
	"template",
	"title",
]);
const BLOCK = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"dd",
	"details",
	"div",
	"dl",
	"dt",
	"figure",
	"figcaption",
	"footer",
	"header",
	"li",
	"main",
	"nav",
	"p",
	"section",
]);
const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "summary"]);
const STYLE_OF: Record<string, FormSpanStyle> = {
	b: "strong",
	code: "code",
	em: "em",
	i: "em",
	kbd: "code",
	samp: "code",
	strong: "strong",
	tt: "code",
};
const IGNORED_INPUTS = new Set(["button", "file", "image", "reset", "submit"]);
const CONTROLS = "input, select, textarea";

const isText = (node: Node): node is Text => node.nodeType === Node.TEXT_NODE;
const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;
const tagOf = (el: Element) => el.localName.toLowerCase();
const childElements = (el: Element) => Array.from(el.children);
const all = (root: ParentNode, selector: string) => Array.from(root.querySelectorAll(selector));

/** Read agent-written form HTML; what is outside the first `<form>` is ignored when there is one. */
export function parseHtmlForm(html: string): HtmlForm {
	const doc = new DOMParser().parseFromString(html, "text/html");
	return new FormBuilder(doc.querySelector("form") ?? doc.body).build();
}

function appendSpan(spans: FormSpan[], text: string, style: FormSpanStyle | undefined): void {
	if (!text) return;
	const last = spans[spans.length - 1];
	if (last && last.style === style) last.text += text;
	else spans.push(style ? { text, style } : { text });
}

/** Whitespace as HTML lays it out: runs become one space, none beside a hard break, the ends trimmed. */
function normalizeSpans(spans: FormSpan[]): FormSpan[] {
	const out: FormSpan[] = [];
	for (const span of spans) appendSpan(out, span.text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n"), span.style);
	const first = out[0];
	if (first) first.text = first.text.replace(/^\s+/, "");
	const last = out[out.length - 1];
	if (last) last.text = last.text.replace(/\s+$/, "");
	return out.filter((span) => span.text !== "");
}

export function spansText(spans: readonly FormSpan[]): string {
	return spans.map((span) => span.text).join("");
}

function svgTitle(svg: Element): string {
	const label = svg.getAttribute("aria-label");
	if (label) return label.trim();
	const title = childElements(svg).find((child) => tagOf(child) === "title");
	return (title?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function numberAttr(el: Element, name: string): number | undefined {
	const raw = el.getAttribute(name);
	if (raw === null || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

class FormBuilder {
	private readonly sections: FormSection[] = [];
	private readonly fields: FormField[] = [];
	private readonly hidden: [string, string][] = [];
	/** Radio and checkbox groups by `type\0name`, with the run of options their last option went into. */
	private readonly groups = new Map<string, { field: ChoiceField; run: OptionRun }>();
	/** `<label for>` by the id of the control it names. */
	private readonly labelFor = new Map<string, Element>();
	private section: FormSection = { title: [], blocks: [], fieldset: false };
	private inline: FormSpan[] = [];
	private fieldsetDepth = 0;

	constructor(private readonly root: Element) {
		this.sections.push(this.section);
	}

	build(): HtmlForm {
		const ids = new Set<string>();
		for (const control of all(this.root, CONTROLS)) if (control.id) ids.add(control.id);
		for (const label of all(this.root, "label")) {
			const target = label.getAttribute("for");
			if (target && ids.has(target) && !this.labelFor.has(target)) this.labelFor.set(target, label);
		}
		this.children(this.root, undefined);
		this.flush(false);
		for (const field of this.fields) {
			if (field.kind !== "choice" || field.select || field.options.length < 2) continue;
			field.other = !field.options.some((option) => /^\s*other\b/i.test(spansText(option.label)));
		}
		return {
			sections: this.sections.filter((s) => s.blocks.length > 0 || s.title.length > 0),
			fields: this.fields,
			hidden: this.hidden,
		};
	}

	private children(node: Node, style: FormSpanStyle | undefined): void {
		for (const child of Array.from(node.childNodes)) this.walk(child, style);
	}

	private walk(node: Node, style: FormSpanStyle | undefined): void {
		if (isText(node)) {
			appendSpan(this.inline, node.data, style);
			return;
		}
		if (!isElement(node)) return;
		const tag = tagOf(node);
		if (SKIPPED.has(tag)) return;
		switch (tag) {
			case "br":
				appendSpan(this.inline, "\n", undefined);
				return;
			case "hr":
				this.flush(false);
				return;
			case "input":
			case "select":
			case "textarea":
				this.control(node, undefined);
				return;
			case "label":
				this.label(node, style);
				return;
			case "fieldset":
				this.fieldset(node);
				return;
			case "legend":
				this.flush(false);
				this.children(node, style);
				this.flush(true);
				return;
			case "ul":
			case "ol":
				this.list(node, tag === "ol");
				return;
			case "pre":
				this.flush(false);
				this.section.blocks.push({ kind: "pre", text: (node.textContent ?? "").replace(/^\n/, "").trimEnd() });
				return;
			case "table":
				this.table(node);
				return;
			case "img": {
				const src = node.getAttribute("src")?.trim();
				if (!src) return;
				this.flush(false);
				this.section.blocks.push({ kind: "image", src, alt: (node.getAttribute("alt") ?? "").trim() });
				return;
			}
			case "svg":
				this.flush(false);
				this.section.blocks.push({ kind: "svg", markup: node.outerHTML, alt: svgTitle(node) });
				return;
		}
		if (HEADING.has(tag) || BLOCK.has(tag)) {
			this.flush(false);
			this.children(node, style);
			this.flush(HEADING.has(tag));
			return;
		}
		this.children(node, STYLE_OF[tag] ?? style);
	}

	private flush(heading: boolean): void {
		const spans = normalizeSpans(this.inline);
		this.inline = [];
		if (spans.length > 0) this.section.blocks.push({ kind: "text", spans, heading });
	}

	/** The inline text of `el`, its controls left out (their label is the text around them). */
	private spansOf(el: Element): FormSpan[] {
		const spans: FormSpan[] = [];
		const visit = (node: Node, style: FormSpanStyle | undefined): void => {
			if (isText(node)) {
				appendSpan(spans, node.data, style);
				return;
			}
			if (!isElement(node)) return;
			const tag = tagOf(node);
			if (SKIPPED.has(tag) || tag === "input" || tag === "select" || tag === "textarea" || tag === "svg") return;
			if (tag === "br") {
				appendSpan(spans, "\n", undefined);
				return;
			}
			if (tag === "img") {
				appendSpan(spans, node.getAttribute("alt") ?? "", style);
				return;
			}
			if (BLOCK.has(tag) || HEADING.has(tag)) appendSpan(spans, " ", undefined);
			for (const child of Array.from(node.childNodes)) visit(child, STYLE_OF[tag] ?? style);
		};
		for (const child of Array.from(el.childNodes)) visit(child, undefined);
		return normalizeSpans(spans);
	}

	private label(label: Element, style: FormSpanStyle | undefined): void {
		const target = label.getAttribute("for");
		if (target && this.labelFor.get(target) === label) return;
		const controls = all(label, CONTROLS);
		if (controls.length === 0) {
			this.children(label, style);
			return;
		}
		this.flush(false);
		const spans = this.spansOf(label);
		for (const control of controls) this.control(control, spans);
	}

	private fieldset(fieldset: Element): void {
		this.flush(false);
		const legend = childElements(fieldset).find((child) => tagOf(child) === "legend");
		// A nested fieldset stays in the outer section; its legend is a heading there.
		if (this.fieldsetDepth > 0) {
			if (legend) this.walk(legend, undefined);
		} else this.startSection(legend ? this.spansOf(legend) : [], true);
		this.fieldsetDepth++;
		for (const child of Array.from(fieldset.childNodes)) if (child !== legend) this.walk(child, undefined);
		this.flush(false);
		this.fieldsetDepth--;
		if (this.fieldsetDepth === 0) this.startSection([], false);
	}

	private startSection(title: FormSpan[], fieldset: boolean): void {
		if (this.section.blocks.length === 0 && this.section.title.length === 0) {
			this.section.title = title;
			this.section.fieldset = fieldset;
			return;
		}
		this.section = { title, blocks: [], fieldset };
		this.sections.push(this.section);
	}

	private list(list: Element, ordered: boolean): void {
		this.flush(false);
		// A list of controls is layout, not content.
		if (list.querySelector(CONTROLS)) {
			this.children(list, undefined);
			this.flush(false);
			return;
		}
		const items = childElements(list)
			.filter((child) => tagOf(child) === "li")
			.map((item) => this.spansOf(item))
			.filter((spans) => spans.length > 0);
		if (items.length > 0) this.section.blocks.push({ kind: "list", items, ordered });
	}

	private table(table: Element): void {
		this.flush(false);
		const rows = all(table, "tr").filter((row) => row.closest("table") === table);
		const cellsOf = (row: Element) => childElements(row).filter((cell) => ["td", "th"].includes(tagOf(cell)));
		if (!table.querySelector(CONTROLS)) {
			const cells = rows.map((row) => cellsOf(row).map((cell) => this.spansOf(cell)));
			let headerRows = 0;
			while (
				headerRows < rows.length &&
				(rows[headerRows].closest("thead") !== null || cellsOf(rows[headerRows]).every((c) => tagOf(c) === "th"))
			)
				headerRows++;
			if (cells.some((row) => row.length > 0)) this.section.blocks.push({ kind: "table", rows: cells, headerRows });
			return;
		}
		// A table of controls (a decision matrix): each row's text is a line, and a control with no label of its own takes
		// its column's header.
		let header: FormSpan[][] = [];
		for (const row of rows) {
			const cells = cellsOf(row);
			if (cells.every((cell) => tagOf(cell) === "th") && !row.querySelector(CONTROLS)) {
				header = cells.map((cell) => this.spansOf(cell));
				continue;
			}
			const text: FormSpan[] = [];
			for (const cell of cells) {
				if (cell.querySelector(CONTROLS)) continue;
				const spans = this.spansOf(cell);
				if (spans.length === 0) continue;
				if (text.length > 0) appendSpan(text, " · ", undefined);
				for (const span of spans) appendSpan(text, span.text, span.style);
			}
			if (text.length > 0) this.section.blocks.push({ kind: "text", spans: text, heading: false });
			cells.forEach((cell, column) => {
				for (const control of all(cell, CONTROLS)) {
					const own = control.closest("label");
					const spans = own && cell.contains(own) ? this.spansOf(own) : this.spansOf(cell);
					this.control(control, spans.length > 0 ? spans : (header[column] ?? []));
				}
			});
		}
	}

	/** The label of a control outside any wrapping `<label>`: `<label for>`, then `aria-label`, then `title`. */
	private detachedLabel(control: Element): FormSpan[] {
		const label = control.id ? this.labelFor.get(control.id) : undefined;
		if (label) return this.spansOf(label);
		const text = control.getAttribute("aria-label") ?? control.getAttribute("title");
		return text ? normalizeSpans([{ text }]) : [];
	}

	private control(control: Element, wrapping: FormSpan[] | undefined): void {
		this.flush(false);
		const label = wrapping && wrapping.length > 0 ? wrapping : this.detachedLabel(control);
		const name = control.getAttribute("name") ?? "";
		const required = control.hasAttribute("required");
		const tag = tagOf(control);
		if (tag === "select") {
			const multi = control.hasAttribute("multiple");
			const options: ChoiceOption[] = all(control, "option").map((option) => {
				const text = (option.textContent ?? "").replace(/\s+/g, " ").trim();
				return {
					value: option.getAttribute("value") ?? text,
					label: [{ text }],
					checked: option.hasAttribute("selected"),
					disabled: option.hasAttribute("disabled"),
				};
			});
			// A single select always has a choice: the first enabled option unless one is marked.
			if (!multi && !options.some((o) => o.checked)) {
				const first = options.find((o) => !o.disabled);
				if (first) first.checked = true;
			}
			this.addField({ kind: "choice", name, multi, select: true, other: false, label, options, required });
			return;
		}
		if (tag === "textarea") {
			this.addField({
				kind: "text",
				name,
				type: "textarea",
				multiline: true,
				label: label.length > 0 ? label : nameLabel(name),
				value: (control.textContent ?? "").replace(/^\r?\n/, ""),
				placeholder: control.getAttribute("placeholder") ?? "",
				required,
				minLength: numberAttr(control, "minlength"),
				maxLength: numberAttr(control, "maxlength"),
				rows: numberAttr(control, "rows") ?? 4,
			});
			return;
		}
		const type = (control.getAttribute("type") ?? "text").toLowerCase();
		if (IGNORED_INPUTS.has(type)) return;
		const value = control.getAttribute("value");
		if (type === "hidden") {
			if (name) this.hidden.push([name, value ?? ""]);
			return;
		}
		if (type === "radio" || type === "checkbox") {
			const option: ChoiceOption = {
				value: value ?? "on",
				label: label.length > 0 ? label : [{ text: value ?? name }],
				checked: control.hasAttribute("checked"),
				disabled: control.hasAttribute("disabled"),
			};
			const key = `${type}\0${name}`;
			const group = this.groups.get(key);
			if (group) {
				group.field.options.push(option);
				group.field.required ||= required;
				const at = group.field.options.length - 1;
				// Text between two options of a group (an option's description, a row of a table) stays between them.
				if (this.section.blocks.at(-1) === group.run) group.run.options.push(at);
				else {
					group.run = { kind: "options", field: group.field, options: [at] };
					this.section.blocks.push(group.run);
				}
				return;
			}
			const field: ChoiceField = {
				kind: "choice",
				name,
				multi: type === "checkbox",
				select: false,
				other: false,
				label: [],
				options: [option],
				required,
			};
			this.groups.set(key, { field, run: this.addField(field) });
			return;
		}
		this.addField({
			kind: "text",
			name,
			type,
			multiline: false,
			label: label.length > 0 ? label : nameLabel(name),
			value: value ?? "",
			placeholder: control.getAttribute("placeholder") ?? "",
			required,
			min: numberAttr(control, "min"),
			max: numberAttr(control, "max"),
			pattern: control.getAttribute("pattern") ?? undefined,
			minLength: numberAttr(control, "minlength"),
			maxLength: numberAttr(control, "maxlength"),
			rows: 1,
		});
	}

	private addField(field: FormField): OptionRun {
		this.fields.push(field);
		const block: OptionRun = {
			kind: "field",
			field,
			options: field.kind === "choice" ? field.options.map((_, i) => i) : [],
		};
		this.section.blocks.push(block);
		return block;
	}
}

/** The last resort for a label: the control's name, `sentry_dsn` → `sentry dsn`. */
function nameLabel(name: string): FormSpan[] {
	return name ? [{ text: name.replace(/[_-]+/g, " ") }] : [];
}

/** Whether a choice submits an array (a checkbox group, a multiple select) rather than one value. */
export function isArrayChoice(field: ChoiceField): boolean {
	return field.multi && field.options.length > 1;
}

/**
 * What a choice submits, given the options checked and the text typed in its "Other": the text stands in for a radio's
 * value, or joins a checkbox group's array. Undefined when it submits nothing; blank Other text is no answer.
 */
export function choiceValue(field: ChoiceField, checked: ReadonlySet<number>, other = ""): HtmlFormValue | undefined {
	const typed = field.other ? other.trim() : "";
	const values = field.options.flatMap((option, i) => (checked.has(i) && !option.disabled ? [option.value] : []));
	if (isArrayChoice(field)) return typed ? [...values, typed] : values;
	return typed || values[0];
}

/** What a text field submits: a number for a numeric `number`/`range` entry, else the text. */
export function textValue(field: TextField, text: string): HtmlFormValue {
	if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
		const number = Number(text);
		if (Number.isFinite(number)) return number;
	}
	return text;
}

/** Why omp would refuse `value` for `field` (its rules on submit), or null when it takes it. */
export type FieldProblem =
	| { kind: "required" | "selectOne" | "number" | "email" | "url" }
	| { kind: "min" | "max" | "minLength" | "maxLength"; n: number }
	| { kind: "pattern"; pattern: string };

export function fieldProblem(field: FormField, value: HtmlFormValue | undefined): FieldProblem | null {
	if (field.kind === "choice") {
		const empty = value === undefined || (Array.isArray(value) && value.length === 0);
		if (!field.required || !empty) return null;
		return { kind: isArrayChoice(field) ? "selectOne" : "required" };
	}
	const text = value === undefined ? "" : String(value);
	if (text.trim() === "") return field.required ? { kind: "required" } : null;
	if (field.type === "number" || field.type === "range") {
		const number = Number(text);
		if (!Number.isFinite(number)) return { kind: "number" };
		if (field.min !== undefined && number < field.min) return { kind: "min", n: field.min };
		if (field.max !== undefined && number > field.max) return { kind: "max", n: field.max };
	}
	if (field.minLength !== undefined && text.length < field.minLength) return { kind: "minLength", n: field.minLength };
	if (field.maxLength !== undefined && text.length > field.maxLength) return { kind: "maxLength", n: field.maxLength };
	if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return { kind: "email" };
	if (field.type === "url" && !URL.canParse(text)) return { kind: "url" };
	if (field.pattern && compilePattern(field.pattern)?.test(text) === false)
		return { kind: "pattern", pattern: field.pattern };
	return null;
}

/** `pattern` anchored as HTML anchors it; undefined for a pattern that is not valid (omp then ignores it). */
function compilePattern(pattern: string): RegExp | undefined {
	try {
		return new RegExp(`^(?:${pattern})$`, "v");
	} catch {
		return undefined;
	}
}
