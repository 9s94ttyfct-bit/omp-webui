import type { HostPoint, HostSeries, Pressure } from "@shared/host.ts";

/**
 * What the pages do with the host's load (#613) that needs no page: the rows the server's columns become, how a new look
 * is added to them, where a graph has a gap or a band, and how a figure is written. Pure; `lib/host.ts` keeps the store.
 */

/**
 * The colour of the series at `index` (CPU, GPU, memory): the palette's own, as the usage chart's are (`seriesColor` of
 * `lib/usage-series.ts`, the same `--chart-N`), so the graphs follow the palette and the mode. Not imported from there: that
 * would make the usage page's helper a chunk of its own that the first page has to name.
 */
export const hostColor = (index: number): string => `var(--chart-${index + 1})`;

/** One look at the host (the server's own shape). */
export type HostRow = HostPoint;

/** The rows of a series the server sent as columns, oldest first. */
export function rowsOf(s: HostSeries): HostRow[] {
	const rows: HostRow[] = [];
	for (let i = 0; i < s.t.length; i++) {
		rows.push({
			t: s.t[i] as number,
			cpu: s.cpu[i] ?? 0,
			gpu: s.gpu[i] ?? null,
			mem: s.mem[i] ?? null,
			pressure: s.pressure[i] ?? null,
		});
	}
	return rows;
}

/** `rows` from `since` on (a row at `since` stays). The same array when nothing goes. */
export function trimRows(rows: HostRow[], since: number): HostRow[] {
	let first = 0;
	while (first < rows.length && (rows[first] as HostRow).t < since) first++;
	return first === 0 ? rows : rows.slice(first);
}

/**
 * `rows` with `row` at the end and what is more than `spanMs` older than it gone. A row that is not newer than the last
 * one is not added: the socket and an answer of `GET /api/host` may both carry it, and a look is told once.
 */
export function appendRow(rows: HostRow[], row: HostRow, spanMs: number): HostRow[] {
	const last = rows.at(-1);
	if (last && row.t <= last.t) return rows;
	return trimRows([...rows, row], row.t - spanMs);
}

/** `base` and, after it, the rows of `extra` that are newer than its last: what the server's answer and the socket both said, once each. */
export function mergeRows(base: HostRow[], extra: HostRow[]): HostRow[] {
	const last = base.at(-1)?.t ?? Number.NEGATIVE_INFINITY;
	const newer = extra.filter((r) => r.t > last);
	return newer.length ? [...base, ...newer] : base;
}

/** A row of a graph: a figure that is not there is null, and the line breaks at it. */
export interface ChartRow {
	t: number;
	cpu: number | null;
	gpu: number | null;
	mem: number | null;
	pressure: Pressure | null;
}

/**
 * The rows a graph draws. A gap longer than `gapMs` (the server was asleep, or was not running) gets a row of nothing in
 * it, so that the graph is broken there and does not draw a slope across hours it has no figures of.
 */
export function chartRows(rows: HostRow[], gapMs: number): ChartRow[] {
	const out: ChartRow[] = [];
	let prev: HostRow | undefined;
	for (const r of rows) {
		if (prev && r.t - prev.t > gapMs) out.push({ t: prev.t + 1, cpu: null, gpu: null, mem: null, pressure: null });
		out.push(r);
		prev = r;
	}
	return out;
}

/**
 * At most about `max` rows for a graph that shows `spanMs`: the rows that fall in the same stretch of `spanMs / max` are
 * their mean (pressure: the worst), at the stretch's last row's time. The stretches are cut from the clock, not counted
 * from the first row, so that a new look does not move the others between stretches and make the graph shimmer. A graph
 * a few hundred pixels wide has nothing to show of the thousands of looks an hour at the live pace is.
 */
export function downsample(rows: HostRow[], spanMs: number, max: number): HostRow[] {
	if (rows.length <= max) return rows;
	const stretch = Math.max(1, Math.ceil(spanMs / max));
	const out: HostRow[] = [];
	let at = Number.NaN;
	let group: HostRow[] = [];
	const flush = () => {
		if (group.length === 0) return;
		out.push(group.length === 1 ? (group[0] as HostRow) : meanOf(group));
		group = [];
	};
	for (const r of rows) {
		const bucket = Math.floor(r.t / stretch);
		if (bucket !== at) {
			flush();
			at = bucket;
		}
		group.push(r);
	}
	flush();
	return out;
}

