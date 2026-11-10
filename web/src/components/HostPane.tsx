import type { HostDisk, HostInfo, HostProc, Pressure } from "@shared/host.ts";
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
import { shownDisks, useHostDisks } from "../lib/host-disks.ts";
import {
	type ChartRow,
	chartRows,
	clockTicks,
	downsample,
	fmtCore,
	fmtMem,
	fmtRate,
	fmtShare,
	fmtWatts,
	hostColor,
	type PressureRun,
	peakOf,
	pressureRuns,
	roundTop,
	tickStep,
	trimRows,
	wattsScale,
} from "../lib/host-rows.ts";
import { useHost } from "../lib/host-store.ts";
import { PRESSURE_KEY, PRESSURE_TONE, useHostStrings } from "../lib/host-strings.ts";
import { Badge, cx, Empty } from "./ui.tsx";

/** The graphs are about this many pixels wide: a row for every pixel or two is as much as they can show. */
const MAX_POINTS = { fine: 600, coarse: 480 } as const;
/** A gap between two looks this many times the slowest pace the server keeps is a time it was not looking: the graph breaks there. */
const GAP_FACTOR = 3;

type Range = "1h" | "24h";

/** A line of a graph: the figure of a row it draws, its colour, and where a graph has two, its name and its arrow. */
interface Line {
	key: string;
	value: (r: ChartRow) => number | null;
	colour: number;
	name?: MessageKey;
	mark?: string;
}

/** A series' graph: its colours are the usage chart's, by position, so no two share one. */
interface Series {
	key: "cpu" | "gpu" | "mem" | "power" | "net" | "disk";
	name: MessageKey;
	/** What it is called where that is not `name` (a disk: its own name). */
	title?: string;
	/** The disk it is of. */
	disk?: string;
	/** What it draws: one line, or the network's two (received, sent). */
	lines: Line[];
	/** How its figures are written: a share (`12%`), watts (`18.4 W`), bytes a second (`1.2 MB/s`), bytes (`132 GB`). */
	format: (v: number | null | undefined) => string;
	/** How the marks of its scale are written. */
	axis: (v: number) => string;
	/** The top of its scale, from the highest figure it has. */
	top: (peak: number | null) => number;
}

const share = { format: fmtShare, axis: (v: number) => `${v}%`, top: () => 100 };
const line = (key: "cpu" | "gpu" | "mem" | "power" | "rx" | "tx", colour: number, more: Partial<Line> = {}): Line => ({
	key,
	value: (r) => r[key] ?? null,
	colour,
	...more,
});

const SERIES: Record<Exclude<Series["key"], "disk">, Series> = {
	cpu: { key: "cpu", name: "host.tileCpu", lines: [line("cpu", 0)], ...share },
	gpu: { key: "gpu", name: "host.tileGpu", lines: [line("gpu", 1)], ...share },
	mem: { key: "mem", name: "host.tileMemory", lines: [line("mem", 2)], ...share },
	// Watts against a round step above the highest, so that the line is not flat (and so the network's and the disks').
	power: {
		key: "power",
		name: "host.tilePower",
		lines: [line("power", 3)],
		format: fmtWatts,
		axis: (v) => `${v} W`,
		top: wattsScale,
	},
	net: {
		key: "net",
		name: "host.tileNet",
		lines: [line("rx", 4, { name: "host.netDown", mark: "↓" }), line("tx", 5, { name: "host.netUp", mark: "↑" })],
		format: fmtRate,
		// The marks are round (1, 2, 5…): `2 MB/s`, not `2.0 MB/s`, which would not fit the scale's width.
		axis: (v) => fmtRate(v).replace(".0 ", " "),
		top: (peak) => roundTop(peak, 1000),
	},
};

/** The graph of a disk's free space; the disks take the palette's last two colours in turn. */
const diskSeries = (disk: HostDisk, index: number, title: string): Series => ({
	key: "disk",
	name: "host.tileDisk",
	title,
	disk: disk.id,
	lines: [{ key: `disk:${disk.id}`, value: (r) => r.disks?.[disk.id] ?? null, colour: 6 + (index % 2) }],
	format: (v) => (v === null || v === undefined ? "—" : fmtMem(v)),
	axis: fmtMem,
	top: (peak) => roundTop(peak, 1e9),
});

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
	disk,
	name,
	value,
	sub,
	badge,
	colour,
}: {
	testid: string;
	/** The disk it is of. */
	disk?: string;
	name: string;
	value: ReactNode;
	sub: ReactNode;
	badge?: ReactNode;
	colour: number;
}) {
	return (
		<div
			className="min-w-0 rounded-lg border border-border bg-bg-soft px-2.5 py-2"
			data-testid={testid}
			data-disk={disk}
		>
			<div className="flex items-center gap-1.5 text-xs text-muted">
				<span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: hostColor(colour) }} />
				<span className="min-w-0 truncate">{name}</span>
			</div>
			<div className="mt-0.5 flex flex-wrap items-center gap-1.5">
				<span className="text-sm font-semibold tabular-nums" data-testid={`${testid}-value`}>
					{value}
				</span>
				{badge}
			</div>
			<div className="mt-0.5 break-words text-xs text-faint">{sub}</div>
		</div>
	);
}

