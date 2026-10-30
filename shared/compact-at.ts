/**
 * "Compact at": how much of the model's context window a conversation may use before omp compacts by itself.
 *
 * omp has two settings for the point: `compaction.thresholdPercent` (a share of the model's window) and
 * `compaction.thresholdTokens` (a count of tokens, which overrides the share). `-1` in both is "omp's own default": the
 * legacy behaviour that keeps a reserve free. The arithmetic here repeats omp's own
 * (packages/agent/src/compaction/compaction.ts: `rT`, `C4`, `BG` and `qi` in omp's bundled source), so that the panel
 * can say where omp will compact without being started to say it.
 *
 * omp's default keeps `max(15% of the window, reserveTokens ?? 16384)` free and compacts once the context passes what is
 * left: with 200k that is 170k, about 85%.
 */

/**
 * The shares the page offers, as the issue asks (50–95%). omp itself takes 1–100 and clamps to 99; below half the
 * window a conversation would compact so early that it hardly uses the model it pays for.
 */
export const COMPACT_PERCENT_MIN = 50;
export const COMPACT_PERCENT_MAX = 95;

/** omp's settings that decide the point, by their keys. */
export const COMPACT_KEYS = {
	percent: "compaction.thresholdPercent",
	tokens: "compaction.thresholdTokens",
	reserve: "compaction.reserveTokens",
	/**
	 * omp's per-model points (`provider/id`, `provider/…*`), applied over both settings above: a conversation whose
	 * model has one of those uses it, whatever value this page writes there.
	 */
	modelThresholds: "compaction.modelThresholds",
	/** omp's switch for `modelThresholds`; off, that record is not applied at all. */
	modelThresholdsEnabled: "compaction.modelThresholdsEnabled",
	/**
	 * omp's switch for going on with the turn after a compaction. A compact that holds a turn between two steps (#651) needs it:
	 * with it off, the turn the compact cut stays cut.
	 */
	autoContinue: "compaction.autoContinue",
} as const;

/** What omp keeps free when neither a reserve nor a share of the window is larger (`Pne` in omp's source). */
export const OMP_RESERVE_TOKENS = 16384;
/** The share of the window omp keeps free when `reserveTokens` is not set. */
const OMP_RESERVE_SHARE = 0.15;

/** A conversation's own compaction point: a share of the window, or a count of tokens. */
export type CompactAt = { percent: number } | { tokens: number };

/** A count of tokens omp would take: a positive whole number. */
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

/**
 * Whether `v` (a record from disk, or a reply from a page) is a compaction point this page can set: a share between
 * `COMPACT_PERCENT_MIN` and `COMPACT_PERCENT_MAX`, or a positive token count, and never both.
 */
export function isCompactAt(v: unknown): v is CompactAt {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const percent = "percent" in v ? v.percent : undefined;
	const tokens = "tokens" in v ? v.tokens : undefined;
	if (percent !== undefined && tokens !== undefined) return false;
	if (percent !== undefined) {
		return (
			typeof percent === "number" &&
			Number.isInteger(percent) &&
			percent >= COMPACT_PERCENT_MIN &&
			percent <= COMPACT_PERCENT_MAX
		);
	}
	return isCount(tokens);
}

/** `v` as a compaction point, or null: a value that is not one is never applied as a guess. */
export function compactAtOf(v: unknown): CompactAt | null {
	if (!isCompactAt(v)) return null;
	return "percent" in v ? { percent: v.percent } : { tokens: v.tokens };
}

/**
 * The `compaction` settings that say `at` for one process, as its `--config` overlay holds them: the one that names the
 * point, and `-1` (omp's "not this one") for the other, so that a value in the configuration underneath cannot win —
 * omp uses `thresholdTokens` over `thresholdPercent` whenever it is positive.
 */
export function compactAtWrites(at: CompactAt): Record<string, number> {
	return {
		[COMPACT_KEYS.percent]: "percent" in at ? at.percent : -1,
		[COMPACT_KEYS.tokens]: "tokens" in at ? at.tokens : -1,
	};
}

/** omp's settings for the point as they are configured; `-1` where a setting is unset or is omp's default. */
export interface CompactSettings {
	/** `compaction.thresholdPercent`. */
	percent: number;
	/** `compaction.thresholdTokens`. */
	tokens: number;
	/** `compaction.reserveTokens`, where it is set. */
	reserve?: number;
}

/** omp's settings for the point, read from one `omp config list --json` as omp resolves it. */
export function compactSettingsOf(listed: Readonly<Record<string, unknown>>): CompactSettings {
	const held = (key: string): number => {
		const value = listed[key];
		return typeof value === "number" && Number.isFinite(value) ? value : -1;
	};
	const reserve = listed[COMPACT_KEYS.reserve];
	return {
		percent: held(COMPACT_KEYS.percent),
		tokens: held(COMPACT_KEYS.tokens),
		...(typeof reserve === "number" && Number.isFinite(reserve) && reserve >= 0 ? { reserve } : {}),
	};
}

/**
 * What omp keeps free in a window of `window` tokens (`C4`): `max(15% of the window, reserveTokens ?? 16384)`, or the
 * bare 15% where that would leave nothing — when no reserve is configured and it would fill the window, or when it does.
 */
