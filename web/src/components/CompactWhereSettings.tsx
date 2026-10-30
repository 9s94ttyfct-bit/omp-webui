import { COMPACT_WHERES, type CompactWhere, compactWhereOf } from "@shared/compact-queue.ts";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { setCompactWherePref, useCompactWherePref } from "../lib/compact-where.ts";
import { CardHeader, Select, WithCode } from "./ui.tsx";

const LABELS: Record<CompactWhere, MessageKey> = {
	turn: "pages.settingsCompactWhereTurn",
	step: "pages.settingsCompactWhereStep",
};

/**
 * Settings › where a compact you queue while the agent works runs (#651): when the turn ends (the default), or between two of
 * its steps. The choice follows the person, as the other preferences do (`ompw.compactWhere`, `lib/prefs.ts`), and is where the
 * choice of each conversation (This session › Compact context) starts from; a conversation that cannot be held between steps
 * says so and waits for the end of the turn.
 */
export function CompactWhereSettings() {
	const t = useT();
	const where = useCompactWherePref();
	return (
		<section
			className="rounded-2xl border border-border bg-surface p-4"
			data-testid="compact-where-settings"
			data-index-title={t("pages.settingsCompactWhereIndex")}
		>
			<CardHeader
				title={t("pages.settingsCompactWhere")}
				hint={<WithCode text={t("pages.settingsCompactWhereHint")} />}
			/>
			<Select
				aria-label={t("pages.settingsCompactWhere")}
				data-testid="compact-where"
				value={where}
				onChange={(e) => setCompactWherePref(compactWhereOf(e.target.value) ?? "turn")}
			>
				{COMPACT_WHERES.map((w) => (
					<option key={w} value={w}>
						{t(LABELS[w])}
					</option>
				))}
			</Select>
		</section>
	);
}
