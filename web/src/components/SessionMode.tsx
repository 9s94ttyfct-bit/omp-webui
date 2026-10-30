import { BACKEND_NAMES, MODES, type Mode } from "@shared/offline.ts";
import type { ModeSwitchReply } from "@shared/protocol.ts";
import { useId, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { codedText, errorText } from "../lib/error-text.ts";
import { useMode } from "../lib/offline.ts";
import { socket } from "../lib/ws.ts";
import { attachLiveForFile, useApp } from "../store/app.ts";
import { INFO_BOX, InfoButton } from "./InfoButton.tsx";
import { Button, cx } from "./ui.tsx";

const LABEL: Record<Mode, MessageKey> = { full: "mode.full", light: "mode.light" };

/**
 * Full or Light for one conversation (`SessionControls`' "This session" panel): choosing the other mode ends its omp and
 * resumes the same session file in that mode (the server does it; the page follows to the process that runs the
 * conversation then). While the conversation works or waits for an answer the switch waits for the turn to end, and the
 * panel says so, with a way to take it back; a switch that could not be made says why. A paused conversation is not
 * switched (the server refuses it): resume it first. One line, with what the modes are under its info button, so the
 * panel fits without a scroll (#716).
 */
export default function SessionMode({ liveId }: { liveId: string }) {
	const t = useT();
	const group = useId();
	const infoId = useId();
	const [infoOpen, setInfoOpen] = useState(false);
	const toast = useApp((s) => s.toast);
	const info = useApp((s) => s.lives[liveId]?.info);
	const backend = useMode((s) => s.state?.offline.backend ?? null);
	const defaultModels = useMode((s) => s.state?.lightModels ?? "yours");
	const [busy, setBusy] = useState<Mode | null>(null);
	if (!info) return null;
	const paused = Boolean(info.pausedAt);
	const waiting = info.modeSwitch && !info.modeSwitch.failed ? info.modeSwitch : null;
	const failed = info.modeSwitch?.failed ? info.modeSwitch : null;

	/** Ask for `mode`: the one the conversation has takes back a switch that waits (and clears the note of one that failed). */
	const ask = async (mode: Mode) => {
		setBusy(mode);
		try {
			const answer = await socket.request<ModeSwitchReply>({ t: "set_mode", liveId, mode });
			// The conversation is on another process now: the page listens to it and shows it (the `live` frame says so as well).
			if (answer.state === "switched" && info.sessionFile) await attachLiveForFile(info.sessionFile, answer.liveId);
		} catch (e) {
			toast("error", t("mode.switchFailed", { error: errorText(e) }));
		} finally {
			setBusy(null);
		}
	};

	// What Light means for this conversation: its own process's models when it is in Light, else what Light would be now.
	const lightModels = info.mode === "light" ? (info.lightModels ?? "yours") : defaultModels;
	const hint = (m: Mode) =>
		m === "full"
			? t("mode.fullHint")
			: lightModels === "local"
				? t("mode.lightHintLocal", { backend: backend ? BACKEND_NAMES[backend] : t("mode.lightHintUnknown") })
				: t("mode.lightHintYours");
	return (
		<section
			className="mt-4 border-t border-border pt-3"
			data-testid="session-mode"
			data-mode={info.mode}
			data-pending={waiting?.to ?? ""}
			aria-label={t("panel.controlsModeTitle")}
		>
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-1">
					<div className="text-sm font-semibold">{t("panel.controlsModeTitle")}</div>
					<InfoButton
						label={t("panel.controlsModeTitle")}
						testid="session-mode"
						open={infoOpen}
						controls={infoId}
						onToggle={() => setInfoOpen((v) => !v)}
					/>
				</div>
				<fieldset className="flex gap-0.5" disabled={busy !== null || paused} data-testid="session-mode-choices">
					<legend className="sr-only">{t("panel.controlsModeTitle")}</legend>
					{MODES.map((m) => (
						<label
							key={m}
							className={cx(
								"flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
								info.mode === m ? "bg-accent-soft text-accent" : "text-muted hover:text-fg",
							)}
						>
							<input
								type="radio"
								className="accent-[var(--accent)]"
								name={`session-mode-${group}`}
								value={m}
								checked={info.mode === m}
								data-testid={`session-mode-${m}`}
								onChange={() => void ask(m)}
							/>
							{t(LABEL[m])}
						</label>
					))}
				</fieldset>
			</div>
			{infoOpen ? (
				<div id={infoId} className={cx(INFO_BOX, "mt-1.5")} data-testid="session-mode-help">
					<p>{t("panel.controlsModeIntro")}</p>
					<ul className="space-y-0.5">
						{MODES.map((m) => (
							<li key={m}>
								<span className="font-medium text-fg">{t(LABEL[m])}</span>: {hint(m)}
							</li>
						))}
					</ul>
					<p>{t("panel.controlsModeWaits")}</p>
				</div>
			) : null}
			{paused ? (
				<p className="mt-1.5 text-xs text-muted" data-testid="session-mode-paused">
					{t("panel.controlsModePaused")}
				</p>
			) : null}
			{busy !== null ? (
				<p className="mt-1.5 text-xs text-muted" role="status" data-testid="session-mode-switching">
					{t("panel.controlsModeSwitching", { mode: t(LABEL[busy]) })}
				</p>
			) : null}
			{waiting ? (
				<div
					className="mt-1.5 text-xs text-muted"
					role="status"
					data-testid="session-mode-pending"
					data-to={waiting.to}
				>
					<div>{t("panel.controlsModePending", { mode: t(LABEL[waiting.to]) })}</div>
					<Button
						size="sm"
						type="button"
						className="mt-1"
						disabled={busy !== null}
						data-testid="session-mode-cancel"
						onClick={() => void ask(info.mode)}
					>
						{t("panel.controlsModeCancel")}
					</Button>
				</div>
			) : null}
			{failed?.failed ? (
				<div className="mt-1.5 text-xs text-danger" role="alert" data-testid="session-mode-failed" data-to={failed.to}>
					<div className="break-words">
						{t("panel.controlsModeFailed", {
							mode: t(LABEL[failed.to]),
							error: codedText(failed.failed.code, failed.failed.params, failed.failed.message),
						})}
					</div>
					<Button
						size="sm"
						type="button"
						className="mt-1"
						disabled={busy !== null}
						data-testid="session-mode-dismiss"
						onClick={() => void ask(info.mode)}
					>
						{t("panel.controlsModeDismiss")}
					</Button>
				</div>
			) : null}
		</section>
	);
}
