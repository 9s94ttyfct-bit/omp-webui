import type { HostInfo, HostProc, Pressure } from "@shared/host.ts";
import { type ReactNode, useMemo, useState } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	ReferenceArea,
	Tooltip,
	type TooltipContentProps,
	XAxis,
	YAxis,
} from "recharts";
import { type MessageKey, useLang, useT } from "../i18n/index.ts";
import { useHostWatch } from "../lib/host.ts";
import {
	type ChartRow,
	chartRows,
	clockTicks,
	downsample,
	fmtCore,
	fmtMem,
	fmtShare,
	type HostRow,
	hostColor,
	type PressureRun,
	peakOf,
	pressureRuns,
	tickStep,
	trimRows,
} from "../lib/host-rows.ts";
import { useHost } from "../lib/host-store.ts";
import { PRESSURE_KEY, PRESSURE_TONE, useHostStrings } from "../lib/host-strings.ts";
import { Badge, cx, Empty } from "./ui.tsx";

/** The graphs are about this many pixels wide: a row for every pixel or two is as much as they can show. */
const MAX_POINTS = { fine: 600, coarse: 480 } as const;
/** A gap between two looks this many times the slowest pace the server keeps is a time it was not looking: the graph breaks there. */
const GAP_FACTOR = 3;

type Range = "1h" | "24h";

/** A series' graph: its colour is the usage chart's, by position, so the three never share one. */
interface Series {
	key: "cpu" | "gpu" | "mem";
	name: MessageKey;
	colour: number;
}

const SERIES: Record<Series["key"], Series> = {
	cpu: { key: "cpu", name: "host.tileCpu", colour: 0 },
	gpu: { key: "gpu", name: "host.tileGpu", colour: 1 },
	mem: { key: "mem", name: "host.tileMemory", colour: 2 },
};

/** The time of a mark or of a point, in the viewer's own zone. */
function useClock(): (t: number) => string {
	const lang = useLang((s) => s.lang);
	return useMemo(() => {
		const fmt = new Intl.DateTimeFormat(lang, { hour: "numeric", minute: "2-digit" });
		return (t) => fmt.format(t);
	}, [lang]);
}

function Tile({
	testid,
	name,
	value,
	sub,
	badge,
	colour,
}: {
	testid: string;
	name: string;
	value: string;
	sub: ReactNode;
	badge?: ReactNode;
	colour: number;
}) {
	return (
		<div className="min-w-0 rounded-lg border border-border bg-bg-soft px-2.5 py-2" data-testid={testid}>
			<div className="flex items-center gap-1.5 text-xs text-muted">
				<span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: hostColor(colour) }} />
				<span className="min-w-0 truncate">{name}</span>
			</div>
			<div className="mt-0.5 flex items-center gap-1.5">
				<span className="text-sm font-semibold tabular-nums" data-testid={`${testid}-value`}>
					{value}
				</span>
				{badge}
			</div>
			<div className="mt-0.5 break-words text-xs text-faint">{sub}</div>
		</div>
	);
}

/** What a point of a graph says on hover: when, and the figure. */
function PointTip({
	active,
	payload,
	clock,
	name,
}: TooltipContentProps & { clock: (t: number) => string; name: string }) {
	if (!active || !payload?.length) return null;
	const row = payload[0]?.payload as ChartRow | undefined;
	const v = payload[0]?.value;
	if (!row || typeof v !== "number") return null;
	return (
		<div className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-lg">
			<div className="text-muted">{clock(row.t)}</div>
			<div className="tabular-nums text-fg">
				{name} {fmtShare(v)}
			</div>
		</div>
	);
}

