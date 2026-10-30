import { ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import { controls } from "../lib/api.ts";
import { guardApi } from "../lib/guard-api.ts";
import { useGuardStrings } from "../lib/guard-strings.ts";
import { isWorking } from "../lib/loaded-switches.ts";
import { showSettingsCard } from "../lib/shortcut-view.ts";
import { useApp } from "../store/app.ts";
import { useGuard } from "../store/guard.ts";
import { Button } from "./ui.tsx";

/** The processes whose notice was dismissed: it stays away for as long as the page lives, not only while the view is mounted. */
const dismissed = new Set<string>();

/**
 * The strip over a conversation whose omp runs without the gate of "Guard dangerous commands", so its risky calls are not
 * looked at (`LiveInfo.ungated`). Said only while the guard is on (Ask me or Reviewer model). A process the server took over
 * (`inherited`: started before the guard, or by another server) is given the gate by opening it again: the idle process is
 * ended with the restart the loaded-extensions dialog uses (`controls.endIfIdle`, which the server refuses with a 409 while the
 * conversation works, asks or is paused) and the conversation's file resumed in a process the server starts with the gate
 * (`onReopen`, the same as the one of an ended conversation). Only while the conversation is idle is the button enabled: a
 * paused turn, a running one or a wait for a usage limit is never cut off by it. One the server started without the gate
 * (`chosen`) cannot be given it: its turns are refused, and the guard is turned off in Settings.
 */
export default function GuardUngated({
	liveId,
	kind,
	onReopen,
}: {
	liveId: string;
	kind: "inherited" | "chosen";
	/** Start the conversation's file in a new process (null when it has no file). Says its own failure. */
	onReopen: (() => Promise<void>) | null;
}) {
	const t = useT();
	const ready = useGuardStrings();
	const config = useGuard((s) => s.config);
	const toast = useApp((s) => s.toast);
	const live = useApp((s) => s.lives[liveId]);
	const bashRunning = useApp((s) => (s.bash[liveId]?.length ?? 0) > 0);
	const [busy, setBusy] = useState(false);
	const [, redraw] = useState(0);
	const key = `${liveId}:${kind}`;
	// What the guard does for this conversation: its own settings, else the global ones.
	const mode = live?.info.guard?.config.mode ?? config?.mode;

	// The mode the guard is in is the server's: asked once, unless the page already has it (a page that came through the tunnel is refused).
	useEffect(() => {
		if (!config) void guardApi.config().catch(() => {});
	}, [config]);

	if (!ready || mode === undefined || mode === "off" || dismissed.has(key)) return null;
	// What the page can tell of the process; the server decides in the end (it refuses the restart while it is busy).
	const working = !live || isWorking(live, bashRunning) || live.continuing;
	const reopen = async () => {
		if (!onReopen || working) return;
		setBusy(true);
		try {
			// The process is ended only if it is idle (a 409 otherwise, nothing cut off): opening a file that a live process
			// holds would hand back that very process.
			await controls.endIfIdle(liveId);
			await onReopen();
		} catch (e) {
			toast("error", t("guard.ungatedFailed", { error: e instanceof Error ? e.message : String(e) }));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div
			className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-warning/15 px-4 py-2 text-sm"
			role="alert"
			data-testid="guard-ungated-notice"
			data-kind={kind}
		>
			<ShieldAlert size={16} className="shrink-0 text-warning" aria-hidden />
			<p className="min-w-0 flex-1 basis-64">
				{t(kind === "inherited" ? "guard.ungatedInherited" : "guard.ungatedChosen")}
			</p>
			<div className="flex shrink-0 flex-wrap items-center gap-2">
				{kind === "inherited" && onReopen ? (
					<>
						{working ? (
							<span
								id={`guard-ungated-why-${liveId}`}
								className="text-xs text-muted"
								data-testid="guard-ungated-reopen-why"
							>
								{t("guard.ungatedReopenBusy")}
							</span>
						) : null}
						<Button
							size="sm"
							data-testid="guard-ungated-reopen"
							disabled={busy || working}
							aria-describedby={working ? `guard-ungated-why-${liveId}` : undefined}
							onClick={() => void reopen()}
						>
							{t(busy ? "guard.ungatedReopening" : "guard.ungatedReopen")}
						</Button>
					</>
				) : null}
				{kind === "chosen" ? (
					<Button
						size="sm"
						variant="ghost"
						data-testid="guard-ungated-settings"
						onClick={() => showSettingsCard('[data-testid="guard-settings"]')}
					>
						{t("guard.noticeSettings")}
					</Button>
				) : null}
				<button
					type="button"
					className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-hover"
					aria-label={t("guard.noticeDismiss")}
					data-testid="guard-ungated-dismiss"
					onClick={() => {
						dismissed.add(key);
						redraw((n) => n + 1);
					}}
				>
					<X size={14} aria-hidden />
				</button>
			</div>
		</div>
	);
}