function meanOf(group: HostRow[]): HostRow {
	const mean = (pick: (r: HostRow) => number | null): number | null => {
		let n = 0;
		let sum = 0;
		for (const r of group) {
			const v = pick(r);
			if (v === null) continue;
			n++;
			sum += v;
		}
		return n === 0 ? null : Math.round((sum / n) * 10) / 10;
	};
	let pressure: Pressure | null = null;
	for (const r of group) if (r.pressure !== null) pressure = Math.max(pressure ?? 0, r.pressure) as Pressure;
	return {
		t: (group.at(-1) as HostRow).t,
		cpu: mean((r) => r.cpu) ?? 0,
		gpu: mean((r) => r.gpu),
		mem: mean((r) => r.mem),
		pressure,
	};
}

/** A stretch of a graph under pressure: from `from` to `to` (epoch ms), at the level the system said (1 warning, 2 critical). */
export interface PressureRun {
	from: number;
	to: number;
	level: 1 | 2;
}

/**
 * The stretches where memory pressure was above normal. A look's level holds until the next look, so a stretch is drawn from
 * the first such look to the look that ends it, and never across a gap longer than `gapMs`. Neighbouring looks at the
 * same level are one stretch.
 */
export function pressureRuns(rows: HostRow[], gapMs: number): PressureRun[] {
	const runs: PressureRun[] = [];
	for (let i = 0; i + 1 < rows.length; i++) {
		const row = rows[i] as HostRow;
		const next = rows[i + 1] as HostRow;
		const level = row.pressure === null || row.pressure < 1 ? 0 : (Math.min(2, row.pressure) as 1 | 2);
		if (level === 0 || next.t - row.t > gapMs) continue;
		const last = runs.at(-1);
		if (last && last.to === row.t && last.level === level) last.to = next.t;
		else runs.push({ from: row.t, to: next.t, level });
	}
	return runs;
}

/**
 * Where a graph of `[start, end]` has its time marks: every `stepMs` on the clock of the viewer's zone (`offsetMs` is how far
 * that zone is ahead of UTC), so that an hour is marked at :00, :15, :30 and :45 and not at wherever the history happens to start.
 */
export function clockTicks(start: number, end: number, stepMs: number, offsetMs: number): number[] {
	const ticks: number[] = [];
	for (let t = Math.ceil((start + offsetMs) / stepMs) * stepMs - offsetMs; t <= end; t += stepMs) ticks.push(t);
	return ticks;
}

/** The steps a graph's time marks may be a clock's apart: a minute, up to half a day. */
const TICK_STEPS_MS = [1, 5, 10, 15, 30, 60, 180, 360, 720].map((m) => m * 60_000);

/** The gap between two time marks that gives a graph of `extentMs` about four to five of them. */
export function tickStep(extentMs: number): number {
	return TICK_STEPS_MS.find((s) => extentMs / s <= 5) ?? (TICK_STEPS_MS.at(-1) as number);
}

/** The largest of a column of a graph, or null when it has no figure. */
export function peakOf(rows: HostRow[], pick: (r: HostRow) => number | null): number | null {
	let peak: number | null = null;
	for (const r of rows) {
		const v = pick(r);
		if (v !== null && (peak === null || v > peak)) peak = v;
	}
	return peak;
}

/** A share of the whole as people read it: `12%`; a dash for a figure the host does not have. */
export function fmtShare(v: number | null | undefined): string {
	return v === null || v === undefined ? "—" : `${Math.round(v)}%`;
}

/** A process's CPU use, as a share of one core: a tenth below 10%, whole above (it may be above 100%: more than one core). */
export function fmtCore(v: number | null | undefined): string {
	if (v === null || v === undefined) return "—";
	return `${v < 10 ? (Math.round(v * 10) / 10).toFixed(1) : Math.round(v)}%`;
}

/** Bytes of memory as Activity Monitor writes them (decimal units): 412 MB, 9.8 GB, 24 GB. */
export function fmtMem(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let i = 0;
	while (value >= 1000 && i < units.length - 1) {
		value /= 1000;
		i++;
	}
	const text = value >= 100 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
	return `${text} ${units[i]}`;
}
