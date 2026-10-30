import { Pause, Play, Square } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { fmtDuration } from "../lib/format.ts";
import { imeKey } from "../lib/ime.ts";
import { serverOffsetMs } from "../lib/server-clock.ts";
import { Kbd, Tip } from "./ui.tsx";

/**
 * Shown above the composer while a conversation's omp is frozen (pause). It names what is frozen, and offers the two
 * ways out: Resume, which lets it carry on, and Stop, which resumes just long enough to cancel it (Esc asks first, and
 * a second Esc does the same, while focus is in the banner). `since` is the server's stamp of when it froze it, on the
 * server's clock: it is read on this page's before it is measured against it (see `server-clock.ts`).
 */
export function PausedBanner({
	since,
	commands,
	onResume,
	onStop,
	onStopKey,
	resumeRef,
}: {
	since: number;
	/** The `!commands` that are frozen. */
	commands: string[];
	onResume: () => void;
	/** The Stop button: stops at once. */
	onStop: () => void;
	/** Esc: the page asks before it stops. */
	onStopKey: () => void;
	resumeRef?: RefObject<HTMLButtonElement | null>;
}) {
	const t = useT();
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);
	const frozenMs = now - (since - serverOffsetMs());
	return (
		<div
			// Wraps: on a phone the buttons take a row of their own, not the text, which a column beside them wrapped to ten lines.
			className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-accent/30 bg-accent-soft px-3 py-2 text-sm"
			role="status"
			data-testid="paused-banner"
			onKeyDown={(e) => {
				if (e.key !== "Escape" || imeKey(e)) return;
				e.preventDefault();
				if (!e.repeat) onStopKey();
			}}
		>
			<Pause size={15} className="shrink-0 text-accent" fill="currentColor" />
			<div className="min-w-0 flex-1 basis-56">
				<div className="font-medium">
					{/* Under a second a duration says nothing (it read "Paused · 0ms"): the title stands alone until it does. */}
					{frozenMs >= 1000 ? t("chat.pausedTitle", { time: fmtDuration(frozenMs) }) : t("chat.pausedTitleBare")}
				</div>
				{commands.length ? (
					<div className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted">
						<span className="shrink-0">{t("chat.pausedFrozen")}</span>
						<code className="truncate font-mono text-fg" title={commands.join("\n")}>
							{commands.join(" · ")}
						</code>
					</div>
				) : null}
				<div className="text-xs text-muted">{t(commands.length ? "chat.pausedHintCommand" : "chat.pausedHint")}</div>
				<div className="text-xs text-faint" data-testid="paused-kept">
					{t("chat.pausedKept")}
				</div>
			</div>
			<Tip
				label={
					<span>
						{t("chat.pausedStopTip")} <Kbd>Esc</Kbd> <Kbd>Esc</Kbd>
					</span>
				}
			>
				<button
					type="button"
					data-testid="paused-stop"
					className="ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-xs font-medium hover:bg-hover"
					onClick={onStop}
				>
					<Square size={11} fill="currentColor" /> {t("chat.composerStop")}
				</button>
			</Tip>
			<button
				type="button"
				ref={resumeRef}
				data-testid="paused-resume"
				className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 text-xs font-medium text-accent-fg hover:brightness-110"
				onClick={onResume}
			>
				<Play size={12} fill="currentColor" /> {t("chat.composerResume")}
			</button>
		</div>
	);
}

/**
 * Where focus goes when the conversation on screen is paused or resumed: pausing takes the Pause button away, so
 * focus moves to Resume; resuming (or stopping) takes the banner away, so it returns to the composer. Opening an
 * already paused conversation moves nothing.
 */
export function usePausedFocus(
	liveId: string | null,
	paused: boolean,
	resume: RefObject<HTMLElement | null>,
	composer: RefObject<{ focus(): void } | null>,
): void {
	const seen = useRef({ liveId, paused });
	useEffect(() => {
		const before = seen.current;
		seen.current = { liveId, paused };
		if (before.liveId !== liveId || before.paused === paused) return;
		if (paused) resume.current?.focus();
		else composer.current?.focus();
	}, [liveId, paused, resume, composer]);
}
