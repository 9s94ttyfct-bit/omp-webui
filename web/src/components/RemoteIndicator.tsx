import type { RemoteState } from "@shared/remote.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { useRemote } from "../lib/remote.ts";
import { showSettingsCard } from "../lib/shortcut-view.ts";
import { cx } from "./ui.tsx";

const LABELS: Record<RemoteState, MessageKey> = {
	off: "remote.indicatorOff",
	starting: "remote.indicatorStarting",
	connected: "remote.indicatorConnected",
	error: "remote.indicatorError",
};

const DOTS: Record<RemoteState, string> = {
	off: "bg-faint",
	starting: "animate-pulse bg-warning",
	connected: "bg-success",
	error: "bg-danger",
};

/**
 * The sidebar footer's line for remote access, under the versions: whether the tunnel is off, starting, connected or
 * failing. A click opens Settings, where it is set up. It is not there before the server has answered, nor on a page
 * that came in through the tunnel (which is refused the answer, and is plainly remote).
 */
export function RemoteIndicator() {
	const t = useT();
	const state = useRemote((s) => s.snapshot?.status.state);
	if (!state) return null;
	const label = t(LABELS[state]);
	return (
		<button
			type="button"
			data-testid="remote-indicator"
			data-state={state}
			title={t("remote.indicatorTitle", { state: label })}
			className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-xs text-muted hover:bg-hover hover:text-fg"
			onClick={() => showSettingsCard('[data-testid="remote-settings"]')}
		>
			<span aria-hidden className={cx("h-2 w-2 shrink-0 rounded-full", DOTS[state])} />
			{label}
		</button>
	);
}
