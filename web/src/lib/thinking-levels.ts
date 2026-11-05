import type { MessageKey, Translate } from "../i18n/index.ts";

/** omp's thinking levels (`omp --thinking`); one omp does not name here is shown as it reports it. */
const LEVEL_LABELS: Record<string, MessageKey> = {
	off: "panel.thinkingOff",
	minimal: "panel.thinkingMinimal",
	low: "panel.thinkingLow",
	medium: "panel.thinkingMedium",
	high: "panel.thinkingHigh",
	xhigh: "panel.thinkingXhigh",
	max: "panel.thinkingMax",
	auto: "panel.thinkingAuto",
};

/** A thinking level by its name. */
export function levelName(t: Translate, level: string): string {
	return Object.hasOwn(LEVEL_LABELS, level) ? t(LEVEL_LABELS[level]) : level;
}

/** A thinking level as a person reads it; `auto` with the level omp resolved it to, when that is given. */
export function levelText(t: Translate, level: string, resolved?: string): string {
	return level === "auto" && resolved && resolved !== "auto"
		? t("panel.thinkingAutoResolved", { level: levelName(t, resolved) })
		: levelName(t, level);
}
