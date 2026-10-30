/**
 * Word-prediction ghost text (omp RPC `predict_word`). A ghost is the suffix
 * omp predicted for `base` (the composer text, caret at its end). Typing the
 * predicted characters keeps the rest of the ghost; typing anything else
 * rejects it; Tab/→ accept it. Accept and reject are both reported back to omp
 * (`predict_word_feedback`) so its predictor learns.
 */

export interface Ghost {
	base: string;
	suffix: string;
}

export interface GhostFeedback {
	text: string;
	cursor: number;
	suggestion: string;
	accepted: boolean;
}

function feedback(g: Ghost, accepted: boolean): GhostFeedback {
	return { text: g.base, cursor: g.base.length, suggestion: g.suffix, accepted };
}

/** The part of the ghost still to show for `text`, or null when the user has typed away from it. */
export function remaining(g: Ghost | null, text: string): string | null {
	if (!g || !text.startsWith(g.base)) return null;
	const typed = text.slice(g.base.length);
	if (typed.length >= g.suffix.length || !g.suffix.startsWith(typed)) return null;
	return g.suffix.slice(typed.length);
}

/** Reconcile the ghost with edited composer text. */
export function afterEdit(g: Ghost | null, text: string): { ghost: Ghost | null; feedback?: GhostFeedback } {
	if (!g) return { ghost: null };
	if (remaining(g, text) !== null) return { ghost: g };
	// Typing the whole prediction counts as accepting it.
	return { ghost: null, feedback: feedback(g, text === g.base + g.suffix) };
}

/** Accept the ghost: Tab adds a space after the word, → does not. */
export function accept(
	g: Ghost | null,
	text: string,
	withSpace: boolean,
): { text: string; feedback: GhostFeedback } | null {
	const rest = remaining(g, text);
	if (!g || rest === null) return null;
	return { text: text + rest + (withSpace ? " " : ""), feedback: feedback(g, true) };
}

/** Whether to ask omp for a prediction: caret at the end of a word being typed. */
export function wantsPrediction(text: string, caret: number): boolean {
	return caret === text.length && /\S$/.test(text) && !text.startsWith("/") && !text.startsWith("!");
}
