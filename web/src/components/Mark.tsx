import type { ReactNode } from "react";

/**
 * A text with the characters a search matched marked, as the scorer gives them back (code-unit indices, the same
 * indices `slice` uses). Everything else is the text as it is written; a run of marked characters is one element, so a
 * name is not cut into one element per letter.
 */
export function Mark({ text, positions }: { text: string; positions: readonly number[] }) {
	if (positions.length === 0) return <>{text}</>;
	const marked = new Set(positions.filter((i) => i >= 0 && i < text.length));
	if (marked.size === 0) return <>{text}</>;
	const out: ReactNode[] = [];
	let start = 0;
	let on = marked.has(0);
	// One step past the end closes the last run, whatever it is: the end of the text is not a mark.
	for (let i = 1; i <= text.length; i++) {
		const next = i < text.length && marked.has(i);
		// The end of the text always closes the run it is in: it is not a mark, and the text after the last one is text.
		if (i < text.length && next === on) continue;
		const piece = text.slice(start, i);
		out.push(
			on ? (
				<mark key={start} className="bg-transparent font-semibold text-fg">
					{piece}
				</mark>
			) : (
				piece
			),
		);
		start = i;
		on = next;
	}
	return <>{out}</>;
}
