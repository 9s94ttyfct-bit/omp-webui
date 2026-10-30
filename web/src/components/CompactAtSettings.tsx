import { parseSelector } from "@shared/model-config.ts";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { useModelCatalog, useModelConfig } from "../lib/model-config.ts";
import { useApp } from "../store/app.ts";
import { setCompactAtDefault } from "../store/compact-at.ts";
import { CompactAtRow, compactAtText } from "./CompactAtRow.tsx";
import { CardHeader } from "./ui.tsx";

/**
 * Where omp compacts by itself, as omp's own configuration has it: `compaction.thresholdPercent` (a share of the model's
 * window) or `compaction.thresholdTokens` (a count, which omp takes over the share) — the same two settings `omp config`
 * shows in the terminal, so the page and the terminal always agree. A conversation can set its own point from its session
 * settings; this is what one that sets nothing follows.
 *
 * The window is the one the model omp starts new conversations on has (`modelRoles.default` in its catalog): the point is
 * only a number with the window it is a share of, and "Default" is omp's reserve, which is a share of that window.
 */
export function CompactAtSettings() {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const { config } = useModelConfig("");
	const models = useModelCatalog(true, "omp");
	// What omp starts new conversations on, as its roles name it (`provider/id`, possibly with a thinking level).
	const selector = config?.roles.default ? parseSelector(config.roles.default) : null;
	const model = selector ? models?.find((m) => m.provider === selector.provider && m.id === selector.id) : undefined;
	return (
		<section
			className="rounded-2xl border border-border bg-surface p-4"
			data-testid="compact-at-settings"
			data-index-title={t("pages.settingsCompactAtIndex")}
		>
			<CardHeader title={t("pages.settingsCompactAt")} hint={t("pages.settingsCompactAtHint")} />
			<CompactAtRow
				file={null}
				window={model?.contextWindow}
				settings={null}
				onChange={(at) => {
					void setCompactAtDefault(at)
						.then(() =>
							toast(
								"success",
								at === null
									? t("panel.controlsCompactAtSavedDefault")
									: t("panel.controlsCompactAtSaved", {
											value: compactAtText(t, at, model?.contextWindow, null),
										}),
							),
						)
						.catch((e: Error) => toast("error", t("panel.controlsCompactAtFailed", { error: e.message })));
				}}
			/>
		</section>
	);
}
