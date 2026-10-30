import type { ExitReason } from "@shared/exit.ts";
import { CircleAlert, RotateCcw } from "lucide-react";
import { useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import type { LiveState } from "../store/live.ts";
import { Button } from "./ui.tsx";

/** What each of the server's reasons to end an omp is called in the page's own words. */
const REASON_KEY: Record<ExitReason, MessageKey> = {
	idle: "chat.endedByServerIdle",
	closed: "chat.endedByServerClosed",
	restarted: "chat.endedByServerRestarted",
	modeSwitch: "chat.endedByServerModeSwitch",
	handover: "chat.endedByServerHandover",
	server: "chat.endedByServerServer",
	stopped: "chat.endedByServerStopped",
	softStop: "chat.endedByServerSoftStop",
};

/**
 * What a conversation says when its omp process is gone, and what can be done about it.
 *
 * The end of an omp is told apart by who asked for it: one that ended on its own is a fault to look into (its exit
 * code, the signal that killed it and its last words are shown), while one the *server* closed — the idle reaper, a
 * Close, a restart, the terminal hand-off, the server going away — is the server's doing and is said so, so that a
 * conversation that is simply not running any more is not read as a crash (#472).
 *
 * Either way the conversation can be opened again: **Reopen** starts omp anew on the same session file, which is
 * what sending a message would do anyway, but said outright — a reader whose process is gone should not have to
 * guess that a message brings it back.
 */
export function ExitNotice({
	live,
	onReopen,
}: {
	live: LiveState;
	/** Start the conversation's omp again; null while nothing can be reopened (no session file). */
	onReopen: (() => Promise<void>) | null;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const exited = live.exited;
	if (!exited) return null;

	const by = exited.by;
	const reason = exited.reason;
	const reasonText = reason ? t(REASON_KEY[reason]) : "";
	// The server does not remember how the process ended: the page says it is no longer running, without saying who
	// ended it — a crash of omp's must not be blamed on the server (#515).
	const headline =
		by === "server"
			? t("chat.endedByServer", { reason: reasonText })
			: by === "omp"
				? t("chat.endedByOmp")
				: t("chat.endedUnknown");
	// What ended an omp that ended on its own: the signal that killed it, else its exit code, else nothing.
	const how = exited.signal
		? t("chat.exitedSignal", { signal: exited.signal })
		: exited.code !== null
			? t("chat.exitedCode", { code: exited.code })
			: null;
	const stderr = exited.stderr.trim();

	return (
		<div
			className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm"
			data-testid="exit-notice"
			data-ended-by={by}
		>
			<div className="flex items-start gap-2">
				<CircleAlert size={16} className="mt-0.5 shrink-0 text-warning" />
				<div className="min-w-0 flex-1">
					<p className="font-medium">{headline}</p>
					{how && by === "omp" ? <p className="mt-1 text-muted">{how}</p> : null}
					{by === "server" && reason === "stopped" ? (
						<p className="mt-1 text-muted" data-testid="exit-kept">
							{t("chat.endedStoppedKept")}
						</p>
					) : null}
					{by === "server" && reason === "softStop" ? (
						<p className="mt-1 text-muted" data-testid="exit-soft-stop">
							{t("chat.endedSoftStopKept")}
						</p>
					) : null}
					{stderr ? (
						<pre className="mt-2 max-h-40 overflow-auto font-mono text-xs text-muted">{stderr.slice(-2000)}</pre>
					) : null}
					{onReopen ? (
						<div className="mt-2">
							<Button
								size="sm"
								data-testid="exit-reopen"
								disabled={busy}
								onClick={() => {
									setBusy(true);
									// The failure is told by the toast that `onReopen` shows; the rejection must not also
									// reach the page as an unhandled one (#516).
									void onReopen()
										.catch(() => {})
										.finally(() => setBusy(false));
								}}
							>
								<RotateCcw size={13} />
								{busy ? t("chat.endedReopening") : t("chat.endedReopen")}
							</Button>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