/** The figures of a row as a graph's lines have them: `12%`, or the network's `↓ 1.2 MB/s · ↑ 40 KB/s` (`aloud`: with the lines' names). */
function figuresOf(
	series: Series,
	value: (l: Line) => number | null | undefined,
	name: (key: MessageKey) => string,
	aloud = false,
): string {
	return series.lines
		.map((l) => {
			const v = series.format(value(l));
			if (!l.name) return v;
			return aloud ? `${name(l.name)} ${v}` : `${l.mark ?? ""} ${v}`;
		})
		.join(aloud ? ", " : " · ");
}

/** What a point of a graph says on hover: when, and the figures. */
function PointTip({
	active,
	payload,
	clock,
	name,
	series,
}: TooltipContentProps & { clock: (t: number) => string; name: string; series: Series }) {
	const t = useT();
	if (!active || !payload?.length) return null;
	const row = payload[0]?.payload as ChartRow | undefined;
	if (!row || series.lines.every((l) => l.value(row) === null)) return null;
	return (
		<div className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-lg">
			<div className="text-muted">{clock(row.t)}</div>
			<div className="tabular-nums text-fg">
				{name} {figuresOf(series, (l) => l.value(row), t)}
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
	axisWidth,
}: {
	series: Series;
	rows: ChartRow[];
	range: Range;
	info: HostInfo | null;
	domain: [number, number];
	runs: PressureRun[];
	/** The scale's width, the same for every graph of the pane so that their times line up. */
	axisWidth: number;
}) {
	const t = useT();
	const clock = useClock();
	const name = series.title ?? t(series.name);
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
	const last = [...rows].reverse().find((r) => series.lines.some((l) => l.value(r) !== null));
	const peaks = new Map(series.lines.map((l) => [l.key, peakOf(rows, l.value)]));
	const highest = [...peaks.values()].filter((v): v is number => v !== null);
	const top = series.top(highest.length ? Math.max(...highest) : null);
	const aria = t("host.chartAria", {
		name,
		range: t(range === "1h" ? "host.range1h" : "host.range24h"),
		now: last ? figuresOf(series, (l) => l.value(last), t, true) : t("host.chartNoData"),
		peak: figuresOf(series, (l) => peaks.get(l.key), t, true),
	});
	const two = series.lines.length > 1;
	return (
		<div
			role="img"
			aria-label={aria}
			data-testid={`host-chart-${series.key}`}
			data-disk={series.disk}
			data-points={rows.length}
		>
			<div className="mb-0.5 flex items-baseline justify-between gap-2 text-xs text-muted" aria-hidden>
				<span>{name}</span>
				<span className="tabular-nums">{t("host.peak", { v: figuresOf(series, (l) => peaks.get(l.key), t) })}</span>
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
						domain={[0, top]}
						ticks={[0, top / 2, top]}
						tickFormatter={series.axis}
						tick={{ fill: "var(--muted)", fontSize: 12 }}
						tickLine={false}
						axisLine={false}
						width={axisWidth}
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
						content={(p) => <PointTip {...p} clock={clock} name={name} series={series} />}
						isAnimationActive={false}
						cursor={{ stroke: "var(--faint)" }}
					/>
					{series.lines.map((l) => (
						<Area
							key={l.key}
							type="linear"
							dataKey={l.value}
							name={l.key}
							stroke={hostColor(l.colour)}
							strokeWidth={1.5}
							fill={hostColor(l.colour)}
							// Two lines' areas overlap: lighter, so that the one behind shows through.
							fillOpacity={two ? 0.12 : 0.22}
							connectNulls={false}
							dot={false}
							activeDot={{ r: 3 }}
							isAnimationActive={false}
						/>
					))}
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
	const chosen = useHostDisks();
	// The disks the server lists now, and any the history still has (one taken out within the range), named by their folder.
	const disks = useMemo(() => {
		const known: HostDisk[] = [...(info?.disks ?? [])];
		for (const r of shown)
			for (const id of Object.keys(r.disks ?? {}))
				if (!known.some((d) => d.id === id))
					known.push({ id, name: id.split(/[\\/]/).filter(Boolean).pop() ?? id, total: 0 });
		return shownDisks(known, chosen);
	}, [info, shown, chosen]);

	if (!ready) return null;
	const latest = fine.at(-1) ?? null;
	const showGpu = info?.gpu != null || fine.some((r) => r.gpu !== null);
	const showPower = info?.power === true || fine.some((r) => r.power != null);
	// A server of an older version tells neither (its rows have null), nor does Windows the network.
	const showNet = info?.net === true || fine.some((r) => r.rx != null);
	const tiles = 2 + (showGpu ? 1 : 0) + (showPower ? 1 : 0) + (showNet ? 1 : 0) + disks.length;
	// Scales in bytes are wider than `100%`; every graph has the same width of scale, so that their times line up.
	const axisWidth = showNet || disks.length > 0 ? 64 : 40;
	/** What every graph is drawn from: the same rows, range and scale width. */
	const graph = { rows: chart, range, info, domain, runs, axisWidth };
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

			{/* Three tiles share a row (unless one is the network's, which is wider); more make rows of two, which a side panel has the width for. */}
			<div className={cx("grid gap-2", tiles === 3 && !showNet ? "grid-cols-3" : "grid-cols-2")}>
				<Tile
					testid="host-tile-cpu"
					name={t("host.tileCpu")}
					value={fmtShare(latest?.cpu)}
					sub={info ? t("host.cpuSub", { n: info.cores }) : ""}
					colour={SERIES.cpu.lines[0].colour}
				/>
				{showGpu ? (
					<Tile
						testid="host-tile-gpu"
						name={t("host.tileGpu")}
						value={fmtShare(latest?.gpu)}
						sub={gpuSub}
						colour={SERIES.gpu.lines[0].colour}
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
					colour={SERIES.mem.lines[0].colour}
					badge={
						level === null ? null : (
							<span title={t("host.pressureName")} data-testid="host-pressure" data-level={level}>
								<Badge tone={PRESSURE_TONE[level]}>{t(PRESSURE_KEY[level])}</Badge>
							</span>
						)
					}
				/>
				{showPower ? (
					<Tile
						testid="host-tile-power"
						name={t("host.tilePower")}
						value={fmtWatts(latest?.power)}
						sub={t("host.powerSub")}
						colour={SERIES.power.lines[0].colour}
					/>
				) : null}
				{showNet ? (
					<Tile
						testid="host-tile-net"
						name={t("host.tileNet")}
						value={
							<>
								<span aria-hidden>↓ </span>
								<span className="sr-only">{t("host.netDown")} </span>
								{fmtRate(latest?.rx)}
								<span aria-hidden> · ↑ </span>
								<span className="sr-only">, {t("host.netUp")} </span>
								{fmtRate(latest?.tx)}
							</>
						}
						sub={t("host.netSub")}
						colour={SERIES.net.lines[0].colour}
					/>
				) : null}
				{disks.map((d, i) => {
					const free = latest?.disks?.[d.id] ?? null;
					const used =
						d.total > 0 && free !== null
							? t("host.diskSub", { total: fmtMem(d.total), used: fmtShare(100 - (free / d.total) * 100) })
							: "";
					const data = d.id === info?.dataDisk ? t("host.diskData") : "";
					return (
						<Tile
							key={d.id}
							testid="host-tile-disk"
							disk={d.id}
							name={d.name}
							value={free === null ? "—" : t("host.diskValue", { free: fmtMem(free) })}
							sub={[used, data].filter(Boolean).join(" · ")}
							colour={6 + (i % 2)}
						/>
					);
				})}
			</div>

			{failed ? (
				<p className="text-xs text-warning" role="status" data-testid="host-load-failed">
					{t("host.loadFailed")}
				</p>
			) : null}

			{enough ? (
				<div className="space-y-2.5" data-testid="host-charts" data-range={range}>
					<Chart {...graph} series={SERIES.cpu} />
					{showGpu ? <Chart {...graph} series={SERIES.gpu} /> : null}
					<Chart {...graph} series={SERIES.mem} />
					{showPower ? <Chart {...graph} series={SERIES.power} /> : null}
					{showNet ? <Chart {...graph} series={SERIES.net} /> : null}
					{disks.map((d, i) => (
						<Chart key={d.id} {...graph} series={diskSeries(d, i, t("host.diskChart", { name: d.name }))} />
					))}
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
