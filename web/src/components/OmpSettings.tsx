import type { InstallMethod } from "@shared/omp-install.ts";
import { ExternalLink, Package, RefreshCw } from "lucide-react";
import { useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { describeHolds, needsYou } from "../lib/omp-holds.ts";
import { useApp } from "../store/app.ts";
import { ompApi, useOmp } from "../store/omp.ts";
import { useOmpUpdate } from "./OmpUpdateNotice.tsx";
import { Button, CardHeader, Spinner, WithCode } from "./ui.tsx";

const METHOD_NAMES: Record<InstallMethod, MessageKey> = {
	homebrew: "omp.methodHomebrew",
	bun: "omp.methodBun",
	npm: "omp.methodNpm",
	installer: "omp.methodInstaller",
	mise: "omp.methodMise",
	nix: "omp.methodNix",
	managed: "omp.methodManaged",
	unknown: "omp.methodUnknown",
};

/** What the Update button does for each way omp can have been installed. */
const UPDATE_VIA: Record<InstallMethod, MessageKey> = {
	homebrew: "omp.updateViaHomebrew",
	bun: "omp.updateViaBun",
	npm: "omp.updateViaNpm",
	installer: "omp.updateViaInstaller",
	mise: "omp.updateViaMise",
	nix: "omp.updateViaNix",
	managed: "omp.updateViaManaged",
	unknown: "omp.updateViaUnknown",
};

/**
 * Settings › omp: which omp runs and how it was installed, whether a newer release exists (with a button to look
 * now, and one to update), the "Update omp automatically" setting, and the first-time setup again.
 */
export function OmpSettings() {
	const t = useT();
	const state = useOmp((s) => s.state);
	const toast = useApp((s) => s.toast);
	const { start, dialog } = useOmpUpdate();
	// What was just chosen, until the server has answered: the box follows the click at once.
	const [chosen, setChosen] = useState<boolean | null>(null);
	const remotePage = useApp((s) => s.meta?.remote === true);
	if (state?.status !== "ready" || !state.install) return null;

	const { install, release, compat, job } = state;
	const name = t(METHOD_NAMES[install.method], { name: install.managedBy ?? "" });
	const updating = job?.kind === "update" && (job.state === "waiting" || job.state === "running");
	const setAuto = (on: boolean) => {
		setChosen(on);
		ompApi
			.setAutoUpdate(on)
			.catch((e: Error) => toast("error", t("omp.settingsAutoFailed", { error: e.message })))
			.finally(() => setChosen(null));
	};

	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="omp-settings">
			<CardHeader
				icon={<Package size={16} />}
				title={t("omp.settingsTitle")}
				// From a remote page this card still updates omp, unlike the app's Updates card: it says on which computer.
				hint={remotePage ? t("omp.settingsRemoteNote") : undefined}
			/>
			<div className="space-y-1 text-sm">
				<div data-testid="omp-installed-version">{t("omp.settingsVersion", { version: state.version ?? "" })}</div>
				<div className="break-all text-xs text-muted">
					<WithCode text={t("omp.settingsLocation", { path: state.bin ?? "" })} />
				</div>
				<div className="text-xs text-muted" data-testid="omp-install-method" data-method={install.method}>
					{t("omp.settingsVia", { method: name })} <WithCode text={t(UPDATE_VIA[install.method], { name })} />
				</div>
				<div className="text-xs text-muted" data-testid="omp-compat" data-verdict={compat.verdict}>
					{t("omp.settingsSupported", { range: compat.range })}{" "}
					{compat.verdict === "newer"
						? t("omp.settingsCompatNewer")
						: compat.verdict === "older"
							? t("omp.settingsCompatOlder")
							: t("omp.settingsCompatOk")}
				</div>
			</div>

			<div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
				<div className="min-w-0 flex-1 basis-56 text-sm" data-testid="omp-latest" role="status">
					{release ? (
						release.newer ? (
							<>
								{t("omp.settingsAvailable", { latest: release.latest })}{" "}
								<a
									href={release.changelogUrl}
									target="_blank"
									rel="noreferrer noopener"
									className="inline-flex items-center gap-1 text-accent underline"
								>
									{t("omp.noticeReleaseNotes")} <ExternalLink size={12} />
								</a>
							</>
						) : (
							t("omp.settingsUpToDate", { latest: release.latest })
						)
					) : (
						<span className="text-muted">{t("omp.settingsNotChecked")}</span>
					)}
					{release ? (
						<span className="block text-xs text-muted">
							{t("omp.settingsCheckedAt", { when: new Date(release.checkedAt).toLocaleTimeString() })}
						</span>
					) : null}
					{state.releaseError ? (
						<span className="block text-xs text-warning" data-testid="omp-check-error">
							{t("omp.settingsCheckFailed", { error: state.releaseError })}
						</span>
					) : null}
				</div>
				<Button
					size="sm"
					data-testid="omp-check"
					disabled={state.checking}
					onClick={() => void ompApi.check().catch((e: Error) => toast("error", e.message))}
				>
					{state.checking ? <Spinner size={13} /> : <RefreshCw size={13} />}{" "}
					{state.checking ? t("omp.settingsChecking") : t("omp.settingsCheck")}
				</Button>
				{release?.newer && install.updatable ? (
					<Button
						size="sm"
						variant="primary"
						data-testid="omp-settings-update"
						disabled={updating}
						onClick={() => start(release)}
					>
						{t("omp.settingsUpdate")}
					</Button>
				) : null}
			</div>

			<label className="mt-3 flex cursor-pointer items-start gap-3 text-sm">
				<input
					type="checkbox"
					className="mt-1 accent-[var(--accent)]"
					data-testid="auto-update-omp"
					checked={chosen ?? state.autoUpdate}
					disabled={!install.updatable}
					onChange={(e) => setAuto(e.target.checked)}
				/>
				<span>
					{t("omp.settingsAuto")}
					<span className="block text-xs text-muted">
						<WithCode text={t("omp.settingsAutoHint")} />
					</span>
				</span>
			</label>
			{state.autoUpdate && state.autoWaitingFor && needsYou(state.autoWaitingFor) > 0 ? (
				<p className="mt-1 pl-7 text-xs text-warning" data-testid="auto-update-waiting" role="status">
					{t("omp.noticeAutoWaiting", { what: describeHolds(state.autoWaitingFor, t) })}{" "}
					{t("omp.settingsAutoWaitingHint")}
				</p>
			) : null}

			<div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
				<Button
					size="sm"
					data-testid="rerun-setup"
					onClick={() =>
						void ompApi
							.setOnboarding(true)
							.catch((e: Error) => toast("error", t("omp.settingsSetupFailed", { error: e.message })))
					}
				>
					{t("omp.settingsSetupAgain")}
				</Button>
				<span className="text-xs text-muted">{t("omp.settingsSetupAgainHint")}</span>
			</div>
			{dialog}
		</section>
	);
}
