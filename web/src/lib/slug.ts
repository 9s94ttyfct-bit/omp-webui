/**
 * The ids GitHub gives the headings of a Markdown file, so that a link to a section (`#install`, `guide.md#install`) finds
 * the heading in the Markdown editor's preview as it does on GitHub: the text lowercased, everything but letters, marks,
 * digits, `_`, `-` and spaces taken out, each space a `-` (github-slugger's rule), and a repeated one numbered (`-1`, `-2`).
 * On the page the id carries GitHub's `user-content-` prefix, which keeps a file's ids from clashing with the app's own;
 * a link names the section without it.
 */

/** What GitHub puts in front of the ids made from a file's text. */
export const SECTION_PREFIX = "user-content-";

/** The slug of one heading's text, before it is made unique. */
export function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
		.replace(/ /g, "-");
}

/** The slugs of one text's headings, in order: one seen before is numbered, and never takes a slug already given. */
export class Slugger {
	private readonly seen = new Map<string, number>();

	slug(text: string): string {
		const first = slug(text);
		let result = first;
		while (this.seen.has(result)) {
			const n = (this.seen.get(first) ?? 0) + 1;
			this.seen.set(first, n);
			result = `${first}-${n}`;
		}
		this.seen.set(result, 0);
		return result;
	}
}

/**
 * The ids a link's fragment (`install`, already decoded) may name on the page, in the order they are looked for: GitHub's
 * prefixed id, then the fragment as it is (a link written with the prefix, or an id of the file's own), each also lowercased.
 */
export function sectionIds(fragment: string): string[] {
	const ids = [`${SECTION_PREFIX}${fragment}`, fragment];
	for (const id of [...ids]) {
		const lower = id.toLowerCase();
		if (!ids.includes(lower)) ids.push(lower);
	}
	return ids;
}

/** The element of `root` a link's fragment names (see `sectionIds`), or null. */
export function findSection(root: ParentNode, fragment: string): HTMLElement | null {
	const byId = new Map<string, HTMLElement>();
	for (const el of root.querySelectorAll<HTMLElement>("[id]")) if (!byId.has(el.id)) byId.set(el.id, el);
	for (const id of sectionIds(fragment)) {
		const el = byId.get(id);
		if (el) return el;
	}
	return null;
}