function Chart({
	series,
	rows,
	range,
	info,
	domain,
	runs,
}: {
	series: Series;
	rows: ChartRow[];
	range: Range;
	info: HostInfo | null;
	domain: [number, number];
	runs: PressureRun[];
}) {
	const t = useT();
	const clock = useClock();
	const colour = hostColor(series.colour);
	const name = t(series.name);
	const column = (r: HostRow | ChartRow) => r[series.key];
	const ticks = useMemo(
		() =>
			clockTicks(
				domain[0],
				domain[1],
				tickStep(domain[1] - domain[0]),
				-new Date(domain[1]).getTimezoneOffset() * 60_000,
			),
		[domain],
	);
	const last = [...rows].reverse().find((r) => column(r) !== null);
	const peak = peakOf(rows as HostRow[], (r) => column(r) as number | null);
	const aria = t("host.chartAria", {
		name,
		range: t(range === "1h" ? "host.range1h" : "host.range24h"),
		now: last ? fmtShare(column(last) as number) : t("host.chartNoData"),
		peak: fmtShare(peak),
	});
	return (
		<div role="img" aria-label={aria} data-testid={`host-chart-${series.key}`} data-points={rows.length}>
			<div className="mb-0.5 flex items-baseline justify-between text-xs text-muted" aria-hidden>
				<span>{name}</span>
				<span className="tabular-nums">{t("host.peak", { v: fmtShare(peak) })}</span>
			</div>
			<div className="h-24 w-full" aria-hidden>
				<AreaChart
					data={rows}
					responsive
					style={{ width: "100%", height: "100%" }}
					margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
					accessibilityLayer={false}
				>
					<CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
					<XAxis
						type="number"
						dataKey="t"
						domain={domain}
						allowDataOverflow
						ticks={ticks}
						tickFormatter={(v: number) => clock(v)}
						tick={{ fill: "var(--muted)", fontSize: 12 }}
						tickLine={false}
						axisLine={{ stroke: "var(--border)" }}
						minTickGap={24}
					/>
					<YAxis
						domain={[0, 100]}
						ticks={[0, 50, 100]}
						tickFormatter={(v: number) => `${v}%`}
						tick={{ fill: "var(--muted)", fontSize: 12 }}
						tickLine={false}
						axisLine={false}
						width={40}
					/>
					{series.key === "mem" && info?.pressure
						? runs.map((r) => (
								<ReferenceArea
									key={`${r.from}-${r.level}`}
									x1={r.from}
									x2={r.to}
									ifOverflow="hidden"
									fill={r.level === 2 ? "var(--danger)" : "var(--warning)"}
									fillOpacity={r.level === 2 ? 0.28 : 0.2}
									stroke="none"
									data-testid="host-pressure-band"
									data-level={r.level}
								/>
							))
						: null}
					<Tooltip
						content={(p) => <PointTip {...p} clock={clock} name={name} />}
						isAnimationActive={false}
						cursor={{ stroke: "var(--faint)" }}
					/>
					<Area
						type="linear"
						dataKey={series.key}
						stroke={colour}
						strokeWidth={1.5}
						fill={colour}
						fillOpacity={0.22}
						connectNulls={false}
						dot={false}
						activeDot={{ r: 3 }}
						isAnimationActive={false}
					/>
				</AreaChart>
			</div>
		</div>
	);
}

/** One row of the process table. */
function ProcRow({ p }: { p: HostProc }) {
	const t = useT();
	const name = p.id === "server" ? t("host.procServer") : p.id === "omp" ? t("host.procOmp") : t("host.procRelay");
	return (
		<tr data-testid={`host-proc-${p.id}`}>
			<td className="py-1.5 pr-2">
				<span className="font-medium">{name}</span>
				{p.id !== "server" ? (
					<span className="ml-1.5 text-faint">
						{p.count === 1 ? t("host.procCountOne") : t("host.procCountN", { n: p.count })}
					</span>
				) : null}
			</td>
			<td className="px-2 py-1.5 text-right tabular-nums text-muted" data-testid={`host-proc-${p.id}-cpu`}>
				{fmtCore(p.cpu)}
			</td>
			<td className="py-1.5 pl-2 text-right tabular-nums text-muted">{fmtMem(p.rss)}</td>
		</tr>
	);
}

const seconds = (ms: number) => String(Number((ms / 1000).toFixed(1)));

/**
 * The host's load in full (#613): the latest figures as tiles, the history as stacked graphs (the last hour a point per look,
 * the last day a point per minute), what omp, its relays and the server use, and how the figures are taken. It is the body
 * of the sidebar line's popover and of the side panel's Host tab; while it is shown the server looks at the live pace and
 * lists processes too.
 */
