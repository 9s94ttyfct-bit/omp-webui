import { APPROVAL_MODES, type ApprovalMode, isApprovalMode } from "@shared/approval.ts";
import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { type ApprovalDefault, sessionActions } from "../lib/api.ts";
import { useApp } from "../store/app.ts";
import { APPROVAL_META } from "./ApprovalPicker.tsx";
import { CardHeader, cx, WithCode } from "./ui.tsx";

/**
 * The permission mode new conversations start in. By default it is whatever omp's own settings say (`omp config`,
 * shown here); choosing one makes the web UI start every new conversation in it. Each conversation can still switch
 * its own mode from the composer.
 */
export function ApprovalSettings() {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const [state, setState] = useState<ApprovalDefault | null>(null);
	useEffect(() => {
		void sessionActions
			.approvalDefault()
			.then(setState)
			.catch(() => {});
	}, []);
	const choose = (mode: ApprovalMode | null) => {
		const before = state;
		setState((s) => s && { ...s, mode });
		sessionActions
			.setApprovalDefault(mode)
			.then(setState)
			.catch((e) => {
				setState(before);
				toast("error", t("pages.settingsApprovalFailed", { error: e.message }));
			});
	};
	const options: { mode: ApprovalMode | null; label: string; hint?: string }[] = [
		{
			mode: null,
			label: state?.omp
				? t("pages.settingsApprovalFollow", {
						mode: isApprovalMode(state.omp) ? t(APPROVAL_META[state.omp].label) : state.omp,
					})
				: t("pages.settingsApprovalFollowUnknown"),
		},
		...APPROVAL_MODES.map((mode) => ({
			mode,
			label: t(APPROVAL_META[mode].label),
			hint: t(APPROVAL_META[mode].hint),
		})),
	];
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="approval-settings">
			<CardHeader title={t("pages.settingsApproval")} />
			<fieldset className="space-y-1">
				<legend className="mb-1.5 text-sm">{t("pages.settingsApprovalDefault")}</legend>
				{options.map((o) => {
					const on = state !== null && state.mode === o.mode;
					return (
						<label
							key={o.mode ?? "omp"}
							className={cx(
								"flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
								on ? "border-accent bg-accent-soft" : "border-border hover:bg-hover",
								o.mode === "yolo" && on && "border-warning bg-warning/10",
							)}
						>
							<input
								type="radio"
								name="approval-default"
								className="mt-1 accent-[var(--accent)]"
								data-testid={`approval-default-${o.mode ?? "omp"}`}
								disabled={state === null}
								checked={on}
								onChange={() => choose(o.mode)}
							/>
							<span>
								{o.label}
								{o.hint ? <span className="block text-xs text-muted">{o.hint}</span> : null}
							</span>
						</label>
					);
				})}
			</fieldset>
			<p className="mt-3 text-xs text-muted">
				<WithCode text={t("pages.settingsApprovalHint")} />
			</p>
		</section>
	);
}
