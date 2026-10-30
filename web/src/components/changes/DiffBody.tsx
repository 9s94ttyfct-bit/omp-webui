import type { DiffHunk, DiffRow, FileDiff } from "@shared/changes.ts";
import { FileMinus, FileQuestion } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { linesOfHighlighted, sideIndex, sideText, splitRows } from "../../lib/changes-rows.ts";
import { highlight, highlighted } from "../../lib/highlight.ts";
import { cx, Empty } from "../ui.tsx";

/** Text longer than this (both sides together) is shown plain: tokenising it is slow (see `FilePreview`). */
const MAX_HIGHLIGHT_CHARS = 150_000;
/** Rows drawn before "Show all": a change can be thousands of lines, and each is an element. */
const ROW_CAP = 400;

/** Lines of highlighted HTML, by side; null while they are made, or when the text is too large or the colours did not match the lines. */
interface Sides {
	old: string[] | null;
	new: string[] | null;
}
const PLAIN: Sides = { old: null, new: null };

/** What the body draws, in order: a hunk's header, and its rows (one by one, or in pairs side by side). */
type Item =
	| { kind: "hunk"; hunk: DiffHunk; key: string }
	| { kind: "row"; row: DiffRow; key: string }
	| { kind: "pair"; left?: DiffRow; right?: DiffRow; key: string };

/** The highlighted lines of `text`: null if it is empty or they are not one for each of its lines. */
async function linesOf(text: string, lang: string): Promise<string[] | null> {
	if (text === "") return null;
	const html = highlighted(text, lang) ?? (await highlight(text, lang));
	const lines = html === null ? null : linesOfHighlighted(html);
	return lines && lines.length === text.split("\n").length ? lines : null;
}

/** Both sides of the change, coloured by the file's language, once the worker has made them. */
function useSides(hunks: readonly DiffHunk[], lang: string): Sides {
	const oldText = useMemo(() => sideText(hunks, "old"), [hunks]);
	const newText = useMemo(() => sideText(hunks, "new"), [hunks]);
	const [sides, setSides] = useState<Sides>(PLAIN);
	useEffect(() => {
		let alive = true;
		if (oldText.length + newText.length > MAX_HIGHLIGHT_CHARS) {
			setSides(PLAIN);
			return;
		}
		void Promise.all([linesOf(oldText, lang), linesOf(newText, lang)]).then(
			([o, n]) => alive && setSides({ old: o, new: n }),
		);
		return () => {
			alive = false;
		};
	}, [oldText, newText, lang]);
	return sides;
}

/** The text of a row, coloured when its line has been. A line cut to the row limit is marked as cut. */
function Code({ row, html }: { row: DiffRow; html: string | undefined }) {
	const t = useT();
	return (
		<span className="whitespace-pre pr-3">
			{row.kind === "ctx" ? null : (
				<span className="sr-only">{row.kind === "add" ? t("files.rowAdded") : t("files.rowRemoved")}: </span>
			)}
			{html !== undefined ? (
				<span
					// biome-ignore lint/security/noDangerouslySetInnerHtml: shiki escapes the code it highlights
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			) : (
				row.text
			)}
			{row.clipped ? (
				<span className="text-faint" title={t("files.rowClipped")}>
					…
				</span>
			) : null}
		</span>
	);
}

const SIGN = { add: "+", del: "-", ctx: "" } as const;
const TINT = { add: "bg-success/15", del: "bg-danger/15", ctx: "" } as const;

