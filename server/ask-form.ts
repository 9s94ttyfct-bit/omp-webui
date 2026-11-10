/**
 * omp's `ask` of one HTML form (omp 18.18.3 and later), read as the questions it asks, for unattended mode (#646): the
 * form is filed for the person as the old `ask` dialog's questions were (`draftsOfAsk`, `shared/unattended.ts`). Read with
 * Bun's `HTMLRewriter`, which parses and runs nothing; only text and a few attributes are taken.
 *
 * Every named field is one question, in the order the form has them (a group of radios or checkboxes of one name is one):
 * its words are the group's `<legend>`, else its `<label>`, else its name; a choice's options are its options' labels, the
 * one checked or selected is the recommended one (of a single choice), and a group of checkboxes or a `<select multiple>`
 * takes several. What the form says around its fields (paragraphs, list items, code, headings, table rows) is each
 * question's context.
 */

/** One question of a form, in the shape of an old `ask` dialog's (`draftsOfAsk` reads it). */
export interface FormQuestion {
	question: string;
	header: string;
	options: { label: string }[];
	recommended?: number;
	multi?: true;
}

interface Field {
	name: string;
	choice: boolean;
	multi: boolean;
	/** The legend of the fieldset it is in, the label it is in or named by, its placeholder. */
	legend: string;
	label: string;
	placeholder: string;
	options: { label: string; checked: boolean }[];
}

/** Text of one element and what is inside it. */
interface Open {
	tag: string;
	text: string;
	/** The fields a `<label>` holds, and what it labels (`for`). */
	fields?: { field: Field; option: number }[];
	for?: string;
}

const BLOCKS = new Set([
	"p",
	"li",
	"pre",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"tr",
	"blockquote",
	"dt",
	"dd",
	"figcaption",
]);
/** Elements whose text is a field's, not the form's (`label` and `legend` are read for the field). */
const FIELD_TEXT = new Set([
	"label",
	"legend",
	"option",
	"select",
	"textarea",
	"button",
	"script",
	"style",
	"template",
]);
const SKIPPED_INPUTS = new Set(["hidden", "submit", "button", "reset", "image", "file"]);

const squeeze = (text: string) => text.replace(/\s+/g, " ").trim();

export function formQuestions(html: string): FormQuestion[] {
	const fields = new Map<string, Field>();
	const byId = new Map<string, { field: Field; option: number }>();
	const forLabels: { for: string; text: string }[] = [];
	const context: string[] = [];
	const stack: Open[] = [];
	let legend = "";
	let select: Field | null = null;

	const fieldOf = (name: string, choice: boolean, multi: boolean): Field => {
		let field = fields.get(name);
		if (!field) {
			field = { name, choice, multi, legend, label: "", placeholder: "", options: [] };
			fields.set(name, field);
		}
		return field;
	};
	const inside = (tag: string) => stack.findLast((o) => o.tag === tag);
	const attach = (field: Field, option: number, id: string | null) => {
		const label = inside("label");
		label?.fields?.push({ field, option });
		if (id) byId.set(id, { field, option });
	};

	new HTMLRewriter()
		.on("*", {
			element(el) {
				const tag = el.tagName.toLowerCase();
				if (tag === "input") {
					const type = (el.getAttribute("type") ?? "text").toLowerCase();
					const name = el.getAttribute("name");
					if (!name || SKIPPED_INPUTS.has(type)) return;
					const choice = type === "radio" || type === "checkbox";
					const field = fieldOf(name, choice, type === "checkbox");
					if (choice) {
						field.options.push({ label: el.getAttribute("value") ?? "", checked: el.hasAttribute("checked") });
						attach(field, field.options.length - 1, el.getAttribute("id"));
					} else {
						field.placeholder ||= el.getAttribute("placeholder") ?? "";
						attach(field, -1, el.getAttribute("id"));
					}
					return;
				}
				if (tag === "select" || tag === "textarea") {
					const name = el.getAttribute("name");
					if (name) {
						const field = fieldOf(name, tag === "select", tag === "select" && el.hasAttribute("multiple"));
						if (tag === "textarea") field.placeholder ||= el.getAttribute("placeholder") ?? "";
						attach(field, -1, el.getAttribute("id"));
						if (tag === "select") select = field;
					}
				}
				if (tag === "option" && select) select.options.push({ label: "", checked: el.hasAttribute("selected") });
				if (!el.canHaveContent) return;
				const open: Open = { tag, text: "" };
				if (tag === "label") {
					open.fields = [];
					const target = el.getAttribute("for");
					if (target) open.for = target;
				}
				if (tag === "fieldset") legend = "";
				stack.push(open);
				el.onEndTag(() => {
					const at = stack.lastIndexOf(open);
					if (at >= 0) stack.splice(at);
					const text = squeeze(open.text);
					if (tag === "legend") legend = text;
					else if (tag === "fieldset") legend = "";
					else if (tag === "select") select = null;
					else if (tag === "option") {
						const field = select;
						const option = field?.options.at(-1);
						if (option) option.label = text || option.label;
					} else if (tag === "label") {
						for (const { field, option } of open.fields ?? []) {
							if (option >= 0) field.options[option].label = text || field.options[option].label;
							else field.label ||= text;
						}
						if (open.for && text) forLabels.push({ for: open.for, text });
					} else if (BLOCKS.has(tag) && text) context.push(text);
				});
			},
		})
		.onDocument({
			text(chunk) {
				const words = chunk.text;
				if (!words) return;
				// Text belongs to the innermost label, legend or option it is in (a block inside one is the field's), else to the
				// innermost block of the form's own.
				const owner = stack.findLast((o) => FIELD_TEXT.has(o.tag)) ?? stack.findLast((o) => BLOCKS.has(o.tag));
				if (owner) owner.text += words;
			},
		})
		.transform(html);

	for (const { for: id, text } of forLabels) {
		const target = byId.get(id);
		if (!target) continue;
		if (target.option >= 0) target.field.options[target.option].label ||= text;
		else target.field.label ||= text;
	}

	const header = context.join("\n");
	return [...fields.values()].map((field) => {
		const options = field.options.filter((o) => o.label !== "");
		const words = field.choice ? field.legend || field.label : field.label || field.legend;
		const out: FormQuestion = {
			question: words || field.placeholder || field.name,
			header,
			options: options.map((o) => ({ label: o.label })),
		};
		const checked = options.findIndex((o) => o.checked);
		if (field.multi) out.multi = true;
		else if (checked >= 0) out.recommended = checked;
		return out;
	});
}
