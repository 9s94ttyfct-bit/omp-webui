import "../i18n/later.ts";
import { useLang, useT } from "../i18n/index.ts";
import { fmtClock, fmtTime } from "../lib/format.ts";

/**
 * The clock time a reply or a tool call started (#691): `14:32:07`, the date too when it is not today. Fixed-width digits
 * and no wrapping, so the line it sits on keeps its shape; the full date and time are its tooltip.
 */
export function StartTime({ at, className }: { at: number | undefined; className?: string }) {
	const t = useT();
	useLang((s) => s.lang);
	if (at === undefined || !Number.isFinite(at) || at <= 0) return null;
	return (
		<time
			dateTime={new Date(at).toISOString()}
			data-testid="start-time"
			title={t("chat.startedAt", { time: fmtTime(at) })}
			className={className ?? "shrink-0 whitespace-nowrap text-xs text-faint tabular-nums"}
		>
			{fmtClock(at)}
		</time>
	);
}
