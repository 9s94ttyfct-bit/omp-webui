import {
	COMPACT_PERCENT_MAX,
	COMPACT_PERCENT_MIN,
	type CompactAt,
	type CompactSettings,
	compactAtOf,
	compactTrigger,
	pointOf,
	shareOfTokens,
} from "@shared/compact-at.ts";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { en as helpEn } from "../i18n/controls-help.ts";
import "../i18n/later.ts";
import { type MessageKey, registerStrings, type Translate, useT } from "../i18n/index.ts";
import { fmtTokens } from "../lib/format.ts";
import { parseTokenAmount } from "../lib/token-amount.ts";
import { useCompactAt } from "../store/compact-at.ts";
import { Select } from "./Select.tsx";
import { Button, cx } from "./ui.tsx";

registerStrings("controlsHelp", helpEn);

/**
 * A point in the page's words: omp's default as the effective value for a window of `window` tokens, a share, or a
 * count. The panel and Settings say it the same way, so "Default" means one thing in both.
 */
export function compactAtText(
	t: Translate,
	at: CompactAt | null,
	window: number | undefined,
	settings: CompactSettings | null,
): string {
	if (at === null) {
		const trigger = compactTrigger(null, settings ?? { percent: -1, tokens: -1 }, window);
		if (!trigger) return t("panel.controlsCompactAtDefaultNoWindow");
		return t("panel.controlsCompactAtDefaultValue", {
			percent: String(trigger.percent),
			tokens: fmtTokens(trigger.tokens),
			window: fmtTokens(trigger.window),
		});
	}
	if ("percent" in at) return t("panel.controlsCompactAtPercentValue", { percent: String(at.percent) });
	return t("panel.controlsCompactAtTokensValue", { tokens: fmtTokens(at.tokens) });
}

/** The shares the row offers, as omp's own list does: a step of 5 from `COMPACT_PERCENT_MIN` to `COMPACT_PERCENT_MAX`. */
const PERCENTS: readonly number[] = Array.from(
	{ length: Math.floor((COMPACT_PERCENT_MAX - COMPACT_PERCENT_MIN) / 5) + 1 },
	(_, i) => COMPACT_PERCENT_MIN + i * 5,
);

/** `percent` as one of the offered shares, or the nearest one: a value saved elsewhere still shows a chosen option. */
function offered(percent: number): number {
	return PERCENTS.reduce((best, p) => (Math.abs(p - percent) < Math.abs(best - percent) ? p : best), PERCENTS[0]);
}

/** The row's modes: omp's default, a share of the window, or a count of tokens. */
type Mode = "default" | "percent" | "tokens";

const modeOf = (at: CompactAt | null): Mode => (at === null ? "default" : "percent" in at ? "percent" : "tokens");

/**
 * "Compact at": how much of the model's context window a conversation may use before omp compacts by itself. omp has the
 * point as two settings (`compaction.thresholdPercent`, `compaction.thresholdTokens`); a conversation's own is held by its
 * overlay, which omp reloads by itself and reads at every check, so a change applies from the next turn.
 *
 * The effective value is for the model's window as omp reports it (`contextUsage.contextWindow`, else the model's own
 * `contextWindow`): "Default" is omp's reserve-based fallback, which for 200k is about 85% (170k).
 *
 * `file` null is Settings, where the row is omp's own configuration: what it shows is `settings` (else the store's), what
 * a new conversation starts with, and a choice made there is `omp config `. A conversation with a point of its own is
 * over that configuration; "Default" makes it follow the configuration again.
 */
