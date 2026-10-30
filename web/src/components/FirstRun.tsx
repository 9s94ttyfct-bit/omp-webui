import type { InstallOption, InstallOptionId } from "@shared/omp-install.ts";
import { Check, ChevronRight, Copy, Download, TriangleAlert } from "lucide-react";
import { useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { jobErrorText } from "../lib/error-text.ts";
import { useApp } from "../store/app.ts";
import { ompApi, useOmp } from "../store/omp.ts";
import { OmpLog } from "./OmpLog.tsx";
import { Badge, Button, cx, Spinner, WithCode } from "./ui.tsx";

const NAMES: Record<InstallOptionId, { name: MessageKey; hint: MessageKey }> = {
	homebrew: { name: "omp.optionHomebrew", hint: "omp.optionHomebrewHint" },
	installer: { name: "omp.optionInstaller", hint: "omp.optionInstallerHint" },
	bun: { name: "omp.optionBun", hint: "omp.optionBunHint" },
};

/**
 * Shown instead of the app while omp is missing (or found but not running): how to install it, with the exact
 * command each choice runs, then the install itself with its output as it comes and what went wrong when it
 * did. When it succeeds the server finds omp and starts the first-time setup (`Onboarding`) by itself.
 */
export function FirstRun() {
	const t = useT();
	const state = useOmp((s) => s.state);
	const log = useOmp((s) => s.log);
	const toast = useApp((s) => s.toast);
	const [choice, setChoice] = useState<InstallOptionId | null>(null);
	const [copied, setCopied] = useState<InstallOptionId | null>(null);
	const [looking, setLooking] = useState(false);
	const [missedAgain, setMissedAgain] = useState(false);
	if (!state) return null;

	const options = state.options;
	const selected = options.find((o) => o.id === (choice ?? options.find((x) => x.recommended)?.id));
	const job = state.job?.kind === "install" ? state.job : null;
	const running = job?.state === "running";
	const failed = job?.state === "failed";

	const install = (o: InstallOption) => {
		setMissedAgain(false);
		ompApi.install(o.id).catch((e: Error) => toast("error", t("omp.installStartFailed", { error: e.message })));
	};
	const copy = (o: InstallOption) => {
		void navigator.clipboard?.writeText(o.command).then(() => {
			setCopied(o.id);
			setTimeout(() => setCopied((c) => (c === o.id ? null : c)), 1500);
		});
	};
	const lookAgain = async () => {
		setLooking(true);
		setMissedAgain(false);
		try {
			const snap = await ompApi.recheck();
			setMissedAgain(snap.state.status !== "ready");
		} catch (e) {
			toast("error", t("omp.installRecheckFailed", { error: (e as Error).message }));
		} finally {
			setLooking(false);
		}
	};

	const broken = state.status === "broken";
	return (
		<main className="flex h-full overflow-y-auto p-6" data-testid="first-run">
			<div className="m-auto w-full min-w-0 max-w-xl rounded-2xl border border-border bg-surface p-6 shadow-xl">
				<h1 className="mb-2 flex items-center gap-2 text-lg font-semibold">
					<Download size={19} className="text-accent" />
					{t(broken ? "omp.firstRunBrokenTitle" : "omp.firstRunTitle")}
				</h1>
				<p className="mb-3 text-sm text-muted">
					<WithCode text={t("omp.firstRunIntro")} />
				</p>
				{broken ? (
					<div className="mb-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs" data-testid="omp-broken">
						<div className="mb-1 whitespace-pre-wrap break-words">
							<WithCode text={t("omp.firstRunBroken", { bin: state.bin ?? "omp", error: state.error ?? "" })} />
						</div>
						<div className="text-muted">{t("omp.firstRunBrokenHint")}</div>
					</div>
				) : (
					// A long list of paths on a phone: said in a line, the places themselves one tap away.
					<details className="group mb-3 text-xs text-muted" data-testid="omp-searched">
						<summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
							<ChevronRight size={12} className="shrink-0 transition-transform group-open:rotate-90" />
							<WithCode text={t("omp.firstRunSearched", { n: state.searched.length })} />
						</summary>
						<ul className="mt-1 space-y-0.5 pl-4">
							{state.searched.map((dir) => (
								<li key={dir} className="break-all font-mono">
									{dir}
								</li>
							))}
						</ul>
					</details>
				)}

				{job && (running || failed) ? (
					<div className="mb-3" data-testid="install-job" data-state={job.state}>
						{running ? (
							<div className="mb-2 flex items-center gap-2 text-sm font-medium">
								<Spinner size={15} />
								{t("omp.installRunning", {
									method: options.find((o) => o.id === job.method)
										? t(NAMES[job.method as InstallOptionId].name)
										: job.method,
								})}
							</div>
						) : (
							<div
								className="mb-2 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm"
								data-testid="install-failed"
							>
								<TriangleAlert size={16} className="mt-0.5 shrink-0 text-danger" />
								<div className="min-w-0">
									<div className="font-medium">{t("omp.installFailedTitle")}</div>
									<div className="mt-1 whitespace-pre-wrap break-words text-xs">{jobErrorText(job)}</div>
								</div>
							</div>
						)}
						<div className="mb-1 font-mono text-xs text-muted">$ {job.command}</div>
						<OmpLog log={log} label={t("omp.installLogLabel")} empty={t("omp.installNoOutput")} testid="install-log" />
						<div className="mt-3 flex justify-end gap-2">
							{running ? (
								<Button variant="ghost" data-testid="install-cancel" onClick={() => void ompApi.cancel()}>
									{t("omp.installCancel")}
								</Button>
							) : (
								<Button variant="primary" data-testid="install-retry" onClick={() => void ompApi.cancel()}>
									{t("omp.installTryAgain")}
								</Button>
							)}
						</div>
					</div>
				) : (
					<>
						{/* A fieldset's own `min-width: min-content` would keep the card as wide as its longest command. */}
						<fieldset className="min-w-0 space-y-2" aria-label={t("omp.optionsLabel")}>
							<legend className="sr-only">{t("omp.optionsLabel")}</legend>
							{options.map((o) => {
								const on = selected?.id === o.id;
								return (
									<div
										key={o.id}
										data-testid={`install-option-${o.id}`}
										data-available={o.available}
										className={cx(
											"min-w-0 rounded-xl border px-3 py-2.5 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
											on ? "border-accent bg-accent-soft" : "border-border hover:bg-hover",
										)}
									>
										{/* An option that cannot run is dimmed at its name, not at its command: that stays readable (4.5:1) to copy. */}
										<label
											className={cx(
												"flex items-start gap-3",
												o.available ? "cursor-pointer" : "cursor-not-allowed opacity-60",
											)}
										>
											<input
												type="radio"
												name="install-method"
												className="mt-1 accent-[var(--accent)]"
												disabled={!o.available}
												checked={on}
												onChange={() => setChoice(o.id)}
											/>
											<span className="min-w-0 flex-1">
												<span className="flex flex-wrap items-center gap-2 font-medium">
													{t(NAMES[o.id].name)}
													{o.recommended ? <Badge tone="accent">{t("omp.optionRecommended")}</Badge> : null}
												</span>
												<span className="block text-xs text-muted">
													<WithCode text={t(NAMES[o.id].hint)} />
												</span>
												{!o.available && o.needs ? (
													<span className="mt-1 block text-xs text-warning">
														<WithCode text={t("omp.optionMissingTool", { tool: o.needs })} />
													</span>
												) : null}
											</span>
										</label>
										{/* The label above the command, not beside it: a phone's width goes to the command. The command wraps where it
										    has spaces, and breaks inside a word only when that word alone is wider than the box. */}
										<div className="mt-2 pl-7">
											<div className="text-xs text-muted">{t("omp.optionCommand")}</div>
											<div className="mt-1 flex items-start gap-2">
												<code
													className="min-w-0 flex-1 break-words rounded-md bg-bg-soft px-2 py-1 font-mono text-xs"
													data-testid={`install-command-${o.id}`}
												>
													{o.command}
												</code>
												<button
													type="button"
													aria-label={`${t("common.copy")}: ${o.command}`}
													className="shrink-0 rounded-md p-1 text-muted hover:bg-hover hover:text-fg"
													onClick={(e) => {
														e.preventDefault();
														copy(o);
													}}
												>
													{copied === o.id ? <Check size={13} /> : <Copy size={13} />}
												</button>
											</div>
										</div>
									</div>
								);
							})}
						</fieldset>
						<div className="mt-4 flex flex-wrap items-center justify-between gap-2">
							<Button
								variant="ghost"
								size="sm"
								data-testid="install-recheck"
								disabled={looking}
								onClick={() => void lookAgain()}
							>
								{looking ? <Spinner size={13} /> : null} {t("omp.installRecheck")}
							</Button>
							<Button
								variant="primary"
								data-testid="install-start"
								disabled={!selected?.available}
								onClick={() => selected && install(selected)}
							>
								<Download size={14} /> {t("omp.installButton")}
							</Button>
						</div>
						{missedAgain ? (
							<p className="mt-2 text-right text-xs text-warning" role="status" data-testid="install-not-found">
								{t("omp.installRecheckNone")}
							</p>
						) : null}
					</>
				)}
			</div>
		</main>
	);
}
