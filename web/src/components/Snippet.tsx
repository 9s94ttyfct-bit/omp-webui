import { Fragment } from "react";

const MATCH_START = "\u0002";
const MATCH_END = "\u0003";

/**
 * A line of a message found by the search, with what matched marked: the server wraps each match in STX…ETX control
 * characters. The palette's message hits and the sidebar's content matches (#717) show it alike.
 */
export function Snippet({ text }: { text: string }) {
	const parts: { text: string; match: boolean }[] = [];
	let rest = text;
	for (;;) {
		const s = rest.indexOf(MATCH_START);
		const e = s < 0 ? -1 : rest.indexOf(MATCH_END, s);
		if (e < 0) {
			if (rest) parts.push({ text: rest.replaceAll(MATCH_START, ""), match: false });
			break;
		}
		if (s > 0) parts.push({ text: rest.slice(0, s), match: false });
		parts.push({ text: rest.slice(s + 1, e), match: true });
		rest = rest.slice(e + 1);
	}
	return (
		<>
			{parts.map((p, i) =>
				p.match ? (
					// The text in the page's own colour, the tint behind it the mark: accent on its tint under a picked row is 4.4:1.
					// biome-ignore lint/suspicious/noArrayIndexKey: parts of one immutable string
					<mark key={i} className="rounded bg-accent-soft px-0.5 text-fg">
						{p.text}
					</mark>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: parts of one immutable string
					<Fragment key={i}>{p.text}</Fragment>
				),
			)}
		</>
	);
}
