import { useT } from "../i18n/index.ts";
import { showSettingsCard } from "../lib/shortcut-view.ts";
import { useAppUpdate } from "../store/app-update.ts";

/**
 * The sidebar footer's line for a newer release of omp-webui: an accent dot and the version. It is there only while the
 * server has said a newer release exists (the socket tells it; this never asks, so the first page makes no request for
 * it). A click opens Settings at the Updates card.
 */
export function UpdateIndicator() {
	const t = useT();
	const version = useAppUpdate((s) => (s.state?.newer ? (s.state.latest?.version ?? null) : null));
	if (!version) return null;
	return (
		<button
			type="button"
			data-testid="update-indicator"
			title={t("shell.updateIndicatorTitle")}
			className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-xs text-muted hover:bg-hover hover:text-fg"
			onClick={() => showSettingsCard('[data-testid="update-settings"]')}
		>
			<span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-accent" />
			{t("shell.updateIndicator", { version })}
		</button>
	);
}
