import { working } from "@shared/attention.ts";
import type { IsolationInfo } from "@shared/isolated-env.ts";
import { lazy, Suspense, useEffect, useId, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { api, ownerPage } from "../lib/api.ts";
import { useConfirmFocus } from "../lib/confirm-focus.ts";
import { errorText } from "../lib/error-text.ts";
import { forceRestart } from "../lib/force-restart.ts";
import { socket } from "../lib/ws.ts";
import { useApp } from "../store/app.ts";
import { INFO_BOX, InfoButton } from "./InfoButton.tsx";
import { Button, cx } from "./ui.tsx";

const IsolationToggle = lazy(() => import("./IsolationToggle.tsx"));

/**
 * The isolated environment of the folder a running conversation works in (`SessionControls`' "This session" panel, under
 * Advanced), the same switch as New chat's (`shared/isolated-env.ts`). It is the folder's: a flip changes it for every
 * conversation there (`set_isolation`). A process keeps the variables it started with, so the change applies when the
 * conversation restarts: while it is idle the panel offers to restart it now; while it works it is left to finish, and the
 * header's "Restart to apply" restarts it when the person chooses (`IsolatedBadge`). Not shown where this computer offers no
 * isolation. One line, a row of the fold, with what it is under its info button, so the panel fits without a scroll (#716).
 */
export default function SessionIsolation({ liveId, className }: { liveId: string; className?: string }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const notOwner = useApp((s) => !ownerPage(s.meta));
	const live = useApp((s) => s.lives[liveId]);
	const info = live?.info;
	const cwd = info?.cwd;
	const [state, setState] = useState<IsolationInfo | null>(null);
	const [asked, setAsked] = useState(0);
	const [busy, setBusy] = useState(false);
	// Restart now asks once, as the panel's own Restart: it ends what the conversation started (background jobs, dev servers).
	const [confirming, setConfirming] = useState(false);
	const opener = useConfirmFocus<HTMLButtonElement>(confirming);
	const infoId = useId();
	const [infoOpen, setInfoOpen] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `asked` moves after a flip: the folder is read again.
	useEffect(() => {
		if (!cwd) return;
		let current = true;
		api.isolation(cwd).then(
			(answer) => current && setState(answer),
			() => {},
		);
		return () => {
			current = false;
		};
	}, [cwd, asked]);
	if (!live || !info || !state?.supported) return null;
	const on = state.root !== null;
	const paused = Boolean(info.pausedAt);
	const idle = !working(live) && live.uiRequests.length === 0;

	const flip = async (next: boolean) => {
		setBusy(true);
		try {
			await socket.request({ t: "set_isolation", liveId, on: next });
		} catch (e) {
			toast("error", t("panel.controlsIsolationFailed", { error: errorText(e) }));
		} finally {
			setAsked((n) => n + 1);
			setBusy(false);
		}
	};
	const restart = async () => {
		setBusy(true);
		try {
			await forceRestart(liveId);
		} catch (e) {
			toast("error", t("panel.controlsRestartFailed", { error: errorText(e) }));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className={className} data-testid="session-isolation" aria-label={t("panel.controlsIsolationTitle")}>
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-1">
					<div className="text-sm">{t("panel.controlsIsolationTitle")}</div>
					<InfoButton
						label={t("panel.controlsIsolationTitle")}
						testid="session-isolation"
						open={infoOpen}
						controls={infoId}
						onToggle={() => setInfoOpen((v) => !v)}
					/>
				</div>
				<Suspense fallback={null}>
					<IsolationToggle
						on={on}
						folder={state.root ?? info.cwd}
						refused={state.refused}
						notOwner={notOwner}
						onToggle={(next) => {
							if (!busy) void flip(next);
						}}
					/>
				</Suspense>
			</div>
			{infoOpen ? (
				<p id={infoId} className={cx(INFO_BOX, "mt-1.5")} data-testid="session-isolation-help">
					{t("panel.controlsIsolationHint")}
				</p>
			) : null}
			{info.isolationStale ? (
				<div
					className="mt-1.5 flex flex-wrap items-center gap-2 text-xs"
					role="status"
					data-testid="session-isolation-apply"
				>
					{paused ? (
						<span className="text-fg">{t("panel.controlsIsolationPaused")}</span>
					) : idle ? (
						<>
							<span className="text-fg">
								{confirming
									? busy
										? t("panel.controlsRestarting")
										: t("panel.controlsRestartConfirm")
									: t("panel.controlsIsolationApply")}
							</span>
							{confirming ? (
								<>
									<Button
										size="sm"
										variant="danger"
										type="button"
										disabled={busy}
										data-testid="session-isolation-restart-yes"
										onClick={() => void restart().finally(() => setConfirming(false))}
									>
										{t("panel.controlsRestartYes")}
									</Button>
									<Button
										size="sm"
										type="button"
										// The question takes the keyboard on its safe answer, so it is read.
										autoFocus
										disabled={busy}
										onClick={() => setConfirming(false)}
									>
										{t("common.cancel")}
									</Button>
								</>
							) : (
								<Button
									ref={opener}
									size="sm"
									type="button"
									disabled={busy || !info.sessionFile}
									data-testid="session-isolation-restart"
									onClick={() => setConfirming(true)}
								>
									{t("panel.controlsIsolationRestartNow")}
								</Button>
							)}
						</>
					) : (
						<span className="text-fg">{t("panel.controlsIsolationWorking")}</span>
					)}
				</div>
			) : null}
		</section>
	);
}
