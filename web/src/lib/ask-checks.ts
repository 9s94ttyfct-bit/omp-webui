/**
 * A choice in omp's `ask` form, asked over RPC: omp asks a radio group or a `<select>` as one `select` dialog of its
 * options, opening on the one the form checks (`initialIndex`, which is 0 when none is: it cannot tell the page which one
 * is preselected). The page reads that from the form itself (`formChoice`).
 *
 * A group of checkboxes has no checkbox dialog to send, so omp asks the same `select` again and again (`tools/ask.ts`):
 * each pick ticks or unticks that option, the question starts with how many are ticked (`(2 selected) <question>`), and a
 * last option ends it (`✔ Done selecting`). omp 18.20 sends which are ticked (`checkedIndices`); before it, only omp's own
 * dialog state had them, so a page that drew the options alone showed none ticked and the person could not tell what a
 * click had done.
 *
 * Without `checkedIndices` the page keeps the ticks itself: what the form ticks to begin with, then every pick it sends
 * toggled. omp's count in the title is the check: when the page's ticks do not add up to it (a page that opened in the
 * middle of the questions, an "Other" whose text was left empty), it shows no ticks rather than wrong ones.
 */

/** The option that ends omp's checkbox loop: its success mark (`✔`, `✓` or the theme's) and the words. */
const DONE = /^\S{1,3} Done selecting$/;
/** omp's count in front of the question while some are ticked. */
const COUNT = /^\((\d+) selected\) /;

/**
 * A field's dialog title, split: since omp 18.19.0 it is the form's text around the field, a blank line, then the question
 * (`promptTitle`); before, the question alone (`context` null).
 */
export function fieldTitle(title: string): { context: string | null; question: string } {
	const cut = title.lastIndexOf("\n\n");
	return cut < 0
		? { context: null, question: title }
		: { context: title.slice(0, cut), question: title.slice(cut + 2) };
}

/** What a checkbox dialog is: its question without the count, the count, and its closing option. */
export interface CheckboxDialog {
	question: string;
	count: number;
	done: string;
}

/** `title` and `options` as omp's checkbox loop asks them, or null when the dialog is an ordinary choice. */
export function checkboxDialog(
	title: string | undefined,
	options: readonly string[] | undefined,
): CheckboxDialog | null {
	const done = options?.at(-1);
	if (title === undefined || done === undefined || !DONE.test(done)) return null;
	const { question } = fieldTitle(title);
	const count = COUNT.exec(question);
	return { question: count ? question.slice(count[0].length) : question, count: count ? Number(count[1]) : 0, done };
}

const squeeze = (text: string) => text.replace(/\s+/g, " ").trim();

/** A choice field of a form: its options as omp names them (label text squeezed, else the value), and those checked. */
interface Choice {
	labels: string[];
	checked: string[];
}

/**
 * The options `html`'s form checks to begin with for the choice asked with `options`, or null when the page cannot tell
 * which field that is. The field is the one whose options omp lists first, in order (it adds an "Other" row and a "Done"
 * row at most); fields of the same options that check different ones cannot be told apart.
 */
export function formChoice(html: string | null, options: readonly string[] | undefined): string[] | null {
	if (!html || !options || typeof DOMParser === "undefined") return null;
	const doc = new DOMParser().parseFromString(html, "text/html");
	const root = doc.querySelector("form") ?? doc.body;
	const choices: Choice[] = [];
	const groups = new Map<string, HTMLInputElement[]>();
	for (const input of root.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')) {
		if (!input.name || input.disabled) continue;
		groups.set(input.name, [...(groups.get(input.name) ?? []), input]);
	}
	const labelOf = (input: HTMLInputElement) =>
		squeeze(input.closest("label")?.textContent ?? input.labels?.[0]?.textContent ?? "") || input.value;
	for (const inputs of groups.values())
		choices.push({
			labels: inputs.map(labelOf),
			checked: inputs.filter((i) => i.hasAttribute("checked")).map(labelOf),
		});
	for (const select of root.querySelectorAll("select")) {
		if (!select.name) continue;
		const opts = [...select.querySelectorAll("option")].filter((o) => !o.disabled);
		const name = (o: HTMLOptionElement) => squeeze(o.textContent ?? "") || o.value;
		choices.push({ labels: opts.map(name), checked: opts.filter((o) => o.hasAttribute("selected")).map(name) });
	}
	const found = choices.filter(
		(c) =>
			c.labels.length > 0 &&
			options.length - c.labels.length <= 2 &&
			c.labels.every((label, i) => options[i] === label),
	);
	if (found.length === 0) return null;
	const [first, ...rest] = found;
	return rest.every((c) => c.checked.join("\n") === first.checked.join("\n")) ? first.checked : null;
}

/** The ticks the page knows, by conversation and question. */
const ticks = new Map<string, Set<string>>();

const keyOf = (scope: string, question: string) => `${scope}\u0000${question}`;

/**
 * The options ticked in `dialog` (of `scope`: the conversation and its `ask` call), or null when the page cannot tell. Called
 * for each dialog of the loop: `checked` is omp's own `checkedIndices` (omp 18.20 and later), which is what is ticked;
 * without it the first dialog starts from what the form ticks.
 */
export function tickedIn(
	scope: string,
	dialog: CheckboxDialog,
	options: readonly string[],
	html: string | null,
	checked?: readonly number[],
): Set<string> | null {
	const key = keyOf(scope, dialog.question);
	if (checked) {
		const sent = new Set(checked.flatMap((i) => (options[i] === undefined ? [] : [options[i]])));
		ticks.set(key, sent);
		return sent;
	}
	let set = ticks.get(key);
	if (!set) {
		set = new Set(formChoice(html, options) ?? []);
		ticks.set(key, set);
	}
	if (set.size === dialog.count) return set;
	// The text of an "Other" may have been left empty: omp then counts it as not ticked.
	for (const label of set) {
		if (options.indexOf(label) !== options.length - 2) continue;
		set.delete(label);
		if (set.size === dialog.count) return set;
		set.add(label);
	}
	if (dialog.count === 0) {
		set.clear();
		return set;
	}
	return null;
}

/** The person picked `option` in `dialog`: omp ticks it, or unticks it if it was. The closing option ticks nothing. */
export function picked(scope: string, dialog: CheckboxDialog, option: string): void {
	if (option === dialog.done) {
		ticks.delete(keyOf(scope, dialog.question));
		return;
	}
	const key = keyOf(scope, dialog.question);
	const set = ticks.get(key) ?? new Set<string>();
	if (set.has(option)) set.delete(option);
	else set.add(option);
	ticks.set(key, set);
}

/**
 * The ticks the page holds for `dialog` now, without omp's count to check them by: for the moment between a pick and omp
 * asking again (the page shows the pick at once), when the count in the title is still the one before it.
 */
export function knownTicks(scope: string, dialog: CheckboxDialog): Set<string> {
	return new Set(ticks.get(keyOf(scope, dialog.question)));
}
