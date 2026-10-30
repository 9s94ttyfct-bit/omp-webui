import { type Lang, t } from "../i18n/index.ts";
import { fmtDuration } from "./format.ts";

/** How the turn stats line and the status line write their figures. */

/**
 * A running clock: whole seconds under a minute (a tenth of a second would shimmer as it ticks), then the app's
 * usual `5m 6s`, `13h 7m`, `2d 5h`.
 */
export function fmtElapsed(ms: number): string {
	const v = Math.max(0, ms);
	return v < 60_000 ? t("common.durSec", { s: Math.floor(v / 1000) }) : fmtDuration(v);
}

/** Tokens a second: a decimal while it is slow, whole numbers from 10 up. */
export function fmtRate(tokensPerSecond: number): string {
	return tokensPerSecond < 9.95 ? tokensPerSecond.toFixed(1) : Math.round(tokensPerSecond).toLocaleString("en-US");
}

const UNITS = [
	{ size: 1e9, suffix: "B" },
	{ size: 1e6, suffix: "M" },
	{ size: 1e3, suffix: "k" },
];

/** A context window or token budget as the TUI writes it: `1M`, `1.5M`, `200k`, with no needless zeros. */
export function fmtWindow(n: number): string {
	// A figure that would round up to 1000 of a unit (999,700 → "1000k") is written in the next one.
	const unit = UNITS.find((u) => n >= u.size * 0.9995);
	if (!unit) return String(Math.round(n));
	const v = n / unit.size;
	return `${v < 10 ? Number(v.toFixed(1)) : Math.round(v)}${unit.suffix}`;
}

const clocks: Record<string, Intl.DateTimeFormat> = {};

function clock(lang: Lang, part: "time" | "day" | "year"): Intl.DateTimeFormat {
	const key = `${lang}|${part}`;
	clocks[key] ??= new Intl.DateTimeFormat(lang, {
		...(part === "year" ? { year: "numeric" } : {}),
		...(part === "time" ? {} : { month: "short", day: "numeric" }),
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
	return clocks[key];
}

/**
 * When a turn finished, as the TUI prints it: the time of day (24-hour, with seconds) for today, and for another day
 * (or year) that too.
 */
export function fmtFinished(ts: number, now: number, lang: Lang): string {
	const d = new Date(ts);
	const today = new Date(now);
	if (d.toDateString() === today.toDateString()) return clock(lang, "time").format(d);
	return clock(lang, d.getFullYear() === today.getFullYear() ? "day" : "year").format(d);
}
