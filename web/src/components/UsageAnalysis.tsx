import type { SessionSummary } from "@shared/protocol.ts";
import type { UsageConversation, UsageError, UsageHour, UsageTool } from "@shared/usage-analysis.ts";
import { ArrowDown, ArrowUp } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import type { StatsBucket } from "../lib/api.ts";
import { costColumn, fmtClock, fmtCost, fmtCostExact, fmtDuration, fmtTokens } from "../lib/format.ts";
import type { ProjectLabel } from "../lib/usage-projects.ts";
import { cx } from "./ui.tsx";

/**
 * The parts of Usage & cost that omp's own answer has none for (`shared/usage-analysis.ts`): the conversations, tools and
 * errors of the range, how the models compare, and when in the day the requests were made. Each is left out by the page
 * when the server could not read it.
 */

/** A card of the page with a title over its body, as the tables of `UsagePage` are. */
function Card({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
	return (
		// `min-w-0` and `overflow-hidden`: see `BucketTable`, whose card this is.
		<section
			className="@container min-w-0 overflow-hidden rounded-2xl border border-border bg-surface"
			data-testid={id}
		>
			<h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">
				{title}
				{note ? <span className="ml-2 font-normal text-muted">{note}</span> : null}
			</h2>
			{children}
		</section>
	);
}

/**
 * The costliest conversations of the range (#714 counted them over all time from the conversation list; omp's database
 * says what each spent in the range). A row opens its conversation; one that is no longer in the list (deleted) is
 * shown, and says so, without opening anything.
 */
export function RangeConversations({
	rows,
	sessions,
	sessionsLoaded,
	projects,
	onOpen,
}: {
	rows: UsageConversation[];
	sessions: SessionSummary[];
	sessionsLoaded: boolean;
	projects: Map<string, ProjectLabel>;
	onOpen: (file: string) => void;
}) {
	const t = useT();
	const byFile = useMemo(() => new Map(sessions.map((s) => [s.file, s])), [sessions]);
	const money = useMemo(() => costColumn(rows.map((r) => r.cost)), [rows]);
	if (!rows.length) return null;
	return (
		<Card id="usage-conversations" title={t("pages.usageTopSessions")}>
			<ul className="divide-y divide-border">
				{rows.map((r) => {
					const s = byFile.get(r.file);
					// Until the list has loaded, a conversation is taken for one in it: opening it shows it, or says why not.
					const gone = sessionsLoaded && !s;
					const project = s ? { label: s.project, title: s.cwd } : projects.get(r.folder);
					const name = s
						? s.title || s.preview || t("pages.usageUntitled")
						: (r.file.split(/[\\/]/).pop() ?? r.file).replace(/\.jsonl$/, "");
					const split = [
						r.subagentCost > 0 ? t("pages.usageSessionSubagents", { cost: fmtCost(r.subagentCost) }) : "",
						r.advisorCost > 0 ? t("pages.usageSessionAdvisor", { cost: fmtCost(r.advisorCost) }) : "",
					].filter(Boolean);
					const cells = (
						<>
							<span className="min-w-0">
								<span className={cx("block truncate", gone && "text-muted")} title={gone ? r.file : undefined}>
									{name}
								</span>
								<span className="block truncate text-xs text-faint">
									<span data-testid="usage-session-models">{r.models.join(", ")}</span>
									{split.length ? <span data-testid="usage-session-split"> · {split.join(" · ")}</span> : null}
									{gone ? <span> · {t("pages.usageSessionGone")}</span> : null}
								</span>
							</span>
							<span
								className="hidden truncate text-xs text-faint sm:block"
								title={project?.title}
								data-testid="usage-session-project"
							>
								{project?.label}
							</span>
							<span
								className="hidden text-right text-xs tabular-nums text-muted sm:block"
								data-testid="usage-session-requests"
							>
								{r.requests.toLocaleString()}
							</span>
							<span className="text-right text-xs tabular-nums text-muted" data-testid="usage-session-tokens">
								{fmtTokens(r.tokens)}
							</span>
							<span
								className="text-right font-medium tabular-nums"
								title={fmtCostExact(r.cost)}
								data-testid="usage-session-cost"
								data-cost={r.cost}
							>
								{money(r.cost)}
							</span>
						</>
					);
					const grid =
						"grid w-full grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] items-center gap-x-3 px-4 py-2 text-left text-sm sm:grid-cols-[minmax(0,1fr)_7rem_4rem_4.5rem_5.5rem]";
					return (
						<li key={r.file}>
							{gone ? (
								<div className={grid} data-testid="usage-session" data-file={r.file}>
									{cells}
								</div>
							) : (
								<button
									type="button"
									className={cx(grid, "hover:bg-hover/50")}
									data-testid="usage-session"
									data-file={r.file}
									onClick={() => onOpen(r.file)}
								>
									{cells}
								</button>
							)}
						</li>
					);
				})}
			</ul>
		</Card>
	);
}

interface Column {
	id: string;
	label: MessageKey;
	/** The model's figure; null for one that has none (no timing recorded, nothing read), shown as "–" and sorted last. */
	value: (b: StatsBucket) => number | null;
	format: (v: number) => string;
	/** The sort a first click on the column asks for: the cheap and fast first, which is what a comparison is for. */
	first: "asc" | "desc";
	/** Given up in a narrow card (a phone), as the other tables give up their Cache R/W. */
	wide?: boolean;
}

const COLUMNS: Column[] = [
	{
		id: "requests",
		label: "pages.usageColRequests",
		value: (b) => b.totalRequests,
		format: (v) => v.toLocaleString(),
		first: "desc",
	},
	{
		id: "perRequest",
		label: "pages.usageColPerRequest",
		value: (b) => (b.totalRequests ? b.totalCost / b.totalRequests : null),
		format: fmtCost,
		first: "asc",
	},
	{
		id: "perMillion",
		label: "pages.usageColPerMillion",
		value: (b) => {
			const tokens = b.totalInputTokens + b.totalOutputTokens + b.totalCacheReadTokens + b.totalCacheWriteTokens;
			return tokens ? (b.totalCost / tokens) * 1_000_000 : null;
		},
		format: fmtCost,
		first: "asc",
	},
	{
		id: "cacheHit",
		label: "pages.usageColCacheHit",
		// omp's cache rate, or the same figure from the tokens where omp sends none (see `cacheRateOf`).
		value: (b) => {
			const read = b.totalInputTokens + b.totalCacheReadTokens;
			return b.cacheRate ?? (read > 0 ? b.totalCacheReadTokens / read : null);
		},
		format: (v) => `${Math.round(v * 100)}%`,
		first: "desc",
		wide: true,
	},
	{
		id: "speed",
		label: "pages.usageColSpeed",
		value: (b) => b.avgTokensPerSecond || null,
		format: (v) => String(Math.round(v)),
		first: "desc",
		wide: true,
	},
	{
		id: "ttft",
		label: "pages.usageColTtft",
		value: (b) => b.avgTtft || null,
		format: fmtDuration,
		first: "asc",
		wide: true,
	},
	{
		id: "errors",
		label: "pages.usageColErrorShare",
		value: (b) => (b.totalRequests ? b.errorRate : null),
		format: (v) => `${(v * 100).toFixed(1)}%`,
		first: "asc",
	},
];

/**
 * The models side by side by what a request of each costs, how much a million of its tokens cost, how much of its input
 * came from the cache, how fast it writes and starts, and how often it failed. Any column sorts it.
 */
export function ModelComparison({ rows }: { rows: StatsBucket[] }) {
	const t = useT();
	const [sort, setSort] = useState<{ id: string; dir: "asc" | "desc" }>({ id: "requests", dir: "desc" });
	const sorted = useMemo(() => {
		const col = COLUMNS.find((c) => c.id === sort.id) ?? COLUMNS[0];
		const sign = sort.dir === "asc" ? 1 : -1;
		return [...rows].sort((a, b) => {
			const x = col.value(a);
			const y = col.value(b);
			// A model without the figure is last whichever way the column sorts: it is not the best nor the worst.
			if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
			return sign * (x - y) || b.totalRequests - a.totalRequests;
		});
	}, [rows, sort]);
	if (rows.length < 2) return null;
	const pick = (c: Column) =>
		setSort((s) => (s.id === c.id ? { id: c.id, dir: s.dir === "asc" ? "desc" : "asc" } : { id: c.id, dir: c.first }));
	return (
		<Card id="usage-model-compare" title={t("pages.usageModelCompare")}>
			<div className="overflow-x-auto">
				<table className="w-full text-sm" data-testid="table-model-compare">
					<thead className="whitespace-nowrap text-left text-xs text-faint">
						<tr>
							<th className="px-4 py-2 font-medium">{t("pages.usageColModel")}</th>
							{COLUMNS.map((c) => {
								const on = sort.id === c.id;
								return (
									<th
										key={c.id}
										aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
										className={cx("px-2 py-2 text-right font-medium last:pr-4", c.wide && "@max-xl:hidden")}
									>
										<button
											type="button"
											className={cx("inline-flex items-center gap-1 hover:text-fg", on && "text-fg")}
											data-testid={`compare-sort-${c.id}`}
											onClick={() => pick(c)}
										>
											{t(c.label)}
											{on ? sort.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : null}
										</button>
									</th>
								);
							})}
						</tr>
					</thead>
					<tbody className="divide-y divide-border">
						{sorted.map((b) => (
							<tr key={`${b.provider}/${b.model}`} className="hover:bg-hover/50" data-testid="compare-row">
								<td className="max-w-64 truncate px-4 py-2 @max-xl:max-w-36" title={`${b.provider}/${b.model}`}>
									{b.model}
								</td>
								{COLUMNS.map((c) => {
									const v = c.value(b);
									return (
										<td
											key={c.id}
											className={cx("px-2 py-2 text-right tabular-nums last:pr-4", c.wide && "@max-xl:hidden")}
											data-col={c.id}
											data-value={v ?? ""}
										>
											{v === null ? "–" : c.format(v)}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</Card>
	);
}

/** The tools called in the range, the most called first, with how often each failed and how much a result holds. */
export function ToolsTable({ rows }: { rows: UsageTool[] }) {
	const t = useT();
	return (
		<Card id="usage-tools" title={t("pages.usageTools")}>
			{rows.length ? (
				<div className="max-h-96 overflow-auto">
					<table className="w-full whitespace-nowrap text-sm" data-testid="table-tools">
						<thead className="sticky top-0 bg-surface text-left text-xs text-faint">
							<tr>
								<th className="px-4 py-2 font-medium">{t("pages.usageColTool")}</th>
								<th className="px-2 py-2 text-right font-medium">{t("pages.usageColCalls")}</th>
								<th className="px-2 py-2 text-right font-medium">{t("pages.usageColErrors")}</th>
								<th className="px-2 py-2 text-right font-medium">{t("pages.usageColErrorShare")}</th>
								<th className="px-4 py-2 text-right font-medium">{t("pages.usageColAvgResult")}</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border">
							{rows.map((r) => (
								<tr key={r.tool} className="hover:bg-hover/50" data-testid="tool-row">
									<td className="max-w-48 truncate px-4 py-2" title={r.tool}>
										{r.tool}
									</td>
									<td className="px-2 py-2 text-right tabular-nums">{r.calls.toLocaleString()}</td>
									<td className="px-2 py-2 text-right tabular-nums">{r.errors.toLocaleString()}</td>
									<td className="px-2 py-2 text-right tabular-nums">
										{r.errorRate === null ? "–" : `${(r.errorRate * 100).toFixed(1)}%`}
									</td>
									<td className="px-4 py-2 text-right tabular-nums">
										{r.avgResultChars === null ? "–" : t("pages.usageChars", { n: fmtTokens(r.avgResultChars) })}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="px-4 py-3 text-sm text-muted">{t("pages.usageNoTools")}</p>
			)}
		</Card>
	);
}

/** The most frequent error messages of the range, by model, with how often and when last. */
export function ErrorsTable({ rows }: { rows: UsageError[] }) {
	const t = useT();
	return (
		<Card id="usage-errors" title={t("pages.usageErrorsTitle")}>
			{rows.length ? (
				<div className="max-h-96 overflow-auto">
					<table className="w-full table-fixed text-sm" data-testid="table-errors">
						<thead className="sticky top-0 whitespace-nowrap bg-surface text-left text-xs text-faint">
							<tr>
								<th className="px-4 py-2 font-medium">{t("pages.usageColMessage")}</th>
								<th className="w-16 px-2 py-2 text-right font-medium">{t("pages.usageColCount")}</th>
								<th className="w-32 px-4 py-2 text-right font-medium">{t("pages.usageColLastSeen")}</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border">
							{rows.map((r) => (
								<tr
									key={`${r.provider}\0${r.model}\0${r.message}`}
									className="hover:bg-hover/50"
									data-testid="error-row"
								>
									<td className="px-4 py-2">
										<span className={cx("block truncate", !r.message && "text-muted")} title={r.message ?? undefined}>
											{r.message || t("pages.usageNoMessage")}
										</span>
										<span className="block truncate text-xs text-faint" title={`${r.provider}/${r.model}`}>
											{r.model}
										</span>
									</td>
									<td className="px-2 py-2 text-right tabular-nums">{r.count.toLocaleString()}</td>
									<td className="px-4 py-2 text-right text-xs tabular-nums text-muted">{fmtClock(r.lastTimestamp)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="px-4 py-3 text-sm text-muted">{t("pages.usageNoErrors")}</p>
			)}
		</Card>
	);
}

const clock = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

/**
 * One row of the heat strip: the 24 hours of the day, each as dark as its share of the busiest hour. The hour's figures
 * are its label, read on hover and by a screen reader.
 */
function Strip({
	id,
	label,
	hours,
	value,
	describe,
}: {
	id: string;
	label: string;
	hours: UsageHour[];
	value: (h: UsageHour) => number;
	describe: (h: UsageHour) => string;
}) {
	const top = Math.max(0, ...hours.map(value));
	return (
		<div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3">
			<span className="text-xs text-muted">{label}</span>
			<ol className="m-0 grid list-none grid-cols-24 gap-0.5 p-0" data-testid={`hours-${id}`}>
				{hours.map((h) => {
					const v = value(h);
					const share = top > 0 ? v / top : 0;
					return (
						<li
							key={h.hour}
							className="h-6 rounded-xs"
							title={describe(h)}
							aria-label={describe(h)}
							data-hour={h.hour}
							data-value={v}
							style={{
								background:
									v > 0
										? `color-mix(in srgb, var(--accent) ${Math.round(15 + share * 85)}%, var(--surface))`
										: "var(--hover)",
							}}
						/>
					);
				})}
			</ol>
		</div>
	);
}

/** When in the day the requests of the range were made, and what they cost, in the page's own time zone. */
export function TimeOfDay({ hours, timeZone }: { hours: UsageHour[]; timeZone: string }) {
	const t = useT();
	const describe = (h: UsageHour) =>
		t("pages.usageHourCell", {
			from: clock(h.hour),
			to: clock(h.hour + 1),
			requests: h.requests.toLocaleString(),
			cost: fmtCost(h.cost),
		});
	return (
		<Card id="usage-hours" title={t("pages.usageHours")} note={timeZone}>
			<div className="space-y-1.5 px-4 py-3">
				<Strip
					id="requests"
					label={t("pages.usageRequests")}
					hours={hours}
					value={(h) => h.requests}
					describe={describe}
				/>
				<Strip id="cost" label={t("pages.usageColCost")} hours={hours} value={(h) => h.cost} describe={describe} />
				<div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 text-xs text-faint" aria-hidden>
					<span />
					<div className="grid grid-cols-4">
						{[0, 6, 12, 18].map((h) => (
							<span key={h}>{clock(h)}</span>
						))}
					</div>
				</div>
			</div>
		</Card>
	);
}
