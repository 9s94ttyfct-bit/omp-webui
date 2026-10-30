import { Pause, Square } from "lucide-react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { fmtDuration } from "../lib/format.ts";
import { useNow } from "../lib/now.ts";
import { useToolTimerMode } from "../lib/tool-timer.ts";
import { NO_BASH, useApp } from "../store/app.ts";
import { Badge, Button, Spinner, Tip } from "./ui.tsx";

/**
 * The `!commands` a process is running, a card each: the command, how long it has run, whether it is frozen
 * (the conversation is paused) and a Stop. omp has a single abort for all its running commands, so with more than
 * one running the button says it stops them all.
 */
export function PendingCommands({ liveId, onStop }: { liveId: string; onStop: () => void }) {
	const t = useT();
	const runs = useApp((s) => s.bash[liveId] ?? NO_BASH);
	const paused = useApp((s) => Boolean(s.lives[liveId]?.info.pausedAt));
	// The clock is the setting's (#657): off, nothing ticks and nothing shows.
	const timed = useToolTimerMode() !== "off";
	const now = useNow(runs.length && timed ? 200 : null);
	if (!runs.length) return null;
	const many = runs.length > 1;
	const stop = (
		<Button size="sm" variant="outline" data-testid="pending-stop" onClick={onStop}>
			<Square size={10} fill="currentColor" /> {many ? t("chat.pendingStopAll") : t("chat.composerStop")}
		</Button>
	);
	return (
		<ul className="mb-2 flex flex-col gap-1.5" aria-label={t("chat.pendingAria")}>
			{runs.map((r) => (
				<li
					key={r.id}
					className="flex items-center gap-2.5 rounded-xl border border-border bg-bg-soft py-2 pr-2 pl-3 text-sm"
					data-testid="pending-command"
					data-paused={paused}
				>
					{paused ? (
						<Pause size={14} className="shrink-0 text-accent" fill="currentColor" aria-hidden />
					) : (
						<Spinner size={14} className="shrink-0 text-accent" />
					)}
					<span className="shrink-0 font-mono text-accent">!</span>
					<span className="min-w-0 flex-1 truncate font-mono text-xs" title={r.command}>
						{r.command}
					</span>
					{timed ? (
						<span className="shrink-0 text-xs text-muted tabular-nums" data-testid="pending-time">
							{fmtDuration(now - r.startedAt)}
						</span>
					) : null}
					{paused ? <Badge tone="accent">{t("chat.pendingPaused")}</Badge> : null}
					{many ? <Tip label={t("chat.pendingStopAllTip")}>{stop}</Tip> : stop}
				</li>
			))}
		</ul>
	);
}
