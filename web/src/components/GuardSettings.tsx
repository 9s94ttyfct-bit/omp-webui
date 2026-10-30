import { GUARD_MODES, type GuardConfig } from "@shared/guard.ts";
import { type PolicyStatus, policyStatus } from "@shared/guard-policy.ts";
import { Check, CircleAlert, ScanEye } from "lucide-react";
import { useEffect, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import { guardApi } from "../lib/guard-api.ts";
import { MODE_TEXT } from "../lib/guard-format.ts";
import { useGuardStrings } from "../lib/guard-strings.ts";
import { useModelCatalog } from "../lib/model-config.ts";
import { useApp } from "../store/app.ts";
import { useGuard } from "../store/guard.ts";
import { ModelSelect } from "./ModelSelect.tsx";
import { Switch } from "./Switch.tsx";
import { Button, CardHeader, cx, Spinner } from "./ui.tsx";

/** What the last change came to: saving it, saved, or what the server said against it. */
type Outcome =
	| { state: "idle" }
	| { state: "saving" }
	| { state: "saved" }
	| { state: "error"; why: "guard.loadFailed" | "guard.saveFailed"; error: string };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const POLICY_TEXT: Record<PolicyStatus, MessageKey> = {
	default: "guard.settingsPolicyDefault",
	custom: "guard.settingsPolicyCustom",
	outdated: "guard.settingsPolicyOutdated",
};

/**
 * Settings › Safety: "Guard dangerous commands". Every risky tool call, of the main agent and of its subagents, is approved
 * or refused by a reviewer model, or by the person ("Ask me"), or not looked at (Off). A change is sent at once and the
 * answer is what the card shows; a change made in another tab arrives as `guard_config`. What the guard decided, how strict
 * it is for each kind of call, the reviewer's rules and the benchmark are on the Guard page; this card keeps a link to it and
 * a line that says where they stand. The settings and the decisions are for the page on this computer: a page that came
 * through the tunnel has no such card (see `SettingsPage`).
 */
export function GuardSettings() {
	const t = useT();
	const ready = useGuardStrings();
	const stored = useGuard((s) => s.config);
	const rules = useGuard((s) => s.rules);
	const lastId = useGuard((s) => s.last?.id);
	const setView = useApp((s) => s.setView);
	// What was chosen shows at once, and stays until the server has answered: kept, or refused (it goes back).
	const [draft, setDraft] = useState<Partial<GuardConfig>>({});
	const config = stored && { ...stored, ...draft };
	const models = useModelCatalog(true, "omp");
	const [outcome, setOutcome] = useState<Outcome>({ state: "idle" });
	/** How many decisions the log holds: the line under the settings says so. */
	const [recorded, setRecorded] = useState<number | null>(null);

	useEffect(() => {
		let alive = true;
		guardApi
			.config()
			.catch((e) => alive && setOutcome({ state: "error", why: "guard.loadFailed", error: messageOf(e) }));
		guardApi.rules().catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	// The count is read again when a decision is made while this card is open.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `lastId` is what says a decision arrived.
	useEffect(() => {
		let alive = true;
		guardApi.log({ limit: 1 }).then(
			(res) => alive && setRecorded(res.total),
			() => {},
		);
		return () => {
			alive = false;
		};
	}, [lastId]);

	if (!ready) return null;

	const change = async (patch: Partial<GuardConfig>) => {
		setDraft((d) => ({ ...d, ...patch }));
		setOutcome({ state: "saving" });
		try {
			await guardApi.change(patch);
			setOutcome({ state: "saved" });
		} catch (e) {
			setOutcome({ state: "error", why: "guard.saveFailed", error: messageOf(e) });
		} finally {
			// What the server holds now is what is shown: the answer is in the store, or the change was refused.
			setDraft((d) => Object.fromEntries(Object.entries(d).filter(([key]) => !(key in patch))));
		}
	};

	const summary = {
		policy: t(POLICY_TEXT[policyStatus(rules?.policy)]),
		changed: Object.keys(rules?.thresholds ?? {}).length,
	};

	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="guard-settings">
			<CardHeader icon={<ScanEye size={16} />} title={t("guard.title")} hint={t("guard.guardIntro")} />
			<fieldset className="space-y-1" disabled={config === null}>
				<legend className="mb-1.5 text-sm">{t("guard.guardTitle")}</legend>
				{GUARD_MODES.map((mode) => {
					const on = config?.mode === mode;
					return (
						<label
							key={mode}
							className={cx(
								"flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
								on ? "border-accent bg-accent-soft" : "border-border hover:bg-hover",
								mode === "off" && on && "border-warning bg-warning/10",
							)}
						>
							<input
								type="radio"
								name="guard-mode"
								className="mt-1 accent-[var(--accent)]"
								data-testid={`guard-mode-${mode}`}
								checked={on}
								onChange={() => void change({ mode })}
							/>
							<span>
								{t(MODE_TEXT[mode].label)}
								<span className="block text-xs text-muted">{t(MODE_TEXT[mode].hint)}</span>
							</span>
						</label>
					);
				})}
			</fieldset>

			{config?.mode === "reviewer" ? (
				<div className="mt-3 space-y-3">
					<div>
						<div className="mb-1 text-sm">{t("guard.reviewerLabel")}</div>
						<ModelSelect
							value={config.reviewer}
							models={models}
							label={t("guard.reviewerLabel")}
							testid="guard-reviewer"
							blank={t("guard.reviewerBlank")}
							onChange={(reviewer) => void change({ reviewer })}
						/>
						<p className="mt-1 text-xs text-muted">{t("guard.reviewerHint")}</p>
					</div>
					<div className="flex items-start gap-3">
						<Switch
							checked={config.askWhenUnavailable}
							label={t("guard.askUnavailable")}
							data-testid="guard-ask-unavailable"
							onCheckedChange={(askWhenUnavailable) => void change({ askWhenUnavailable })}
						/>
						<div className="min-w-0 flex-1 text-sm">
							{t("guard.askUnavailable")}
							<span className="block text-xs text-muted">{t("guard.askUnavailableHint")}</span>
						</div>
					</div>
					<div className="flex items-start gap-3">
						<Switch
							checked={config.askWhenDenied}
							label={t("guard.askDenied")}
							data-testid="guard-ask-denied"
							onCheckedChange={(askWhenDenied) => void change({ askWhenDenied })}
						/>
						<div className="min-w-0 flex-1 text-sm">
							{t("guard.askDenied")}
							<span className="block text-xs text-muted">{t("guard.askDeniedHint")}</span>
						</div>
					</div>
				</div>
			) : null}

			<div className="mt-2 min-h-5 text-xs" role="status" data-testid="guard-status" data-state={outcome.state}>
				{outcome.state === "saving" ? (
					<span className="inline-flex items-center gap-1.5 text-muted">
						<Spinner size={12} /> {t("guard.saving")}
					</span>
				) : outcome.state === "saved" ? (
					<span className="inline-flex items-center gap-1.5 text-success">
						<Check size={12} aria-hidden /> {t("guard.saved")}
					</span>
				) : outcome.state === "error" ? (
					<span className="inline-flex items-start gap-1.5 text-danger" data-testid="guard-error">
						<CircleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
						<span className="break-words">{t(outcome.why, { error: outcome.error })}</span>
					</span>
				) : null}
			</div>

			<p className="mt-2 text-xs text-muted" data-testid="guard-note">
				{t("guard.note")}
			</p>

			<p className="mt-2 text-xs text-muted" data-testid="guard-per-conversation">
				{t("guard.perConversation")}
			</p>

			<div className="mt-3 flex flex-wrap items-center gap-3" data-testid="guard-summary">
				<dl
					className="grid min-w-0 flex-1 basis-56 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs"
					data-testid="guard-summary-line"
				>
					{recorded === null ? null : (
						<>
							<dt className="text-muted">{t("guard.settingsSummaryDecisions")}</dt>
							<dd>
								{recorded === 0
									? t("guard.settingsSummaryDecisionsNone")
									: t("guard.settingsSummaryDecisionsCount", { count: recorded })}
							</dd>
							<dt className="text-muted">{t("guard.settingsSummaryRules")}</dt>
							<dd>{summary.policy}</dd>
							<dt className="text-muted">{t("guard.settingsSummaryChanged")}</dt>
							<dd className="tabular-nums">{summary.changed}</dd>
						</>
					)}
				</dl>
				<Button size="sm" data-testid="guard-open-page" onClick={() => setView({ kind: "guard" })}>
					{t("guard.settingsOpenPage")}
				</Button>
			</div>
		</section>
	);
}
