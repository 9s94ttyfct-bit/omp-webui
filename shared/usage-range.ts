/**
 * How far back Usage & cost looks (#714). `omp stats --json` answers only its own rolling 24 hours, so the page asks the
 * server for a range and the server reads omp's statistics database for it (`server/omp/stats-db.ts`).
 */
export type UsageRange = "24h" | "7d" | "30d" | "all";

export const USAGE_RANGES: readonly UsageRange[] = ["24h", "7d", "30d", "all"];

/** What the page opens on: a month shows a trend without asking the database for everything. */
export const DEFAULT_USAGE_RANGE: UsageRange = "30d";

export function isUsageRange(v: unknown): v is UsageRange {
	return typeof v === "string" && (USAGE_RANGES as readonly string[]).includes(v);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The window of `range` ending at `now`, both ends inclusive, in milliseconds. One window is decided per request and used
 * for every figure of the answer, the guard's share included, so no part of the page counts what another leaves out.
 */
export function usageWindow(range: UsageRange, now: number): { from: number; to: number } {
	const span = range === "24h" ? DAY : range === "7d" ? 7 * DAY : range === "30d" ? 30 * DAY : null;
	return { from: span === null ? 0 : now - span, to: now };
}

/** The size of a chart's step for `range`: hours over a day, days beyond (an hourly month is 720 bars nobody can read). */
export function usageBucket(range: UsageRange): "hour" | "day" {
	return range === "24h" ? "hour" : "day";
}
