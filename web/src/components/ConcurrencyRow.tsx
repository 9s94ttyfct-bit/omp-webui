import { CONCURRENCY_CHOICES, OMP_DEFAULT_CONCURRENCY } from "@shared/subagent-concurrency.ts";
import type { ReactNode } from "react";
import "../i18n/later.ts";
import { type MessageKey, type Translate, useT } from "../i18n/index.ts";
import { useConcurrency } from "../store/subagent-concurrency.ts";
import { Select } from "./Select.tsx";

/** What a limit means, as a toast or the row's line says it: "4 at once", "one at a time", "no limit". */
export function concurrencyText(t: Translate, limit: number): string {
	if (limit === 0) return t("panel.controlsConcurrencyNoLimit");
	if (limit === 1) return t("panel.controlsConcurrencyOne");
	return t("panel.controlsConcurrencyCount", { n: String(limit) });
}

/**
 * "Parallel subagents": how many subagents a conversation runs at once (omp's `task.maxConcurrency`, see
 * `shared/subagent-concurrency.ts`); omp queues the rest and starts them as running ones end. A conversation's own limit is
 * held by its overlay, which omp reloads by itself, so a change applies to the next subagent that starts.
 *
 * `file` null is Settings, where the row is omp's own configuration (`omp config set`): what a new conversation starts with.
 * A conversation's "Default" follows its configuration (`configured`, read for its folder; omp's global value where that
 * could not be read), and a count over it is its own.
 */
export function ConcurrencyRow({
	file,
	configured,
	disabled,
	onChange,
	help,
	testid = "subagent-concurrency",
}: {
	/** The conversation the limit is for (a session file); null: omp's own, which is what Settings shows. */
	file: string | null;
	/** The conversation's configuration's value (what its "Default" is), where it was read. */
	configured?: number | null;
	disabled?: boolean;
	/** The chosen limit (`0`: no limit); null: omp's configuration again (in Settings, omp's default). */
	onChange: (limit: number | null) => void;
	/** The panel's "About" button and the explanation it opens, where the owner shows them with its other rows'. */
	help?: { button: ReactNode; text: ReactNode };
	testid?: string;
}) {
	const t = useT();
	const { loaded, omp, session } = useConcurrency(file);
	// What "Default" is: omp's own default in Settings; for a conversation, its configuration's value.
	const base = file === null ? OMP_DEFAULT_CONCURRENCY : (configured ?? omp);
	// What is chosen: in Settings omp's own value (its default reads as Default); a conversation's own limit, if it has one.
	const own = file === null ? (omp === OMP_DEFAULT_CONCURRENCY ? null : omp) : session;
	const value = own === null ? "default" : String(own);
	// A value omp's configuration has that the row does not offer (64, set in the terminal) is shown as it is.
	const extra = own !== null && !CONCURRENCY_CHOICES.includes(own) ? own : null;
	const effective = own ?? base;
	const line: { key: MessageKey; value: string } | null =
		effective === null
			? null
			: file === null
				? {
						key:
							own === null ? "panel.controlsConcurrencyEffectiveDefault" : "panel.controlsConcurrencyEffectiveConfig",
						value: concurrencyText(t, effective),
					}
				: { key: "panel.controlsConcurrencyEffective", value: concurrencyText(t, effective) };
	return (
		<fieldset className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5" data-testid={testid}>
			<legend className="float-left text-sm">{t("panel.controlsConcurrency")}</legend>
			<div className="flex items-center gap-1">
				<Select
					data-testid={`${testid}-choice`}
					aria-label={t("panel.controlsConcurrency")}
					value={value}
					disabled={disabled || !loaded || (file === null && omp === null)}
					onValueChange={(v) => onChange(v === "default" ? null : Number(v))}
				>
					<option value="default">
						{base === null
							? t("panel.controlsConcurrencyDefaultUnknown")
							: t("panel.controlsConcurrencyDefault", {
									n: base === 0 ? t("panel.controlsConcurrencyUnlimitedWord") : String(base),
								})}
					</option>
					{CONCURRENCY_CHOICES.map((n) => (
						<option key={n} value={String(n)}>
							{n === 0 ? t("panel.controlsConcurrencyUnlimited") : String(n)}
						</option>
					))}
					{extra !== null ? <option value={String(extra)}>{String(extra)}</option> : null}
				</Select>
				{help?.button}
			</div>
			{line ? (
				<p className="w-full text-xs text-muted" data-testid={`${testid}-effective`}>
					{t(line.key, { value: line.value })}
				</p>
			) : null}
			{!loaded ? (
				<p className="w-full text-xs text-muted" data-testid={`${testid}-loading`}>
					{t("panel.controlsConcurrencyLoading")}
				</p>
			) : null}
			{loaded && base === null ? (
				<p className="w-full text-xs text-warning" data-testid={`${testid}-unknown`}>
					{t("panel.controlsConcurrencyUnknown")}
				</p>
			) : null}
			{help?.text}
		</fieldset>
	);
}

/** What the row's "About" disclosure says; the panel shows it with the other rows' explanations. */
export const CONCURRENCY_HELP: { what: MessageKey; cost: MessageKey; advice: MessageKey } = {
	what: "controlsHelp.concurrencyWhat",
	cost: "controlsHelp.concurrencyCost",
	advice: "controlsHelp.concurrencyAdvice",
};
