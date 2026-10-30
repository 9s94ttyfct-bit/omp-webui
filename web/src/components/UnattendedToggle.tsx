import type { LiveUnattended } from "@shared/unattended.ts";
import { MoonStar } from "lucide-react";
import { type MutableRefObject, useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import { showPanelTab } from "../lib/panel-panes.ts";
import { questionsApi } from "../lib/questions-api.ts";
import { useQuestionsStrings } from "../lib/questions-strings.ts";
import type { StartLive } from "../lib/start-live.ts";
import { useApp } from "../store/app.ts";
import { cx } from "./ui.tsx";

/** The space the switch takes: a square, in every language, so what holds its place while its chunk loads is as wide (`New chat`'s footer). */
export const UNATTENDED_BAR = "h-8 w-8 shrink-0 rounded-lg bg-hover";

const WHY = {
	trustedExtension: "questions.skippedTrusted",
	inherited: "questions.skippedInherited",
	unavailable: "questions.skippedUnavailable",
} as const;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The switch for unattended mode (#646) next to the message box: while it is on the agent is told the person is away, goes on
 * with what needs no decision and files what does as a question (the sidebar's Questions). It is one conversation's: a change
 * reaches the next turn of a running conversation without a restart, and is kept with the conversation for when it is opened again.
 *
 * On New chat (`pick`) it acts on the warm-up process and is kept by the page for the processes started afterwards. Without
 * a process (`liveId` null: a saved conversation) it shows what the conversation was left as, and turning it starts omp
 * (`start`) first. While the conversation has questions waiting, a chip with their number opens them.
 *
 * A chunk of its own, with its strings (`lib/questions-strings.ts`): most people never turn it on.
 */
export default function UnattendedToggle({
	liveId,
	file,
	start,
	pick,
}: {
	liveId: string | null;
	/** The conversation's session file (a conversation that has one), for the questions it has waiting and for what was kept for it. */
	file?: string | null;
	start?: StartLive;
	/** New chat: what the page has picked (or the default), read until the warm-up process has been told, and written when the switch is flipped (kept for the processes started later). */
	pick?: MutableRefObject<boolean>;
}) {
	const t = useT();
	const ready = useQuestionsStrings();
	const toast = useApp((s) => s.toast);
	const info = useApp((s) => (liveId ? s.lives[liveId]?.info : undefined));
	// The questions waiting are the conversation's: its panel's Questions tab (#693), which opens the page of every conversation's.
	const waiting = useApp((s) => (file ? (s.meta?.questions?.byConversation[file] ?? 0) : 0));
	const [kept, setKept] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);
	// A conversation with no process: what was kept for it, read once per conversation.
	useEffect(() => {
		if (liveId || !file) return;
		let live = true;
		setKept(null);
		questionsApi.ofFile(file).then(
			(on) => live && setKept(on),
			() => live && setKept(false),
		);
		return () => {
			live = false;
		};
	}, [liveId, file]);
	if (!ready) return <span aria-hidden data-testid="unattended-skeleton" className={UNATTENDED_BAR} />;
	const on = liveId
		? info?.unattended !== undefined || (info === undefined && pick?.current === true)
		: (kept ?? pick?.current ?? false);
	const skipped: LiveUnattended["skipped"] = info?.unattended?.skipped;
	const toggle = async () => {
		if (busy) return;
		const next = !on;
		setBusy(true);
		try {
			const id = liveId ?? (await start?.()) ?? null;
			if (!id) return;
			await questionsApi.setLive(id, next);
			setKept(next);
			if (pick) pick.current = next;
		} catch (e) {
			toast("error", t("questions.toggleFailed", { error: messageOf(e) }));
		} finally {
			setBusy(false);
		}
	};
	// The switch and the chip are one thing to the row they sit in: a footer too narrow for both wraps them together, not
	// the chip alone onto a line of its own.
	return (
		<span className="inline-flex shrink-0 items-center gap-1">
			<button
				type="button"
				role="switch"
				aria-checked={on}
				aria-busy={busy || undefined}
				aria-label={t("questions.toggleLabel")}
				title={skipped ? t(WHY[skipped]) : t("questions.toggleTitle")}
				data-testid="unattended-toggle"
				data-state={on ? "on" : "off"}
				disabled={busy}
				className={cx(
					"inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
					// On is a shape as well as a tint (a ring and a filled moon): a tint alone is lost on someone who cannot tell
					// the colours apart.
					on ? "bg-accent-soft text-accent ring-1 ring-accent/60" : "text-muted hover:bg-hover hover:text-fg",
				)}
				onClick={() => void toggle()}
			>
				<MoonStar size={14} aria-hidden fill={on ? "currentColor" : "none"} />
			</button>
			{on && skipped ? (
				<span className="sr-only" role="status" data-testid="unattended-skipped">
					{t(WHY[skipped])}
				</span>
			) : null}
			{waiting > 0 ? (
				<button
					type="button"
					data-testid="unattended-chip"
					title={t("questions.chipTitle")}
					className="inline-flex h-8 shrink-0 items-center rounded-lg bg-accent-soft px-2 text-xs font-medium text-accent hover:brightness-110"
					onClick={() => showPanelTab("questions")}
				>
					{t("questions.chipOpen", { n: waiting })}
				</button>
			) : null}
		</span>
	);
}