export function CompactAtRow({
	file,
	window,
	settings,
	modelThreshold,
	disabled,
	onChange,
	help,
	testid = "compact-at",
}: {
	/** The conversation the point is for (a session file); null: omp's own, which is what Settings shows. */
	file: string | null;
	/** The model's context window in tokens, as omp reports it; undefined when it says none. */
	window: number | undefined;
	/** omp's configuration's own settings, where they were read (a conversation's own come from the store). */
	settings: CompactSettings | null;
	/** The per-model threshold that decides over the settings for this conversation's model, if one does. */
	modelThreshold?: string | null;
	disabled?: boolean;
	/** The chosen point; null: omp's configuration again (in Settings, omp's default). */
	onChange: (at: CompactAt | null) => void;
	/** The panel's "About" button and the explanation it opens, where the owner shows them with its other rows'. */
	help?: { button: ReactNode; text: ReactNode };
	testid?: string;
}) {
	const t = useT();
	const { loaded, omp, session } = useCompactAt(file);
	// omp's configuration: what Settings edits, and what a conversation follows while it has no point of its own.
	const base = settings ?? omp;
	// Where the point is: Settings shows omp's own configuration's, a conversation its own (null: it follows omp's).
	const own = omp ? pointOf(omp) : null;
	const at = file === null ? own : session;
	const id = useId();
	const [mode, setMode] = useState<Mode>(() => modeOf(at));
	const [draft, setDraft] = useState(() => (at && "tokens" in at ? String(at.tokens) : ""));
	// What the server last said the point is: a value that changed elsewhere (another page, the terminal) shows here too.
	const seen = useRef(at);
	useEffect(() => {
		if (JSON.stringify(seen.current) === JSON.stringify(at)) return;
		seen.current = at;
		setMode(modeOf(at));
		if (at && "tokens" in at) setDraft(String(at.tokens));
	}, [at]);

	// The share a first choice starts from: the point omp's configuration names, where it is one, else 85% of the window.
	const start = base && base.percent > 0 ? offered(base.percent) : 85;
	const percent = at && "percent" in at ? offered(at.percent) : start;
	const effective = compactAtText(t, at, window, base);
	// What is in force, and where it comes from: a conversation's own point (or omp's configuration it follows), omp's
	// configuration itself in Settings, or omp's own reserve. Settings shows what new conversations start with, so its
	// line says so; a conversation's says where it compacts.
	const configured = pointOf(base ?? { percent: -1, tokens: -1 }) !== null;
	const effectiveLine =
		file === null
			? configured
				? t("panel.controlsCompactAtEffectiveConfig", { value: effective })
				: t("panel.controlsCompactAtEffectiveDefault", { value: effective })
			: at === null && !configured
				? t("panel.controlsCompactAtEffectiveDefault", { value: effective })
				: t("panel.controlsCompactAtEffective", { value: effective });
	const parsed = parseTokenAmount(draft);
	const typed = mode === "tokens" && draft.trim() !== "" && typeof parsed === "number";
	const bad = mode === "tokens" && draft.trim() !== "" && parsed === null;
	const over = typed && window !== undefined && (parsed as number) > window;

	const choose = (next: Mode) => {
		setMode(next);
		if (next === "default") onChange(null);
		else if (next === "percent") onChange({ percent });
	};

	return (
		<fieldset className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5" data-testid={testid}>
			<legend className="float-left text-sm">{t("panel.controlsCompactAt")}</legend>
			<div className="flex items-center gap-1">
				<Select
					data-testid={`${testid}-mode`}
					aria-label={t("panel.controlsCompactAt")}
					value={mode}
					disabled={disabled || !loaded}
					onValueChange={(v) => choose(v as Mode)}
				>
					<option value="default">{t("panel.controlsCompactAtDefault")}</option>
					<option value="percent">{t("panel.controlsCompactAtPercent")}</option>
					<option value="tokens">{t("panel.controlsCompactAtTokens")}</option>
				</Select>
				{mode === "percent" ? (
					<Select
						data-testid={`${testid}-percent`}
						aria-label={t("panel.controlsCompactAtPercent")}
						value={String(percent)}
						disabled={disabled || !loaded}
						onValueChange={(v) => onChange(compactAtOf({ percent: Number(v) }))}
					>
						{PERCENTS.map((p) => (
							<option key={p} value={String(p)}>
								{p}%
							</option>
						))}
					</Select>
				) : null}
				{help?.button}
			</div>
			{mode === "tokens" ? (
				<div className="flex w-full items-center gap-1">
					<input
						id={`${id}-tokens`}
						data-testid={`${testid}-tokens`}
						autoComplete="off"
						spellCheck={false}
						className="w-24 rounded-lg border border-border bg-bg-soft px-2 py-0.5 text-xs tabular-nums outline-none focus:border-faint"
						placeholder={window === undefined ? "120k" : fmtTokens(Math.round(window * 0.85))}
						aria-label={t("panel.controlsCompactAtTokens")}
						aria-invalid={bad || over}
						value={draft}
						disabled={disabled || !loaded}
						onChange={(e) => setDraft(e.target.value)}
					/>
					<Button
						size="sm"
						data-testid={`${testid}-apply`}
						disabled={disabled || !loaded || !typed || over}
						onClick={() => {
							if (typeof parsed === "number") onChange(compactAtOf({ tokens: parsed }));
						}}
					>
						{t("panel.controlsCompactAtApply")}
					</Button>
					{typed && window !== undefined ? (
						<span className="text-xs text-muted" data-testid={`${testid}-share`}>
							{t("panel.controlsCompactAtShare", { percent: String(shareOfTokens(parsed as number, window)) })}
						</span>
					) : null}
				</div>
			) : null}
			<p
				className={cx("w-full text-xs", bad || over ? "text-danger" : "text-muted")}
				data-testid={`${testid}-effective`}
			>
				{bad
					? t("panel.controlsCompactAtBadTokens")
					: over
						? t("panel.controlsCompactAtOverWindow", { window: fmtTokens(window ?? 0) })
						: effectiveLine}
			</p>
			{modelThreshold && file !== null ? (
				<p className="w-full text-xs text-warning" data-testid={`${testid}-model-threshold`}>
					{t("panel.controlsCompactAtModelThreshold", { key: modelThreshold })}
				</p>
			) : null}
			{!loaded ? (
				<p className="w-full text-xs text-muted" data-testid={`${testid}-loading`}>
					{t("panel.controlsCompactAtLoading")}
				</p>
			) : null}
			{loaded && base === null ? (
				<p className="w-full text-xs text-warning" data-testid={`${testid}-unknown`}>
					{t("panel.controlsCompactAtUnknown")}
				</p>
			) : null}
			{help?.text}
		</fieldset>
	);
}

/** What the row's "About" disclosure says; the panel shows it with the other rows' explanations. */
export const COMPACT_AT_HELP: { what: MessageKey; cost: MessageKey; advice: MessageKey } = {
	what: "controlsHelp.compactAtWhat",
	cost: "controlsHelp.compactAtCost",
	advice: "controlsHelp.compactAtAdvice",
};
