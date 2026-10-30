import { t } from "../i18n/index.ts";

/** How long something has run, in whole seconds: `7s`, `2m 05s`, `1h 02m` (`7秒`, `2分05秒`, `1小时02分`). */
export function fmtElapsed(ms: number): string {
	const total = Math.floor(Math.max(0, ms) / 1000);
	const s = total % 60;
	const m = Math.floor(total / 60) % 60;
	const h = Math.floor(total / 3600);
	if (h) return t("common.durHourMin", { h, m: String(m).padStart(2, "0") });
	if (m) return t("common.durMinSec", { m, s: String(s).padStart(2, "0") });
	return t("common.durSec", { s });
}
