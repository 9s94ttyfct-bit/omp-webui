import { type Lang, t, useLang } from "../i18n/index.ts";

export function fmtTokens(n: number | undefined | null): string {
	const v = n ?? 0;
	if (v < 1000) return String(Math.round(v));
	if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
	if (v < 1_000_000_000) return `${(v / 1_000_000).toFixed(v < 10_000_000 ? 2 : 1)}M`;
	return `${(v / 1_000_000_000).toFixed(2)}B`;
}

export function fmtCost(n: number | undefined | null): string {
	const v = n ?? 0;
	if (v === 0) return "$0";
	if (v < 0.01) return `$${v.toFixed(4)}`;
	if (v < 100) return `$${v.toFixed(2)}`;
	return `$${Math.round(v).toLocaleString()}`;
}

/**
 * Writes the costs of one column with the same number of decimals, so that their points line up (`$0.06` over `$0.0040`
 * do not): two, or four when any of them is under a cent.
 */
export function costColumn(values: number[]): (n: number) => string {
	const digits = values.some((v) => v > 0 && v < 0.01) ? 4 : 2;
	return (n) => {
		const [whole, fraction] = n.toFixed(digits).split(".");
		return `$${Number(whole).toLocaleString()}.${fraction}`;
	};
}

/** Full-precision cost for tooltips and exact comparisons. */
export function fmtCostExact(n: number | undefined | null): string {
	return `$${(n ?? 0).toFixed(6)}`;
}

/** The units belong to the language (`common.dur*`): `5m 7s` / `5分7秒`. */
export function fmtDuration(ms: number | undefined | null): string {
	const v = Math.max(0, ms ?? 0);
	if (v < 1000) return t("common.durMs", { n: Math.round(v) });
	if (v < 60_000) return t("common.durSec", { s: (v / 1000).toFixed(1) });
	if (v < 3_600_000) {
		return t("common.durMinSec", { m: Math.floor(v / 60_000), s: Math.floor((v % 60_000) / 1000) });
	}
	if (v < 86_400_000) {
		return t("common.durHourMin", { h: Math.floor(v / 3_600_000), m: Math.floor((v % 3_600_000) / 60_000) });
	}
	return t("common.durDayHour", { d: Math.floor(v / 86_400_000), h: Math.floor((v % 86_400_000) / 3_600_000) });
}

const rtfs: Partial<Record<Lang, Intl.RelativeTimeFormat>> = {};

function relativeFormat(lang: Lang): Intl.RelativeTimeFormat {
	let f = rtfs[lang];
	if (!f) {
		f = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
		rtfs[lang] = f;
	}
	return f;
}

export function fmtRelative(ts: number | string): string {
	const t = typeof ts === "string" ? Date.parse(ts) : ts;
	const lang = useLang.getState().lang;
	const rtf = relativeFormat(lang);
	const diff = (t - Date.now()) / 1000;
	const abs = Math.abs(diff);
	if (abs < 60) return rtf.format(Math.round(diff), "second");
	if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
	if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
	if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
	return new Date(t).toLocaleDateString(lang);
}

/**
 * One `Intl.DateTimeFormat` per language and shape: `toLocale*String` with a locale builds a new one on every call
 * (about 15 µs each), which a long transcript pays several times per reply and tool call (#691's start times).
 */
const DATE_SHAPES = {
	// What `toLocaleString(lang)` shows: the numeric date and the time.
	full: { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" },
	clock: { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
	day: { month: "short", day: "numeric" },
	dayYear: { month: "short", day: "numeric", year: "numeric" },
	month: { year: "numeric", month: "long" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;
const dtfs = new Map<string, Intl.DateTimeFormat>();

function dateFormat(lang: Lang, shape: keyof typeof DATE_SHAPES): Intl.DateTimeFormat {
	const key = `${lang}\0${shape}`;
	let f = dtfs.get(key);
	if (!f) {
		f = new Intl.DateTimeFormat(lang, DATE_SHAPES[shape]);
		dtfs.set(key, f);
	}
	return f;
}

export function fmtTime(ts: number | string): string {
	const t = typeof ts === "string" ? Date.parse(ts) : ts;
	return dateFormat(useLang.getState().lang, "full").format(t);
}

/**
 * When something started, as a clock says it (#691): `14:32:07` today, with the date before it on another day
 * (`Oct 26, 14:32:07` / `10月26日 14:32:07`). 24-hour, in the page's language and time zone.
 */
export function fmtClock(ts: number, now = Date.now()): string {
	const lang = useLang.getState().lang;
	const d = new Date(ts);
	const time = dateFormat(lang, "clock").format(d);
	if (d.toDateString() === new Date(now).toDateString()) return time;
	const sameYear = d.getFullYear() === new Date(now).getFullYear();
	return `${dateFormat(lang, sameYear ? "day" : "dayYear").format(d)} ${time}`;
}

/** Bucket label for the sidebar's date grouping. */
export function dateGroup(ts: number): string {
	const d = new Date(ts);
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const day = 86_400_000;
	if (d >= today) return t("shell.dateToday");
	if (d.getTime() >= today.getTime() - day) return t("shell.dateYesterday");
	if (d.getTime() >= today.getTime() - 7 * day) return t("shell.datePrevious7");
	if (d.getTime() >= today.getTime() - 30 * day) return t("shell.datePrevious30");
	return dateFormat(useLang.getState().lang, "month").format(d);
}

export function shortPath(p: string, home?: string): string {
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
