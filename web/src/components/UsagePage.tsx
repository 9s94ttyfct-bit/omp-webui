import { PREF } from "@shared/prefs.ts";
import type { SessionSummary } from "@shared/protocol.ts";
import { DEFAULT_USAGE_RANGE, isUsageRange, USAGE_RANGES, type UsageRange } from "@shared/usage-range.ts";
import { BarChart3, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Legend,
	ResponsiveContainer,
	Tooltip,
	type TooltipContentProps,
	XAxis,
	YAxis,
} from "recharts";
import { useShallow } from "zustand/react/shallow";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { api, type OmpStats, type StatsBucket } from "../lib/api.ts";
import { costColumn, fmtCost, fmtCostExact, fmtDuration, fmtTime, fmtTokens } from "../lib/format.ts";
import { setPref } from "../lib/prefs.ts";
import { advisorUsageOf } from "../lib/totals.ts";
import { projectLabels } from "../lib/usage-projects.ts";
import { dailyByModel, OTHER_MODELS, paddedDays, seriesColor, utcDate } from "../lib/usage-series.ts";
import { useApp } from "../store/app.ts";
import { Button, cx, Empty, Spinner, Tip } from "./ui.tsx";

/**
 * What a day's bar says on hover: the day, then each model's cost with a swatch of its colour. The names are in the
 * page's ink, not in the series colour (which is only a fill, not made to be read as text).
 */
