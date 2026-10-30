import type { DiffHunk, DiffRow } from "@shared/changes.ts";

/**
 * What the Changes view draws of a diff, as rows: a hunk's rows side by side (a run of removed lines next to the run of
 * added lines that follows it, the way a split diff pairs them), and the lines of the highlighted text of each side.
 */

/** One row of the split view: what is on the left (the old file), what is on the right (the new one). */
export interface SplitRow {
	left?: DiffRow;
	right?: DiffRow;
}

/** The rows of a hunk side by side. A context row is on both sides; removed lines meet the added lines after them, one for one. */
export function splitRows(rows: readonly DiffRow[]): SplitRow[] {
	const out: SplitRow[] = [];
	let i = 0;
	while (i < rows.length) {
		const row = rows[i] as DiffRow;
		if (row.kind === "ctx") {
			out.push({ left: row, right: row });
			i++;
			continue;
		}
		const removed: DiffRow[] = [];
		const added: DiffRow[] = [];
		while (i < rows.length && (rows[i] as DiffRow).kind === "del") removed.push(rows[i++] as DiffRow);
		while (i < rows.length && (rows[i] as DiffRow).kind === "add") added.push(rows[i++] as DiffRow);
		for (let n = 0; n < Math.max(removed.length, added.length); n++) out.push({ left: removed[n], right: added[n] });
	}
	return out;
}

/** The text of one side of a diff, hunk after hunk: the old file's lines (context and removed) or the new one's (context and added). */
export function sideText(hunks: readonly DiffHunk[], side: "old" | "new"): string {
	const keep = side === "old" ? "del" : "add";
	return hunks.flatMap((h) => h.rows.filter((r) => r.kind === "ctx" || r.kind === keep).map((r) => r.text)).join("\n");
}

/**
 * Where each row's line is in the text `sideText` makes: for every row of the hunks, in order, the index among that side's
 * lines (or -1 when the row is not on that side).
 */
export function sideIndex(hunks: readonly DiffHunk[], side: "old" | "new"): number[] {
	const keep = side === "old" ? "del" : "add";
	let n = 0;
	return hunks.flatMap((h) => h.rows.map((r) => (r.kind === "ctx" || r.kind === keep ? n++ : -1)));
}

/**
 * The lines of highlighted code (shiki's `<pre><code><span class="line">…</span>\n…</code></pre>`) as the HTML inside each
 * line's span, in order. Null for anything that is not that shape.
 */
export function linesOfHighlighted(html: string): string[] | null {
	const start = html.indexOf("<code>");
	const end = html.lastIndexOf("</code>");
	if (start < 0 || end < start) return null;
	const lines = html.slice(start + "<code>".length, end).split("\n");
	const open = '<span class="line">';
	const out: string[] = [];
	for (const line of lines) {
		if (!line.startsWith(open) || !line.endsWith("</span>")) return null;
		out.push(line.slice(open.length, -"</span>".length));
	}
	return out;
}
