/**
 * A group of checkboxes in omp's `ask` form, asked over RPC: omp has no checkbox dialog to send, so it asks the same `select`
 * again and again (`tools/ask.ts`): each pick ticks or unticks that option, the title starts with how many are ticked
 * (`(2 selected) <question>`), and a last option ends it (`✔ Done selecting`). Which options are ticked is in omp's own
 * dialog state (`checkedIndices`) but not in the RPC frame, so a page that drew the options alone showed none ticked and
 * the person could not tell what a click had done.
 *
 * The page keeps the ticks itself: what the form ticks to begin with, then every pick it sends toggled. omp's count in the
 * title is the check: when the page's ticks do not add up to it (a page that opened in the middle of the questions, an
 * "Other" whose text was left empty), it shows no ticks rather than wrong ones.
 */

/** The option that ends omp's checkbox loop: its success mark (`✔`, `✓` or the theme's) and the words. */
const DONE = /^\S{1,3} Done selecting$/;
/** omp's count in front of the question while some are ticked. */
const COUNT = /^\((\d+) selected\) /;

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
	const count = COUNT.exec(title);
	return { question: count ? title.slice(count[0].length) : title, count: count ? Number(count[1]) : 0, done };
}

const squeeze = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The labels of the boxes `html`'s form ticks to begin with for `question` (the legend of their fieldset, or the label of
 * a lone checkbox), as omp names the options: their label text, squeezed.
 */
export function initiallyTicked(html: string | null, question: string): string[] {
	if (!html || typeof DOMParser === "undefined") return [];
	const doc = new DOMParser().parseFromString(html, "text/html");
	for (const set of doc.querySelectorAll("fieldset")) {
		const legend = set.querySelector("legend");
		if (!legend || squeeze(legend.textContent ?? "") !== question) continue;
		return [...set.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
			.filter((box) => box.hasAttribute("checked"))
			.map((box) => squeeze(box.closest("label")?.textContent ?? box.value));
	}
	return [];
}

/** The ticks the page knows, by conversation and question. */
const ticks = new Map<string, Set<string>>();

const keyOf = (scope: string, question: string) => `${scope}\u0000${question}`;

/**
 * The options ticked in `dialog` (of `scope`: the conversation and its `ask` call), or null when the page cannot tell. Called
 * for each dialog of the loop: the first one starts from what the form ticks.
 */
export function tickedIn(
	scope: string,
	dialog: CheckboxDialog,
	options: readonly string[],
	html: string | null,
): Set<string> | null {
	const key = keyOf(scope, dialog.question);
	let set = ticks.get(key);
	if (!set) {
		set = new Set(initiallyTicked(html, dialog.question).filter((label) => options.includes(label)));
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
