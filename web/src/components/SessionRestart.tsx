import { RotateCcw } from "lucide-react";
import { useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { errorText } from "../lib/error-text.ts";
import { socket } from "../lib/ws.ts";
import { attachLiveForFile, useApp } from "../store/app.ts";
import { Button } from "./ui.tsx";

/**
 * Force restart (`SessionControls`' "This session" panel): the turn that runs is aborted, and the conversation's omp is ended
 * with everything it started and started again on the same session file — the path the agent's own `restart_session` takes
 * (`shared/restart.ts`), for a conversation that hangs. It asks once before it cuts anything off. A paused conversation is
 * not restarted (the server refuses it): resume it first. The page follows to the new process.
 */
export default function SessionRestart({ liveId }: { liveId: string }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const info = useApp((s) => s.lives[liveId]?.info);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	if (!info) return null;
	const paused = Boolean(info.pausedAt);

	const restart = async () => {
		setBusy(true);
		try {
			const answer = await socket.request<{ liveId: string }>({ t: "force_restart", liveId });
			// The conversation is on another process now: the page listens to it and shows it.
			if (info.sessionFile) await attachLiveForFile(info.sessionFile, answer.liveId);
		} catch (e) {
			toast("error", t("panel.controlsRestartFailed", { error: errorText(e) }));
		} finally {
			setBusy(false);
			setConfirming(false);
		}
	};

	return (
		<section
			className="mt-4 border-t border-border pt-3"
			data-testid="session-restart"
			aria-label={t("panel.controlsRestartTitle")}
		>
			<div className="flex items-center justify-between gap-2">
				<div className="text-sm font-semibold">{t("panel.controlsRestartTitle")}</div>
				{confirming ? null : (
					<Button
						size="sm"
						type="button"
						disabled={busy || paused || !info.sessionFile}
						data-testid="session-restart-button"
						onClick={() => setConfirming(true)}
					>
						<RotateCcw size={13} aria-hidden />
						{t("panel.controlsRestartButton")}
					</Button>
				)}
			</div>
			<p className="mt-1 text-xs text-muted">{t("panel.controlsRestartHint")}</p>
			{paused ? (
				<p className="mt-1.5 text-xs text-muted" data-testid="session-restart-paused">
					{t("panel.controlsRestartPaused")}
				</p>
			) : null}
			{confirming ? (
				<div
					className="mt-1.5 flex flex-wrap items-center gap-2 text-xs"
					role="status"
					data-testid="session-restart-confirm"
				>
					<span className="text-fg">{busy ? t("panel.controlsRestarting") : t("panel.controlsRestartConfirm")}</span>
					<Button
						size="sm"
						variant="danger"
						type="button"
						disabled={busy}
						data-testid="session-restart-yes"
						onClick={() => void restart()}
					>
						{t("panel.controlsRestartYes")}
					</Button>
					<Button
						size="sm"
						type="button"
						disabled={busy}
						data-testid="session-restart-cancel"
						onClick={() => setConfirming(false)}
					>
						{t("common.cancel")}
					</Button>
				</div>
			) : null}
		</section>
	);
}