export default function HostPane({ titleId }: { titleId?: string }) {
	const ready = useHostStrings();
	useHostWatch({ detail: true, procs: true });
	const t = useT();
	const [range, setRange] = useState<Range>("1h");
	const info = useHost((s) => s.info);
	const fine = useHost((s) => s.fine);
	const coarse = useHost((s) => s.coarse);
	const procs = useHost((s) => s.procs);
	const failed = useHost((s) => s.failed);

	const slowest = Math.max(info?.backgroundMs ?? 10_000, info?.liveMs ?? 2000);
	const rows = range === "1h" ? fine : coarse;
	const span = range === "1h" ? (info?.fineSpanMs ?? 3_600_000) : (info?.coarseSpanMs ?? 86_400_000);
	const gapMs = range === "1h" ? slowest * GAP_FACTOR : (info?.coarseMs ?? 60_000) * GAP_FACTOR;
	const shown = useMemo(() => {
		const end = rows.at(-1)?.t ?? 0;
		return downsample(trimRows(rows, end - span), span, range === "1h" ? MAX_POINTS.fine : MAX_POINTS.coarse);
	}, [rows, span, range]);
	const chart = useMemo(() => chartRows(shown, gapMs), [shown, gapMs]);
	const runs = useMemo(() => pressureRuns(shown, gapMs), [shown, gapMs]);
	const first = shown[0]?.t ?? 0;
	const end = shown.at(-1)?.t ?? 0;
	// The graph reaches back as far as there is history, and no further than its range.
	const domain = useMemo<[number, number]>(() => [Math.max(first, end - span), end], [first, end, span]);

	if (!ready) return null;
	const latest = fine.at(-1) ?? null;
	const showGpu = info?.gpu != null || fine.some((r) => r.gpu !== null);
	const level: Pressure | null = latest?.pressure ?? null;
	const usedBytes = latest?.mem != null && info ? (latest.mem / 100) * info.memTotal : null;
	const enough = shown.length >= 2;
	const gpuSub = info?.gpu?.name
		? info.gpu.cores
			? t("host.gpuSubCores", { name: info.gpu.name, n: info.gpu.cores })
			: t("host.gpuSub", { name: info.gpu.name })
		: "";
	return (
		<div className="space-y-3 text-sm" data-testid="host-pane">
			<div className="flex items-center justify-between gap-2">
				{titleId ? (
					<h2 id={titleId} className="text-sm font-semibold">
						{t("host.title")}
					</h2>
				) : null}
				<fieldset className="ml-auto flex min-w-0 rounded-lg border border-border p-0.5">
					<legend className="sr-only">{t("host.rangeLabel")}</legend>
					{(["1h", "24h"] as const).map((r) => (
						<button
							key={r}
							type="button"
							aria-pressed={range === r}
							data-testid={`host-range-${r}`}
							onClick={() => setRange(r)}
							className={cx(
								"rounded-md px-2 py-0.5 text-xs",
								range === r ? "bg-hover font-medium text-fg" : "text-muted hover:text-fg",
							)}
						>
							{t(r === "1h" ? "host.range1h" : "host.range24h")}
						</button>
					))}
				</fieldset>
			</div>

			<div className={cx("grid gap-2", showGpu ? "grid-cols-3" : "grid-cols-2")}>
				<Tile
					testid="host-tile-cpu"
					name={t("host.tileCpu")}
					value={fmtShare(latest?.cpu)}
					sub={info ? t("host.cpuSub", { n: info.cores }) : ""}
					colour={SERIES.cpu.colour}
				/>
				{showGpu ? (
					<Tile
						testid="host-tile-gpu"
						name={t("host.tileGpu")}
						value={fmtShare(latest?.gpu)}
						sub={gpuSub}
						colour={SERIES.gpu.colour}
					/>
				) : null}
				<Tile
					testid="host-tile-mem"
					name={t("host.tileMemory")}
					value={fmtShare(latest?.mem)}
					sub={
						usedBytes !== null && info
							? t("host.memSub", { used: fmtMem(usedBytes), total: fmtMem(info.memTotal) })
							: ""
					}
					colour={SERIES.mem.colour}
					badge={
						level === null ? null : (
							<span title={t("host.pressureName")} data-testid="host-pressure" data-level={level}>
								<Badge tone={PRESSURE_TONE[level]}>{t(PRESSURE_KEY[level])}</Badge>
							</span>
						)
					}
				/>
			</div>

			{failed ? (
				<p className="text-xs text-warning" role="status" data-testid="host-load-failed">
					{t("host.loadFailed")}
				</p>
			) : null}

			{enough ? (
				<div className="space-y-2.5" data-testid="host-charts" data-range={range}>
					<Chart series={SERIES.cpu} rows={chart} range={range} info={info} domain={domain} runs={runs} />
					{showGpu ? (
						<Chart series={SERIES.gpu} rows={chart} range={range} info={info} domain={domain} runs={runs} />
					) : null}
					<Chart series={SERIES.mem} rows={chart} range={range} info={info} domain={domain} runs={runs} />
					{info?.pressure && runs.length > 0 ? <p className="text-xs text-faint">{t("host.bandNote")}</p> : null}
				</div>
			) : (
				<div data-testid="host-empty">
					<Empty title={t("host.emptyTitle")}>{t(range === "1h" ? "host.emptyHint" : "host.emptyHintDay")}</Empty>
				</div>
			)}

			<section aria-label={t("host.procTitle")} data-testid="host-procs">
				<h3 className="mb-0.5 text-xs font-medium text-muted">{t("host.procTitle")}</h3>
				{procs ? (
					<table className="w-full text-xs">
						<thead className="text-left text-faint">
							<tr>
								<th scope="col" className="py-1 pr-2 font-medium">
									{t("host.procName")}
								</th>
								<th scope="col" className="px-2 py-1 text-right font-medium">
									{t("host.procCpu")}
								</th>
								<th scope="col" className="py-1 pl-2 text-right font-medium">
									{t("host.procMem")}
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border">
							{procs.map((p) => (
								<ProcRow key={p.id} p={p} />
							))}
						</tbody>
					</table>
				) : (
					<p className="py-1 text-xs text-faint">{t("host.procWaiting")}</p>
				)}
				<p className="mt-1 text-xs text-faint">{t("host.procNote")}</p>
			</section>

			{info ? (
				<p className="border-t border-border pt-2 text-xs text-faint" data-testid="host-footer">
					{t("host.footer", { live: seconds(info.liveMs), background: seconds(info.backgroundMs) })}
				</p>
			) : null}
		</div>
	);
}
