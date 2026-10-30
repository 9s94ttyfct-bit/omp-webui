import { type ReactNode, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { type DiffRow, splitPath } from "../lib/diff.ts";
import { useScrolls } from "../lib/scrolls.ts";
import { CopyButton } from "./Markdown.tsx";
import { cx } from "./ui.tsx";

/** Rows rendered before "Show all": real diffs reach thousands of lines. */
const ROW_CAP = 300;

const SIGN = { add: "+", del: "-", ctx: "" } as const;

/** A path with its directory dimmed and truncated first, so the file name always stays readable. */
export function PathLabel({ path, className }: { path: string; className?: string }) {
	const { dir, name } = splitPath(path);
	return (
		<span
			data-testid="tool-path"
			title={path}
			className={cx("flex min-w-0 items-baseline font-mono text-xs", className)}
		>
			{dir ? <span className="min-w-0 truncate text-faint">{dir}</span> : null}
			<span className="max-w-[75%] shrink-0 truncate font-medium text-fg">{name}</span>
		</span>
	);
}

interface DiffViewProps {
	rows: DiffRow[];
	/** What the copy button puts on the clipboard. */
	copyText: string;
	title: string;
	/** Names the file when a card shows several. */
	label?: ReactNode;
}

/**
 * Rows with a line-number gutter. A change is tinted AND carries its `+`/`-` as text (plus a hidden
 * "added"/"removed" for screen readers), so colour is never the only cue. Context rows are untinted,
 * which is also how written file content (nothing known to be new) is listed.
 */
export function DiffView({ rows, copyText, title, label }: DiffViewProps) {
	const t = useT();
	const [full, setFull] = useState(false);
	const [scrollRef, scrolls] = useScrolls<HTMLDivElement>();
	const shown = full || rows.length <= ROW_CAP ? rows : rows.slice(0, ROW_CAP);
	return (
		<div data-testid="diff-view">
			<div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wide text-faint">
				<span className="flex min-w-0 items-center gap-2">
					{title}
					{label}
				</span>
				<CopyButton text={copyText} label={t("chat.toolCopy", { title: title.toLowerCase() })} />
			</div>
			<div
				ref={scrollRef}
				// A box that scrolls is reached and scrolled from the keyboard; one that does not is no stop on the way.
				tabIndex={scrolls ? 0 : undefined}
				className="max-h-96 overflow-auto rounded-lg bg-code py-1 font-mono text-xs leading-relaxed"
			>
				<div className="w-max min-w-full">
					{shown.map((row, i) =>
						row.kind === "gap" ? (
							<hr
								// biome-ignore lint/suspicious/noArrayIndexKey: rows are a static list, never reordered
								key={i}
								data-testid="diff-gap"
								className="my-1 border-t border-dashed border-border"
							/>
						) : (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: rows are a static list, never reordered
								key={i}
								data-testid="diff-row"
								data-change={row.kind}
								className={cx("flex", row.kind === "add" && "bg-success/15", row.kind === "del" && "bg-danger/15")}
							>
								<span
									data-testid="diff-gutter"
									className="w-16 shrink-0 select-none pr-2 text-right tabular-nums text-muted"
								>
									{row.line}
									<span className="inline-block w-3 text-center font-bold text-fg" aria-hidden="true">
										{SIGN[row.kind]}
									</span>
								</span>
								<span className="whitespace-pre pr-3">
									{row.kind === "ctx" ? null : (
										<span className="sr-only">
											{row.kind === "add" ? t("chat.toolRowAdded") : t("chat.toolRowRemoved")}:{" "}
										</span>
									)}
									{row.text}
								</span>
							</div>
						),
					)}
				</div>
			</div>
			{rows.length > ROW_CAP ? (
				<button
					type="button"
					className="inline-flex min-h-6 items-center text-xs text-accent hover:underline"
					onClick={() => setFull((f) => !f)}
				>
					{full ? t("chat.toolShowLess") : t("chat.toolShowAllLines", { n: rows.length.toLocaleString() })}
				</button>
			) : null}
		</div>
	);
}
