import type { OmpStats } from "./api.ts";

/** The palette defines eight series colours (`--chart-1` … `--chart-8`, palettes.css). */
export const SERIES_COLORS = 8;
/** The colour of the series at `index` in the chart; the palette's own, so the chart follows the palette and mode. */
export const seriesColor = (index: number) => `var(--chart-${(index % SERIES_COLORS) + 1})`;
/** The key the models beyond the palette's colours add up under. */
export const OTHER_MODELS = "__other";

/**
 * The UTC calendar date (`2026-10-19`) of an instant. omp's `costSeries` buckets are UTC days (each `timestamp` is that
 * day's 00:00:00Z, and a bucket holds nothing finer), so a bucket is labelled with the date it covers, not with the
 * viewer's local date of its start, which is the day before in every zone west of UTC. The usage page prints the date
 * of the first request the same way, so the two never disagree.
 */
export function utcDate(ts: number): string {
	const d = new Date(ts);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export interface DailyRow {
	day: string;
	total: number;
	[model: string]: number | string;
}

/**
 * Daily cost per model from omp's `costSeries` (one point per day × model). Models are listed by what they cost in all,
 * the dearest first; when there are more than the chart has colours for, the cheapest add up under `OTHER_MODELS`, so
 * no two series ever share a colour.
 */
export function dailyByModel(stats: OmpStats): { rows: DailyRow[]; models: string[] } {
	const cost = new Map<string, number>();
	for (const p of stats.costSeries ?? []) {
		const model = String(p.model);
		cost.set(model, (cost.get(model) ?? 0) + Number(p.cost ?? 0));
	}
	const ranked = [...cost.keys()].sort((a, b) => (cost.get(b) ?? 0) - (cost.get(a) ?? 0));
	const named = new Set(ranked.length > SERIES_COLORS ? ranked.slice(0, SERIES_COLORS - 1) : ranked);
	const byDay = new Map<string, DailyRow>();
	for (const p of stats.costSeries ?? []) {
		const day = utcDate(Number(p.timestamp));
		const model = named.has(String(p.model)) ? String(p.model) : OTHER_MODELS;
		const row = byDay.get(day) ?? { day, total: 0 };
		row[model] = Number(row[model] ?? 0) + Number(p.cost ?? 0);
		row.total += Number(p.cost ?? 0);
		byDay.set(day, row);
	}
	const models = ranked.filter((m) => named.has(m));
	if (named.size < ranked.length) models.push(OTHER_MODELS);
	return { rows: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)), models };
}

/** Fewer days than this and one day would be one bar as wide as the plot: the chart spans at least a week. */
export const MIN_CHART_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * The rows the chart draws: `rows` (oldest first), with empty days in front while there are fewer than a week of them, so
 * that a lone day is one column among its week and not the whole plot. The table of days lists only the real ones.
 */
export function paddedDays(rows: DailyRow[]): DailyRow[] {
	const first = rows[0];
	if (!first || rows.length >= MIN_CHART_DAYS) return rows;
	const missing = MIN_CHART_DAYS - rows.length;
	const start = Date.parse(`${first.day}T00:00:00Z`);
	const before = Array.from({ length: missing }, (_, i) => ({
		day: utcDate(start - (missing - i) * DAY_MS),
		total: 0,
	}));
	return [...before, ...rows];
}
