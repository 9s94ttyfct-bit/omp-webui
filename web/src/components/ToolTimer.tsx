import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { fmtElapsed } from "../lib/clock.ts";
import { fmtDuration } from "../lib/format.ts";
import { useNow } from "../lib/now.ts";
import type { ToolTimer as Timer } from "../lib/tool-time.ts";

const CLASS = "shrink-0 text-xs text-muted tabular-nums";

/**
 * How long a tool call has run, or ran (#657). The ticking lives here and nowhere else: a card holds `since` or `ms`, which
 * do not change while it runs, so it is not drawn again each second, nor are the rows around it (`sameRow`).
 */
export function ToolTimer({ timer }: { timer: Timer }) {
	return timer.state === "running" ? <Running since={timer.since} /> : <Done ms={timer.ms} />;
}

/** Whole seconds, once the call has run for one: a call that returns at once never flashes a "0s". */
function Running({ since }: { since: number }) {
	const t = useT();
	const ms = useNow(1000) - since;
	if (ms < 1000) return null;
	const time = fmtElapsed(ms);
	return (
		<span className={CLASS} data-testid="tool-timer" data-state="running" title={t("chat.toolTimerRunning", { time })}>
			{time}
		</span>
	);
}

function Done({ ms }: { ms: number }) {
	const t = useT();
	const time = fmtDuration(ms);
	return (
		<span className={CLASS} data-testid="tool-timer" data-state="done" title={t("chat.toolTimerDone", { time })}>
			{time}
		</span>
	);
}
