import { type MessageKey, t as translate, type Vars } from "../i18n/index.ts";
import type { RpcState } from "../store/live.ts";

/** What the status line says of an account past its usage limit (`usageLimit` of `get_state`), as omp's own status line does. */

export type UsageLimit = NonNullable<RpcState["usageLimit"]>;

/** A reset more than this far away is named by its weekday too (omp's own cut-off). */
const DAY_MS = 20 * 3600 * 1000;

/** `02:30 PM`, or `Fri 02:30 PM` when it is not today: the time of an epoch-seconds reset on this machine's clock. */
export function resetTime(sec: number, now = Date.now()): string {
	const at = new Date(sec * 1000);
	return at.getTime() - now > DAY_MS
		? at.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
		: at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * The time left until a reset, as a countdown that rounds up so that it never reads zero before the time is up:
 * `2d 3h`, `1h 12m`, `12m 05s`, `45s` (`2天3小时`, `1小时12分`, `12分05秒`, `45秒`).
 */
export function fmtCountdown(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	if (seconds < 60) return translate("common.durSec", { s: seconds });
	if (seconds < 3600) {
		return translate("common.durMinSec", { m: Math.floor(seconds / 60), s: String(seconds % 60).padStart(2, "0") });
	}
	// Past an hour the seconds go unsaid, and the minutes round up in their place.
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 24 * 60) return translate("common.durHourMin", { h: Math.floor(minutes / 60), m: minutes % 60 });
	const hours = Math.ceil(minutes / 60);
	return translate("common.durDayHour", { d: Math.floor(hours / 24), h: hours % 24 });
}

/**
 * The line for the stage: `low priority until 02:30 PM · 62% left`, `limit reached · wrapping up · resets 02:30 PM`,
 * `limit reached · wrap-up, then extra usage`. Null for a stage omp has not documented.
 */
export function usageLimitLabel(
	limit: UsageLimit,
	t: (key: MessageKey, vars?: Vars) => string,
	now = Date.now(),
): string | null {
	const time = typeof limit.resetsAtSec === "number" ? resetTime(limit.resetsAtSec, now) : null;
	if (limit.stage === "low_priority") {
		if (time === null) return t("chat.statusUsageLowPriorityOpen");
		return typeof limit.allowanceLeftPercent === "number"
			? t("chat.statusUsageLowPriorityLeft", { time, percent: limit.allowanceLeftPercent })
			: t("chat.statusUsageLowPriority", { time });
	}
	if (limit.stage === "wrap_up") {
		if (limit.extraUsage) return t("chat.statusUsageWrapUpExtra");
		return time === null ? t("chat.statusUsageWrapUp") : t("chat.statusUsageWrapUpResets", { time });
	}
	return null;
}
