import { ChevronRight } from "lucide-react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { useApp } from "../store/app.ts";
import { setUsageWaitDefault, useUsageWait } from "../store/usage-wait.ts";
import { WithCode } from "./ui.tsx";

/**
 * Whether a failed turn waits out its provider's usage limit instead of failing: omp's own `retry.waitForUsageReset`,
 * shown and changed here as `omp config` does in the terminal, so the two always agree. Each conversation can override
 * it from its quota pill.
 */
export function UsageWaitSetting() {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const { loaded, omp } = useUsageWait(null);
	return (
		<div className="mt-3">
			<label className="flex cursor-pointer items-start gap-3 text-sm">
				<input
					type="checkbox"
					className="mt-1 accent-[var(--accent)]"
					data-testid="usage-wait-default"
					checked={omp ?? false}
					disabled={!loaded || omp === null}
					onChange={(e) =>
						void setUsageWaitDefault(e.target.checked).catch((err) =>
							toast("error", t("chat.usageWaitFailed", { error: (err as Error).message })),
						)
					}
				/>
				<span>
					{t("pages.settingsUsageWait")}
					<span className="block text-xs text-muted" data-testid="usage-wait-hint">
						<WithCode text={t("pages.settingsUsageWaitHint")} />
					</span>
				</span>
			</label>
			{/* Under the checkbox's text (its box and the gap are 28px), not inside the label: a press on it must not toggle the box. */}
			<details className="group ml-7 mt-1" data-testid="usage-wait-how">
				<summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
					<ChevronRight size={14} className="shrink-0 text-faint transition-transform group-open:rotate-90" />
					{t("pages.settingsUsageWaitMore")}
				</summary>
				<p className="mt-1 max-w-prose text-xs text-muted" data-testid="usage-wait-details">
					<WithCode text={t("pages.settingsUsageWaitDetails")} />
				</p>
			</details>
			{loaded && omp === null ? (
				<p className="mt-1 text-xs text-warning" data-testid="usage-wait-unknown">
					{t("pages.settingsUsageWaitUnknown")}
				</p>
			) : null}
		</div>
	);
}