/** A hunk's header: where it is in the file, and the function git says it is in. */
function HunkHeader({ hunk, wide }: { hunk: DiffHunk; wide: boolean }) {
	return (
		<div
			className={cx(
				"flex min-w-full items-center gap-2 border-y border-border/60 bg-hover/50 px-2 py-0.5 text-faint",
				wide && "col-span-2",
			)}
			data-testid="changes-hunk"
		>
			<span className="tabular-nums">{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`}</span>
			{hunk.section ? <span className="truncate">{hunk.section}</span> : null}
		</div>
	);
}

const NUM = "w-10 shrink-0 select-none pr-2 text-right tabular-nums text-faint";

/** One row of the unified view: old and new line numbers, a sign, the text. */
function UnifiedRow({ row, html }: { row: DiffRow; html: string | undefined }) {
	return (
		<div className={cx("flex", TINT[row.kind])} data-testid="changes-row" data-change={row.kind}>
			<span className={NUM}>{row.old}</span>
			<span className={NUM}>{row.new}</span>
			<span className="w-3 shrink-0 select-none text-center font-bold text-fg" aria-hidden="true">
				{SIGN[row.kind]}
			</span>
			<Code row={row} html={html} />
		</div>
	);
}

/** One side of a row of the split view (nothing is on the side that had no line to pair with). */
function Half({ row, html, side }: { row: DiffRow | undefined; html: string | undefined; side: "old" | "new" }) {
	if (!row) return <div className="flex bg-hover/30" data-side={side} />;
	return (
		<div className={cx("flex min-w-0", TINT[row.kind])} data-side={side} data-change={row.kind}>
			<span className={NUM}>{side === "old" ? row.old : row.new}</span>
			<span className="w-3 shrink-0 select-none text-center font-bold text-fg" aria-hidden="true">
				{SIGN[row.kind]}
			</span>
			<Code row={row} html={html} />
		</div>
	);
}

/**
 * The change of one file as rows: unified (one column, old and new numbers) or split (the old file on the left, the new one
 * on the right), coloured by the file's language. Every change is tinted and also carries its sign as text, so that colour
 * is never the only cue.
 */
export const DiffBody = memo(function DiffBody({
	diff,
	split,
	lang,
}: {
	diff: FileDiff;
	split: boolean;
	lang: string;
}) {
	const t = useT();
	const [all, setAll] = useState(false);
	const sides = useSides(diff.hunks, lang);
	// The colours of each row's line: removed lines are on the old side, the rest on the new one.
	const htmlOf = useMemo(() => {
		const out = new Map<DiffRow, string | undefined>();
		const oldAt = sideIndex(diff.hunks, "old");
		const newAt = sideIndex(diff.hunks, "new");
		let i = 0;
		for (const hunk of diff.hunks) {
			for (const row of hunk.rows) {
				out.set(row, row.kind === "del" ? sides.old?.[oldAt[i] as number] : sides.new?.[newAt[i] as number]);
				i++;
			}
		}
		return out;
	}, [diff.hunks, sides]);

	const total = diff.hunks.reduce((n, h) => n + h.rows.length, 0);
	const items = useMemo<Item[]>(
		() =>
			diff.hunks.flatMap((hunk, h): Item[] => [
				{ kind: "hunk", hunk, key: `h${h}` },
				...(split
					? splitRows(hunk.rows).map((pair, r): Item => ({ kind: "pair", ...pair, key: `${h}:${r}` }))
					: hunk.rows.map((row, r): Item => ({ kind: "row", row, key: `${h}:${r}` }))),
			]),
		[diff.hunks, split],
	);
	const nodes = (all ? items : items.slice(0, ROW_CAP)).map((item) => {
		if (item.kind === "hunk") return <HunkHeader key={item.key} hunk={item.hunk} wide={split} />;
		if (item.kind === "row") return <UnifiedRow key={item.key} row={item.row} html={htmlOf.get(item.row)} />;
		return (
			<div key={item.key} className="contents" data-testid="changes-row">
				<Half row={item.left} html={item.left && htmlOf.get(item.left)} side="old" />
				<Half row={item.right} html={item.right && htmlOf.get(item.right)} side="new" />
			</div>
		);
	});
	return (
		<div data-testid="changes-diff-body" data-layout={split ? "split" : "unified"}>
			<section
				className="overflow-x-auto bg-code py-1 font-mono text-xs leading-relaxed"
				// A long line scrolls this box sideways: it must take the focus to be scrolled by keys (axe's
				// `scrollable-region-focusable`, and a keyboard user reaching the end of a wide row).
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must take the focus to be scrolled by keys
				tabIndex={0}
				aria-label={t("files.diffScroll")}
			>
				<div
					className={cx(
						"w-max min-w-full",
						split && "grid grid-cols-[minmax(18rem,1fr)_minmax(18rem,1fr)] divide-x divide-border/60",
					)}
				>
					{nodes}
				</div>
			</section>
			{items.length > ROW_CAP ? (
				<button
					type="button"
					className="m-2 inline-flex min-h-6 items-center text-xs text-accent hover:underline"
					data-testid="changes-show-all"
					onClick={() => setAll((a) => !a)}
				>
					{all ? t("files.diffShowLess") : t("files.diffShowAll", { n: total.toLocaleString() })}
				</button>
			) : null}
			{diff.truncated ? (
				<div className="px-3 py-2 text-xs text-faint" data-testid="changes-truncated">
					{t("files.diffTruncated", { n: total.toLocaleString() })}
				</div>
			) : null}
		</div>
	);
});

/** What a change that has no lines to draw says: a file git does not compare as text, one with only a new mode, a link. */
export function DiffNote({ diff }: { diff: FileDiff }) {
	const t = useT();
	if (diff.view === "binary") {
		return (
			<Empty icon={<FileQuestion size={22} />} title={t("files.diffBinaryTitle")}>
				{t("files.diffBinaryBody")}
			</Empty>
		);
	}
	if (diff.view === "unreadable") {
		return (
			<Empty icon={<FileMinus size={22} />} title={t("files.diffBinaryTitle")}>
				{diff.reason === "link" ? t("files.diffUnreadableLink") : t("files.diffUnreadableOther")}
			</Empty>
		);
	}
	return (
		<Empty icon={<FileMinus size={22} />} title={t("files.diffEmptyTitle")}>
			{t("files.diffEmptyBody")}
		</Empty>
	);
}