function reserveKept(window: number, settings: CompactSettings): number {
	const share = Math.max(1, Math.floor(window * OMP_RESERVE_SHARE));
	const reserve = Math.max(share, settings.reserve ?? OMP_RESERVE_TOKENS);
	if (settings.reserve === undefined && reserve >= window - share) return share;
	return reserve >= window ? share : reserve;
}

/** Where omp compacts when neither setting names a point: the window less the reserve it keeps free (`BG`). */
function defaultTrigger(window: number, settings: CompactSettings): number {
	return Math.max(0, Math.min(window - 1, window - reserveKept(window, settings)));
}

/**
 * The count of tokens at which omp compacts in a window of `window` tokens with `settings` (`qi`): the count itself, the
 * share of the window, or omp's default. Zero for a window omp cannot count. A count at or above the window is omp's cue
 * to fall back to the default, not to compact every turn.
 */
export function ompTriggerTokens(settings: CompactSettings, window: number): number {
	if (!(window > 0)) return 0;
	if (settings.tokens > 0) {
		return settings.tokens >= window
			? defaultTrigger(window, settings)
			: Math.min(window - 1, Math.max(1, settings.tokens));
	}
	if (settings.percent > 0) {
		const share = Math.min(99, Math.max(1, settings.percent));
		return Math.floor((window * share) / 100);
	}
	return defaultTrigger(window, settings);
}

/** The share of a window of `window` tokens that `tokens` is, to one decimal. */
export function shareOfTokens(tokens: number, window: number): number {
	if (!(window > 0)) return 0;
	return Math.round((tokens / window) * 1000) / 10;
}

/** The point omp's settings name, in the page's own words: the count where one is set, else the share, else null (omp's default). */
export function pointOf(settings: CompactSettings): CompactAt | null {
	if (settings.tokens > 0) return { tokens: settings.tokens };
	if (settings.percent > 0) return { percent: Math.min(99, Math.max(1, Math.round(settings.percent))) };
	return null;
}

/** Whether two points are the same one (null being omp's default, which is the same wherever it is compared). */
export function sameCompactAt(a: CompactAt | null, b: CompactAt | null): boolean {
	if (a === null || b === null) return a === b;
	if ("percent" in a && "percent" in b) return a.percent === b.percent;
	if ("tokens" in a && "tokens" in b) return a.tokens === b.tokens;
	return false;
}

/** Where omp will compact, for the page: a count of tokens and the share of the window it is. */
export interface CompactTrigger {
	tokens: number;
	/** The share of the window, to one decimal. */
	percent: number;
	window: number;
	/** What decided it: this conversation's own point, omp's configuration, or omp's default. */
	source: "conversation" | "config" | "default";
}

/**
 * Where omp compacts for a conversation whose own point is `at` (null: it follows omp's configuration) on a window of
 * `window` tokens, with omp's settings as configured. Undefined for a window nothing can be said of (omp reports none,
 * or a model it cannot count).
 */
export function compactTrigger(
	at: CompactAt | null,
	settings: CompactSettings,
	window: number | undefined,
): CompactTrigger | undefined {
	if (window === undefined || !(window > 0)) return undefined;
	const writes = at ? compactAtWrites(at) : null;
	const effective: CompactSettings = writes
		? {
				percent: writes[COMPACT_KEYS.percent],
				tokens: writes[COMPACT_KEYS.tokens],
				...(settings.reserve === undefined ? {} : { reserve: settings.reserve }),
			}
		: settings;
	const tokens = ompTriggerTokens(effective, window);
	// A token count at or above the window is omp's cue to fall back to its own reserve, not to compact every turn.
	const named = at ?? pointOf(settings);
	const namedTokens = named !== null && "tokens" in named ? named.tokens : null;
	const fellBack = namedTokens !== null && namedTokens >= window;
	return {
		tokens,
		percent: shareOfTokens(tokens, window),
		window,
		source: fellBack ? "default" : at ? "conversation" : named !== null ? "config" : "default",
	};
}

/**
 * The entry of omp's `compaction.modelThresholds` that decides for `model` (`provider/id`), if one does: the exact
 * `provider/id` first, else the longest `provider/…*` prefix (`ZH`). One is applied over both settings this page writes
 * and over the reserve, so where it decides, the page says so rather than claiming its own value is in force.
 */
export function modelThresholdOf(
	record: unknown,
	selector: string | null | undefined,
): { key: string; value: unknown } | null {
	if (typeof record !== "object" || record === null || Array.isArray(record)) return null;
	if (typeof selector !== "string" || !selector.includes("/")) return null;
	const entries: Record<string, unknown> = { ...(record as Record<string, unknown>) };
	if (Object.hasOwn(entries, selector)) return { key: selector, value: entries[selector] };
	let found: { key: string; value: unknown } | null = null;
	for (const key of Object.keys(entries)) {
		if (!key.endsWith("*") || !selector.startsWith(key.slice(0, -1))) continue;
		if (!found || key.length > found.key.length) found = { key, value: entries[key] };
	}
	return found;
}
