import type { OmpStats } from "./api.ts";

/** The palette defines eight series colours (`--chart-1` … `--chart-8`, palettes.css). */
export const SERIES_COLORS = 8;
/** The colour of the series at `index` in the chart; the palette's own, so the chart follows the palette and mode. */
export const seriesColor = (index: number) => `var(--chart-${(index % SERIES_COLORS) + 1})`;
/** The key the models beyond the palette's colours add up under. */
export const OTHER_MODELS = "__other";

/**
 * The calendar date (`2026-10-19`) of an instant in the page's time zone. The server's `costSeries` buckets are the
 * page's days (it is asked with the page's `tz`, and each `timestamp` is that day's local midnight), as omp's own are
 * its machine's days (omp 18.20.1 and later), so a bucket is labelled with the date it covers. The usage page prints the
 * date of the first request the same way, so the two never disagree.
 */
export function localDate(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The date `days` after the date `day` (`2026-10-19`), counted on the calendar, not in hours. */
function addDays(day: string, days: number): string {
	return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
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
		const day = localDate(Number(p.timestamp));
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
 * The rows the chart draws: `rows` (oldest first) with every day between the first and the last, an empty one where a day
 * cost nothing (the bars are evenly spaced, so two weeks without use must look like two weeks, not like neighbours), and
 * with empty days in front while there are fewer than a week of them, so that a lone day is one column among its week and
 * not the whole plot. The table of days lists only the real ones.
 */
export function paddedDays(rows: DailyRow[]): DailyRow[] {
	const first = rows[0];
	const last = rows.at(-1);
	if (!first || !last) return rows;
	const start = Date.parse(`${first.day}T00:00:00Z`);
	const span = Math.round((Date.parse(`${last.day}T00:00:00Z`) - start) / DAY_MS) + 1;
	if (span === rows.length && span >= MIN_CHART_DAYS) return rows;
	const byDay = new Map(rows.map((r) => [r.day, r]));
	const missing = Math.max(0, MIN_CHART_DAYS - span);
	return Array.from({ length: missing + span }, (_, i) => {
		const day = addDays(first.day, i - missing);
		return byDay.get(day) ?? { day, total: 0 };
	});
}
