import type { NoticeLang } from "../shared/attention.ts";
import type { UsageReport } from "../shared/protocol.ts";
import { limitsFor, remainingFraction } from "../shared/quota.ts";

/**
 * The quota lines of the macOS app's menu bar icon (`GET /api/shell/quota`): one per provider that `omp usage` reports a
 * share for, with what is left of the window that runs out first and when it frees up, in the language the person saved.
 * A provider with several accounts is shown by the one with the most left, as the page's quota pill picks it; only the
 * windows every model draws on count (`limitsFor` without a model), not one that caps a single model family.
 */
export function menuQuotaLines(reports: UsageReport[], lang: NoticeLang, now = Date.now()): string[] {
	const best = new Map<string, { fraction: number; resetsAt: number | null }>();
	for (const report of reports) {
		let tightest: { fraction: number; resetsAt: number | null } | null = null;
		for (const limit of limitsFor(report.limits, null)) {
			const fraction = remainingFraction(limit);
			if (fraction === null || (tightest && tightest.fraction <= fraction)) continue;
			tightest = { fraction, resetsAt: limit.window?.resetsAt ?? null };
		}
		if (!tightest) continue;
		const known = best.get(report.provider);
		if (!known || tightest.fraction > known.fraction) best.set(report.provider, tightest);
	}
	return [...best].map(([provider, { fraction, resetsAt }]) => {
		const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
		const left = lang === "zh-CN" ? `剩余 ${percent}%` : `${percent}% left`;
		const reset = resetsAt !== null && resetsAt > now ? resetWords(resetsAt, lang, now) : null;
		return reset ? `${provider}: ${left} · ${reset}` : `${provider}: ${left}`;
	});
}

/** When a window frees up: the time today or within a day, else the day and the time, in this computer's time zone. */
function resetWords(at: number, lang: NoticeLang, now: number): string {
	const soon = at - now < 24 * 3_600_000;
	const when = new Intl.DateTimeFormat(lang, {
		...(soon ? {} : { weekday: "short" }),
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(at);
	return lang === "zh-CN" ? `${when} 重置` : `resets ${when}`;
}