function DailyTooltip({ active, payload, label }: TooltipContentProps) {
	if (!active || !payload?.length) return null;
	const lines = payload.filter((p) => Number(p.value) > 0).reverse();
	return (
		<div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg" data-testid="daily-tooltip">
			<div className="mb-1 font-medium text-fg">{label}</div>
			<ul className="space-y-0.5">
				{lines.map((p) => (
					<li key={String(p.dataKey)} className="flex items-center gap-2">
						<span aria-hidden className="size-2.5 shrink-0 rounded-xs" style={{ background: p.color ?? p.fill }} />
						<span className="text-muted">{p.name}</span>
						<span className="ml-auto pl-4 tabular-nums text-fg">{fmtCost(Number(p.value))}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function Stat({
	id,
	label,
	value,
	sub,
	exact,
	dim,
}: {
	id: string;
	label: string;
	value: string;
	sub?: string;
	exact?: string;
	/** The value is no figure but the lack of one: it is set back, not read as a measurement. */
	dim?: boolean;
}) {
	const body = (
		<div className="rounded-2xl border border-border bg-surface p-4">
			<div className="text-xs text-muted">{label}</div>
			<div
				className={cx("mt-1 text-2xl font-semibold tabular-nums tracking-tight", dim && "text-faint")}
				data-stat={id}
			>
				{value}
			</div>
			{sub ? <div className="mt-0.5 text-xs text-faint">{sub}</div> : null}
		</div>
	);
	return exact ? <Tip label={exact}>{body}</Tip> : body;
}

/**
 * A bucket's cache rate: omp's, or, where omp sends none (it sends none by agent type), the same figure from the bucket's
 * tokens (cache reads of what was read: `cacheRead / (input + cacheRead)`). "–" for a bucket that read nothing.
 */
export function cacheRateOf(b: StatsBucket): string {
	const read = b.totalInputTokens + b.totalCacheReadTokens;
	const rate = b.cacheRate ?? (read > 0 ? b.totalCacheReadTokens / read : null);
	return rate === null ? "–" : `${Math.round(rate * 100)}%`;
}

function BucketTable({
	id,
	title,
	rows,
	keyOf,
	labelOf = keyOf,
	titleOf = labelOf,
}: {
	id: string;
	title: string;
	rows: StatsBucket[];
	/** What tells one row from another. */
	keyOf: (b: StatsBucket) => string;
	/** What a row is called (its key unless said otherwise) and what hovering it says (its name unless said otherwise). */
	labelOf?: (b: StatsBucket) => string;
	titleOf?: (b: StatsBucket) => string;
}) {
	const t = useT();
	if (!rows.length) return null;
	const sorted = [...rows].sort((a, b) => b.totalCost - a.totalCost);
	const money = costColumn(sorted.map((b) => b.totalCost));
	return (
		// `min-w-0`: as an item of the grid below the card would not shrink under its table's width, and a phone's card
		// came out wider than the screen; narrower than its table, the table scrolls inside the card. The card is its own
		// container: in one narrower than 36rem (two side by side on a laptop, a phone) the table gives up its Cache R/W
		// column and a shorter name, and the Cost column stays at the right edge whatever the scroll, being the figure the
		// card is about. `overflow-hidden` clips the table to the card's radius: the pinned Cost cell is a square box, and
		// without the clip it painted over the card's rounded bottom-right corner and its border.
		<section className="@container min-w-0 overflow-hidden rounded-2xl border border-border bg-surface">
			<h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">{title}</h2>
			<div className="overflow-x-auto">
				<table className="w-full text-sm" data-testid={`table-${id}`}>
					<thead className="whitespace-nowrap text-left text-xs text-faint">
						<tr>
							<th className="px-4 py-2 font-medium">{t("pages.usageColName")}</th>
							<th className="px-2 py-2 text-right font-medium">{t("pages.usageColRequests")}</th>
							<th className="px-2 py-2 text-right font-medium">{t("pages.usageColInput")}</th>
							<th className="px-2 py-2 text-right font-medium @max-xl:hidden">{t("pages.usageColOutput")}</th>
							<th className="px-2 py-2 text-right font-medium @max-xl:hidden">{t("pages.usageColCacheRW")}</th>
							<th className="px-2 py-2 text-right font-medium @max-xl:hidden">{t("pages.usageColCacheHit")}</th>
							<th className="sticky right-0 border-l border-border bg-surface px-4 py-2 text-right font-medium">
								{t("pages.usageColCost")}
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-border">
						{sorted.map((b) => (
							<tr key={keyOf(b)} className="group hover:bg-hover/50">
								<td className="max-w-64 truncate px-4 py-2 @max-xl:max-w-36" title={titleOf(b)}>
									{labelOf(b)}
								</td>
								<td className="px-2 py-2 text-right tabular-nums">{b.totalRequests.toLocaleString()}</td>
								<td className="px-2 py-2 text-right tabular-nums">{fmtTokens(b.totalInputTokens)}</td>
								<td className="px-2 py-2 text-right tabular-nums @max-xl:hidden">{fmtTokens(b.totalOutputTokens)}</td>
								<td className="px-2 py-2 text-right tabular-nums @max-xl:hidden">
									{fmtTokens(b.totalCacheReadTokens)} / {fmtTokens(b.totalCacheWriteTokens)}
								</td>
								<td className="px-2 py-2 text-right tabular-nums @max-xl:hidden" data-testid="bucket-cache-rate">
									{cacheRateOf(b)}
								</td>
								<td
									className="sticky right-0 border-l border-border bg-surface px-4 py-2 text-right font-medium tabular-nums group-hover:bg-[color-mix(in_srgb,var(--hover)_50%,var(--surface))]"
									title={fmtCostExact(b.totalCost)}
									data-cost={b.totalCost}
								>
									{money(b.totalCost)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

/**
 * What a conversation's subagents and its advisors account for in its cost, in the list of the costliest ones: a second
 * line under its title, so that a conversation with a split keeps every column where the others have it.
 */
function SessionSplit({ s }: { s: SessionSummary }) {
	const t = useT();
	const advisor = advisorUsageOf(s.advisorUsage);
	const parts = [
		s.subagentCount ? t("pages.usageSessionSubagents", { cost: fmtCost(s.subagentUsage.cost) }) : "",
		advisor.requests ? t("pages.usageSessionAdvisor", { cost: fmtCost(advisor.cost) }) : "",
	].filter(Boolean);
	if (parts.length === 0) return null;
	return (
		<span className="block truncate text-xs text-faint" data-testid="usage-session-split">
			{parts.join(" · ")}
		</span>
	);
}

const RANGE_LABELS: Record<UsageRange, MessageKey> = {
	"24h": "pages.usageRange24h",
	"7d": "pages.usageRange7d",
	"30d": "pages.usageRange30d",
	all: "pages.usageRangeAll",
};

/** The range the person last looked at (#714), else a month. */
const storedRange = (): UsageRange => {
	const v = localStorage.getItem(PREF.usageRange);
	return isUsageRange(v) ? v : DEFAULT_USAGE_RANGE;
};

export function UsagePage() {
	const t = useT();
	const [stats, setStats] = useState<OmpStats | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	// The kept figures shown while omp brings them up to date (#690): when they are from, until the new ones come.
	const [keptAt, setKeptAt] = useState<number | null>(null);
	const [range, setRange] = useState<UsageRange>(storedRange);
	// The server could not read the range from omp's database and answered omp's own 24 hours (#714).
	const [fallback, setFallback] = useState(false);
	const { sessions, sessionsLoaded, meta, setView } = useApp(
		useShallow((s) => ({ sessions: s.sessions, sessionsLoaded: s.sessionsLoaded, meta: s.meta, setView: s.setView })),
	);
	const alive = useRef(true);
	// The last load asked: an answer to an earlier one (a range the person has moved on from) is dropped.
	const asked = useRef(0);
	useEffect(
		() => () => {
			alive.current = false;
		},
		[],
	);
	const load = async (how: "kept" | "force", r: UsageRange) => {
		const mine = ++asked.current;
		const current = () => alive.current && asked.current === mine;
		setLoading(true);
		try {
			const first = await api.stats(how, r);
			if (!current()) return;
			setStats(first.stats);
			setFallback(first.fallback);
			setError(null);
			setKeptAt(null);
			if (!first.refreshing) return;
			setKeptAt(first.at);
			const next = await api.stats("wait", r).catch(() => null);
			if (!current()) return;
			// A run that failed leaves the kept figures, and says from when they are.
			if (next) {
				setStats(next.stats);
				setFallback(next.fallback);
				setKeptAt(null);
			}
		} catch (e) {
			if (current()) setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (current()) setLoading(false);
		}
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount; later loads are explicit (refresh, range).
	useEffect(() => void load("kept", range), []);
	const pickRange = (r: UsageRange) => {
		if (r === range) return;
		setRange(r);
		setPref(PREF.usageRange, r);
		void load("kept", r);
	};
	const daily = useMemo(() => (stats ? dailyByModel(stats) : null), [stats]);
	const topSessions = useMemo(() => [...sessions].sort((a, b) => b.usage.cost - a.usage.cost).slice(0, 12), [sessions]);
	const o = stats?.overall;
	// omp has no timing for conversations that record no per-request durations: it sends null (and a zero is as little). That
	// is no measurement, and the Speed card says so instead of printing zeros.
	const speed = o?.avgTokensPerSecond ?? 0;
	const ttft = o?.avgTtft ?? 0;
	const avg = o?.avgDuration ?? 0;
	// omp names a project by the directory it files its conversations in (`-tmp-dev-acme-api`); the page calls it what its
	// conversations do (`acme-api`), as the sidebar does.
	const projects = useMemo(
		() =>
			projectLabels(
				(stats?.byFolder ?? []).map((b) => b.folder ?? ""),
				sessions,
				meta?.home,
			),
		[stats, sessions, meta?.home],
	);
	// The costs of the costliest conversations are one column: they are written with one number of decimals.
	const sessionCost = useMemo(() => costColumn(topSessions.map((s) => s.usage.cost)), [topSessions]);
	/** Nothing recorded and no conversation yet: one welcome instead of a page of zeros and empty tables. */
	const fresh = o?.totalRequests === 0 && sessionsLoaded && sessions.length === 0;
	return (
		<div className="h-full flex-1 overflow-y-auto" data-testid="usage-page">
			<div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
				<div className="flex flex-wrap items-center gap-3">
					<BarChart3 className="shrink-0 text-accent" />
					<h1 className="text-xl font-semibold">{t("pages.usageTitle")}</h1>
					{/* Where the figures come from, not something to act on: on a phone it makes way for the title. */}
					<span className="hidden text-xs text-faint sm:inline">
						{t("pages.usageFrom")} <code>omp stats</code>
					</span>
					<span className="flex-1" />
					{/* How far back the figures go (#714): a month unless the person chose otherwise, and remembered. On a phone
					    it is a row of its own under the title, which stays one line. */}
					<fieldset
						aria-label={t("pages.usageRange")}
						data-testid="usage-range"
						className="m-0 flex min-w-0 shrink-0 rounded-lg border border-border bg-surface p-0.5 text-xs max-sm:order-last max-sm:w-full"
					>
						{USAGE_RANGES.map((r) => (
							<button
								key={r}
								type="button"
								aria-pressed={r === range}
								data-testid={`usage-range-${r}`}
								onClick={() => pickRange(r)}
								className={cx(
									"rounded-md px-2 py-1 whitespace-nowrap max-sm:flex-1",
									r === range ? "bg-accent-soft font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg",
								)}
							>
								{t(RANGE_LABELS[r])}
							</button>
						))}
					</fieldset>
					<Button
						size="sm"
						className="max-sm:h-8 max-sm:w-8 max-sm:px-0"
						onClick={() => load("force", range)}
						disabled={loading}
					>
						{loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
						<span className="max-sm:sr-only">{t("pages.usageRefresh")}</span>
					</Button>
				</div>
				{keptAt !== null && loading ? (
					<p className="-mt-4 text-xs text-faint" data-testid="usage-kept">
						{t("pages.usageKept", { time: fmtTime(keptAt) })}
					</p>
				) : null}
				{fallback && stats ? (
					<p className="-mt-4 text-xs text-warning" data-testid="usage-fallback">
						{t("pages.usageFallback")}
					</p>
				) : null}
				{error ? (
					<div className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</div>
				) : null}
				{!stats && !error ? (
					<div className="flex justify-center py-20">
						<Spinner />
					</div>
				) : null}
				{o && fresh ? (
					<div data-testid="usage-fresh">
						<Empty icon={<BarChart3 size={28} className="text-accent" />} title={t("pages.usageEmpty")}>
							<p>{t("pages.usageEmptyHint")}</p>
							<Button variant="primary" className="mt-3" onClick={() => setView({ kind: "new" })}>
								{t("pages.usageStart")}
							</Button>
						</Empty>
					</div>
				) : null}
				{o && !fresh ? (
					<>
						<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
							<Stat
								id="Total cost"
								label={t("pages.usageTotalCost")}
								value={fmtCost(o.totalCost)}
								exact={fmtCostExact(o.totalCost)}
								sub={o.firstTimestamp ? t("pages.usageSince", { date: utcDate(o.firstTimestamp) }) : undefined}
							/>
							<Stat
								id="Requests"
								label={t("pages.usageRequests")}
								value={o.totalRequests.toLocaleString()}
								sub={t("pages.usageErrors", { pct: (o.errorRate * 100).toFixed(1) })}
							/>
							<Stat
								id="Tokens"
								label={t("pages.usageTokens")}
								value={fmtTokens(
									o.totalInputTokens + o.totalOutputTokens + o.totalCacheReadTokens + o.totalCacheWriteTokens,
								)}
								sub={t("pages.usageTokensSub", {
									out: fmtTokens(o.totalOutputTokens),
									pct: Math.round(o.cacheRate * 100),
								})}
							/>
							<Stat
								id="Speed"
								label={t("pages.usageSpeed")}
								value={speed > 0 ? t("pages.usageSpeedValue", { n: Math.round(speed) }) : "—"}
								dim={speed <= 0}
								sub={
									speed > 0 || ttft > 0 || avg > 0
										? t("pages.usageSpeedSub", {
												ttft: ttft > 0 ? fmtDuration(ttft) : "—",
												avg: avg > 0 ? fmtDuration(avg) : "—",
											})
										: t("pages.usageSpeedNone")
								}
							/>
						</div>
						<section className="rounded-2xl border border-border bg-surface p-4">
							<h2 className="mb-3 text-sm font-semibold">{t("pages.usageDaily")}</h2>
							{daily?.rows.length ? (
								<div className="h-72" data-testid="daily-chart">
									<ResponsiveContainer>
										<BarChart data={paddedDays(daily.rows)}>
											<CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
											<XAxis dataKey="day" tick={{ fill: "var(--muted)", fontSize: 12 }} />
											<YAxis tickFormatter={(v) => `$${v}`} tick={{ fill: "var(--muted)", fontSize: 12 }} width={50} />
											<Tooltip content={DailyTooltip} cursor={{ fill: "var(--hover)" }} isAnimationActive={false} />
											<Legend
												wrapperStyle={{ fontSize: 12 }}
												// The stack's order (dearest model first), not alphabetical: "Other" is the last series.
												itemSorter={(item) => daily.models.indexOf(String(item.dataKey))}
												formatter={(name) => <span style={{ color: "var(--muted)" }}>{name}</span>}
											/>
											{daily.models.map((m, i) => (
												<Bar
													key={m}
													dataKey={m}
													name={m === OTHER_MODELS ? t("pages.usageOther") : m}
													stackId="cost"
													fill={seriesColor(i)}
													// One day is a column, not a wall: a bar is at most this wide, however few days there are.
													maxBarSize={56}
													isAnimationActive={false}
													radius={i === daily.models.length - 1 ? [4, 4, 0, 0] : 0}
												/>
											))}
										</BarChart>
									</ResponsiveContainer>
								</div>
							) : (
								<Empty title={t("pages.usageEmpty")} />
							)}
							{daily?.rows.length ? (
								<table className="mt-4 w-full text-sm" data-testid="daily-table">
									<thead className="text-left text-xs text-faint">
										<tr>
											<th className="py-1 font-medium">{t("pages.usageColDay")}</th>
											{daily.models.map((m) => (
												<th key={m} className="py-1 text-right font-medium">
													{m === OTHER_MODELS ? t("pages.usageOther") : m}
												</th>
											))}
											<th className="py-1 text-right font-medium">{t("pages.usageColTotal")}</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-border">
										{[...daily.rows].reverse().map((r) => (
											<tr key={r.day}>
												<td className="py-1.5">{r.day}</td>
												{daily.models.map((m) => (
													<td key={m} className="py-1.5 text-right tabular-nums text-muted">
														{r[m] ? fmtCost(Number(r[m])) : "—"}
													</td>
												))}
												<td
													className="py-1.5 text-right font-medium tabular-nums"
													data-day-total={r.day}
													data-cost={r.total}
												>
													{fmtCost(r.total)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							) : null}
						</section>
						<BucketTable
							id="By model"
							title={t("pages.usageByModel")}
							rows={stats.byModel}
							keyOf={(b) => `${b.provider}/${b.model}`}
						/>
						{stats.byFolder.length || stats.byAgentType?.length ? (
							// Side by side only when both tables have rows.
							<div className="@container">
								<div
									className={cx("grid gap-6", stats.byFolder.length && stats.byAgentType?.length && "@4xl:grid-cols-2")}
								>
									<BucketTable
										id="By project"
										title={t("pages.usageByProject")}
										rows={stats.byFolder}
										keyOf={(b) => b.folder ?? ""}
										labelOf={(b) => projects.get(b.folder ?? "")?.label ?? ""}
										titleOf={(b) => projects.get(b.folder ?? "")?.title ?? ""}
									/>
									<BucketTable
										id="By agent type"
										title={t("pages.usageByAgent")}
										rows={stats.byAgentType ?? []}
										keyOf={(b) => b.agentType ?? "main"}
									/>
								</div>
							</div>
						) : null}
					</>
				) : null}
				{topSessions.length ? (
					<section className="rounded-2xl border border-border bg-surface">
						<h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">
							{t("pages.usageTopSessions")}
							{/* Conversations' own totals, which have no date: not the range the figures above are for (#714). */}
							{range === "all" ? null : (
								<span className="ml-2 font-normal text-muted">{t("pages.usageTopSessionsAllTime")}</span>
							)}
						</h2>
						<ul className="divide-y divide-border">
							{topSessions.map((s) => (
								<li key={s.file}>
									<button
										type="button"
										className="grid w-full grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] items-center gap-x-3 px-4 py-2 text-left text-sm hover:bg-hover/50 sm:grid-cols-[minmax(0,1fr)_7rem_4.5rem_5.5rem]"
										data-testid="usage-session"
										data-file={s.file}
										onClick={() => setView({ kind: "chat", file: s.file, liveId: null })}
									>
										<span className="min-w-0">
											<span className="block truncate">{s.title || s.preview || t("pages.usageUntitled")}</span>
											<SessionSplit s={s} />
										</span>
										<span
											className="hidden truncate text-xs text-faint sm:block"
											title={s.cwd}
											data-testid="usage-session-project"
										>
											{s.project}
										</span>
										<span className="text-right text-xs tabular-nums text-muted" data-testid="usage-session-tokens">
											{fmtTokens(s.usage.totalTokens)}
										</span>
										<span
											className="text-right font-medium tabular-nums"
											title={fmtCostExact(s.usage.cost)}
											data-testid="usage-session-cost"
											data-cost={s.usage.cost}
										>
											{sessionCost(s.usage.cost)}
										</span>
									</button>
								</li>
							))}
						</ul>
					</section>
				) : null}
			</div>
		</div>
	);
}
