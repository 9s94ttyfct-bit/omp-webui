import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { useApp } from "../store/app.ts";
import { setConcurrencyDefault } from "../store/subagent-concurrency.ts";
import { ConcurrencyRow, concurrencyText } from "./ConcurrencyRow.tsx";
import { CardHeader } from "./ui.tsx";

/**
 * How many subagents a conversation runs at once, as omp's own configuration has it: `task.maxConcurrency`, the setting
 * `omp config` shows in the terminal, so the page and the terminal always agree. A conversation can set its own from its
 * session settings; this is what one that sets nothing follows.
 */
export function SubagentConcurrencySettings() {
	const t = useT();
	const toast = useApp((s) => s.toast);
	return (
		<section
			className="rounded-2xl border border-border bg-surface p-4"
			data-testid="subagent-concurrency-settings"
			data-index-title={t("pages.settingsConcurrency")}
		>
			<CardHeader title={t("pages.settingsConcurrency")} hint={t("pages.settingsConcurrencyHint")} />
			<ConcurrencyRow
				file={null}
				onChange={(limit) => {
					void setConcurrencyDefault(limit)
						.then(() =>
							toast(
								"success",
								limit === null
									? t("panel.controlsConcurrencySavedDefault")
									: t("panel.controlsConcurrencySaved", { value: concurrencyText(t, limit) }),
							),
						)
						.catch((e: Error) => toast("error", t("panel.controlsConcurrencyFailed", { error: e.message })));
				}}
			/>
		</section>
	);
}
