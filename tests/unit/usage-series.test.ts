import { expect, test } from "bun:test";
import type { OmpStats } from "../../web/src/lib/api.ts";
import {
	dailyByModel,
	OTHER_MODELS,
	paddedDays,
	SERIES_COLORS,
	seriesColor,
	utcDate,
} from "../../web/src/lib/usage-series.ts";

/**
 * The usage chart's series (web/src/lib/usage-series.ts): the dearest models first, each its own palette colour, and
 * whatever the palette has no colour for added up under one "Other" instead of reusing one.
 */

/** omp's `costSeries` points are UTC days: each `timestamp` is that day's 00:00:00Z. */
const DAY = (n: number) => Date.UTC(2026, 0, n);

/** A cost series of `costs[i]` dollars a day for model `m<i>`, over `days` days. */
function stats(costs: number[], days = 2): OmpStats {
	const costSeries = Array.from({ length: days }, (_, d) =>
		costs.map((cost, i) => ({ timestamp: DAY(d + 1), model: `m${i}`, cost })),
	).flat();
	return { costSeries } as unknown as OmpStats;
}

test("models are listed dearest first, whatever order they first appeared in", () => {
	const { models } = dailyByModel(stats([1, 5, 3]));
	expect(models).toEqual(["m1", "m2", "m0"]);
});

test("up to as many models as the palette has colours keep a series each", () => {
	const costs = Array.from({ length: SERIES_COLORS }, (_, i) => SERIES_COLORS - i);
	const { models, rows } = dailyByModel(stats(costs));
	expect(models).toHaveLength(SERIES_COLORS);
	expect(models).not.toContain(OTHER_MODELS);
	expect(rows[0].m7).toBe(1);
});

test("with more, the cheapest add up under Other and no two series share a colour", () => {
	const costs = Array.from({ length: 11 }, (_, i) => 11 - i);
	const { models, rows } = dailyByModel(stats(costs));
	expect(models).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", OTHER_MODELS]);
	// m7..m10 cost 4 + 3 + 2 + 1 a day; they are not series of their own.
	expect(rows.map((r) => r[OTHER_MODELS])).toEqual([10, 10]);
	expect(rows[0].m7).toBeUndefined();
	// Nothing is lost: a day's total is every model's cost.
	expect(rows.map((r) => r.total)).toEqual([66, 66]);
	const colours = models.map((_, i) => seriesColor(i));
	expect(new Set(colours).size).toBe(models.length);
	expect(colours).toEqual(Array.from({ length: 8 }, (_, i) => `var(--chart-${i + 1})`));
});

test("a model dear on one day only is ranked by what it cost in all", () => {
	const costSeries = [
		{ timestamp: DAY(1), model: "steady", cost: 1 },
		{ timestamp: DAY(2), model: "steady", cost: 1 },
		{ timestamp: DAY(2), model: "spike", cost: 5 },
	];
	expect(dailyByModel({ costSeries } as unknown as OmpStats).models).toEqual(["spike", "steady"]);
});

test("days come out in order and no data is no rows", () => {
	const { rows } = dailyByModel({
		costSeries: [
			{ timestamp: DAY(3), model: "a", cost: 1 },
			{ timestamp: DAY(1), model: "a", cost: 2 },
		],
	} as unknown as OmpStats);
	expect(rows.map((r) => r.day)).toEqual(["2026-01-01", "2026-01-03"]);
	expect(dailyByModel({} as OmpStats)).toEqual({ rows: [], models: [] });
});

/** West of UTC (Honolulu, Chicago), UTC itself, and east of it (Shanghai, Auckland, Kiritimati at +14). */
const ZONES = ["UTC", "America/Chicago", "Pacific/Honolulu", "Asia/Shanghai", "Pacific/Auckland", "Pacific/Kiritimati"];
const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Runs `fn` with the process in `zone`, the way a browser in that zone would run the page. */
function inZone<T>(zone: string, fn: () => T): T {
	const before = process.env.TZ ?? SYSTEM_ZONE;
	process.env.TZ = zone;
	try {
		return fn();
	} finally {
		process.env.TZ = before;
	}
}

test("a day's bucket carries the date it covers, in every time zone (#293)", () => {
	const bucket = {
		costSeries: [{ timestamp: Date.UTC(2026, 9, 19), model: "m", cost: 1, requests: 17 }],
	} as unknown as OmpStats;
	for (const zone of ZONES) {
		const { rows } = inZone(zone, () => dailyByModel(bucket));
		expect(
			rows.map((r) => r.day),
			zone,
		).toEqual(["2026-10-19"]);
	}
});

test("two buckets a day apart are two days in every time zone, never merged or shifted together (#293)", () => {
	const two = {
		costSeries: [
			{ timestamp: Date.UTC(2026, 2, 8), model: "m", cost: 1 },
			{ timestamp: Date.UTC(2026, 2, 9), model: "m", cost: 2 },
			{ timestamp: Date.UTC(2026, 10, 1), model: "m", cost: 3 },
		],
	} as unknown as OmpStats;
	for (const zone of ZONES) {
		const { rows } = inZone(zone, () => dailyByModel(two));
		expect(
			rows.map((r) => r.day),
			zone,
		).toEqual(["2026-03-08", "2026-03-09", "2026-11-01"]);
		expect(
			rows.map((r) => r.total),
			zone,
		).toEqual([1, 2, 3]);
	}
});

test("the date printed for the first request is the label of the day it fell in, whatever the zone (#293)", () => {
	const startOfUtcDay = (ts: number) => ts - (ts % 86_400_000);
	// 10:37 in Chicago, just after midnight in Honolulu's evening, the last second of the UTC day.
	for (const first of [
		Date.UTC(2026, 9, 19, 15, 37, 55),
		Date.UTC(2026, 9, 19, 0, 0, 1),
		Date.UTC(2026, 9, 19, 23, 59, 59),
	]) {
		const bucket = { costSeries: [{ timestamp: startOfUtcDay(first), model: "m", cost: 1 }] } as unknown as OmpStats;
		for (const zone of ZONES) {
			const day = inZone(zone, () => ({ label: dailyByModel(bucket).rows[0].day, since: utcDate(first) }));
			expect(day.label, `${zone} ${new Date(first).toISOString()}`).toBe(day.since);
		}
	}
	expect(utcDate(Date.UTC(2026, 0, 5, 23, 59, 59, 999))).toBe("2026-01-05");
	expect(utcDate(Date.UTC(2026, 11, 31, 23, 0))).toBe("2026-12-31");
});

test("a chart of fewer than seven days is padded to a week with empty days before the first", () => {
	const { rows } = dailyByModel(stats([1], 2));
	expect(rows.map((r) => r.day)).toEqual(["2026-01-01", "2026-01-02"]);
	const padded = paddedDays(rows);
	expect(padded.map((r) => r.day)).toEqual([
		"2025-12-27",
		"2025-12-28",
		"2025-12-29",
		"2025-12-30",
		"2025-12-31",
		"2026-01-01",
		"2026-01-02",
	]);
	// Nothing is made up: the added days cost nothing and the real ones are the very rows.
	expect(padded.slice(0, 5).every((r) => r.total === 0)).toBe(true);
	expect(padded.slice(5)).toEqual(rows);
	// The table of days is made from the rows, not from the padding.
	expect(rows).toHaveLength(2);
});

test("a chart of a week or more, or of nothing, is left as it is", () => {
	const week = dailyByModel(stats([1], 7)).rows;
	expect(paddedDays(week)).toBe(week);
	expect(paddedDays([])).toEqual([]);
});
