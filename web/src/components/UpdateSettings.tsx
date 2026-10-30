import { PREF } from "@shared/prefs.ts";
import type { AppUpdateState, CheckFailure } from "@shared/update.ts";
import { CircleCheck, Download, ExternalLink, RefreshCw, TriangleAlert, X } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { registerStrings, useLang, useT } from "../i18n/index.ts";
import { en } from "../i18n/update.ts";
import {
	BLOCK_KEYS,
	canCancel,
	failureMessage,
	formatBytes,
	formatProgress,
	notesFor,
	outcomeMessage,
	PHASE_KEYS,
	progressPercent,
	refusalMessage,
	replyingOf,
	versionOfTag,
} from "../lib/app-update.ts";
import { fmtTime } from "../lib/format.ts";
import { onPrefsChanged, setPref } from "../lib/prefs.ts";
import { webUrl } from "../lib/web-url.ts";
import { useApp } from "../store/app.ts";
import { AppUpdateRequestError, appUpdateApi, useAppUpdate } from "../store/app-update.ts";
import { Button, CardHeader, cx, Modal, Spinner, WithCode } from "./ui.tsx";

// This card is a lazy chunk (Settings); the strings are not in the first page, so the card brings its own.
registerStrings("update", en);

const Markdown = lazy(() => import("./Markdown.tsx").then((m) => ({ default: m.Markdown })));

/** Automatic checks are on unless the user turned them off. */
const autoCheckOn = () => localStorage.getItem(PREF.appUpdateCheck) !== "off";

/** A line that says why the last look gave no answer: neutral when there is no release, a warning otherwise. */
function CheckFailureLine({ failure }: { failure: CheckFailure }) {
	const t = useT();
	const lang = useLang((s) => s.lang);
	if (failure.code === "noRelease") {
		return (
			<p className="text-xs text-muted" role="status" data-testid="update-no-release">
				{t("update.noRelease")}
			</p>
		);
	}
	const text =
		failure.code === "offline"
			? t("update.offline")
			: failure.code === "rateLimited"
				? failure.retryAt
					? t("update.rateLimitedAt", { when: new Date(failure.retryAt).toLocaleTimeString(lang) })
					: t("update.rateLimited")
				: failure.code === "http"
					? t("update.http", { status: failure.status })
					: t("update.badAnswer");
	return (
		<p
			className="flex items-start gap-1.5 text-xs text-warning"
			role="status"
			data-testid="update-check-failed"
			data-code={failure.code}
		>
			<TriangleAlert size={13} className="mt-px shrink-0" /> {text}
		</p>
	);
}

/** The install under way: where it is, how much of the download is in, and a way to stop it while that is possible. */
function Progress({ job, onCancel }: { job: NonNullable<AppUpdateState["job"]>; onCancel: () => void }) {
	const t = useT();
	const percent = progressPercent(job.received, job.total);
	const downloading = job.phase === "downloading";
	return (
		<div
			className="space-y-2 rounded-xl border border-border bg-bg-soft px-3 py-2.5"
			data-testid="update-progress"
			data-phase={job.phase}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="flex min-w-0 flex-1 basis-48 items-center gap-2 text-sm" role="status">
					<Spinner size={14} />
					{t(PHASE_KEYS[job.phase], { version: versionOfTag(job.tag) })}
				</span>
				{canCancel(job.phase) ? (
					<Button size="sm" data-testid="update-cancel" onClick={onCancel}>
						{t("update.cancel")}
					</Button>
				) : null}
			</div>
			{downloading ? (
				<div className="space-y-1">
					<div
						role="progressbar"
						aria-label={t("update.progressLabel")}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={percent ?? undefined}
						aria-valuetext={formatProgress(job.received, job.total)}
						className="h-1.5 overflow-hidden rounded-full bg-border"
					>
						<div
							className={cx(
								"h-full rounded-full bg-accent transition-[width]",
								percent === null && "w-1/3 animate-pulse",
							)}
							style={percent === null ? undefined : { width: `${percent}%` }}
						/>
					</div>
					<div className="text-xs text-muted" data-testid="update-progress-text">
						{formatProgress(job.received, job.total)}
					</div>
				</div>
			) : null}
		</div>
	);
}

/**
 * Settings › Updates: which omp-webui runs and which is the newest release, a button to look now, the release's notes,
 * the button that downloads and installs it (with the reasons it cannot, when it cannot), the install's progress, why
 * an install did not go on, how the last update ended, and whether the app looks on its own. The server owns all of it
 * (`server/update/`); the card shows its state and sends the user's clicks. A page that came in through the tunnel is
 * refused by every route and shows one line.
 */
export function UpdateSettings() {
	const t = useT();
	const lang = useLang((s) => s.lang);
	const toast = useApp((s) => s.toast);
	const remotePage = useApp((s) => s.meta?.remote === true);
	const state = useAppUpdate((s) => s.state);
	const loaded = useAppUpdate((s) => s.loaded);
	const [auto, setAuto] = useState(autoCheckOn);
	/** A request of this page is on its way: the buttons wait for it, whatever the server's state already says. */
	const [busy, setBusy] = useState<"check" | "install" | null>(null);
	/** What a refused install said, until the next click. */
	const [refusal, setRefusal] = useState<string | null>(null);
	/** The conversations a refused install named, while the user is asked. */
	const [asking, setAsking] = useState<{ tag: string; stopped: number; staying: number } | null>(null);

	// Look when the page opens, not before: the first page does not ask.
	useEffect(() => {
		if (!remotePage) void appUpdateApi.load().catch(() => {});
	}, [remotePage]);
	// Another window chose whether the app looks on its own.
	useEffect(() => onPrefsChanged((keys) => keys.includes(PREF.appUpdateCheck) && setAuto(autoCheckOn())), []);

	if (remotePage) {
		return (
			<section className="rounded-2xl border border-border bg-surface p-4" data-testid="update-settings">
				<CardHeader icon={<Download size={16} />} title={t("update.title")} />
				<p className="text-sm text-muted" data-testid="update-refused">
					{t("update.remoteRefused")}
				</p>
			</section>
		);
	}

	const check = () => {
		setBusy("check");
		appUpdateApi
			.check()
			.catch((e: Error) => toast("error", e.message))
			.finally(() => setBusy(null));
	};

	const install = async (tag: string, anyway: boolean) => {
		setBusy("install");
		setRefusal(null);
		try {
			await appUpdateApi.install(tag, anyway);
			setAsking(null);
		} catch (e) {
			if (e instanceof AppUpdateRequestError && e.code === "replying") {
				setAsking({ tag, ...replyingOf(e.params) });
			} else {
				setAsking(null);
				const known = e instanceof AppUpdateRequestError ? refusalMessage(e.code, e.params, versionOfTag(tag)) : null;
				setRefusal(known ? t(known.key, known.vars) : t("update.requestFailed", { error: (e as Error).message }));
				// The state the click was made on is not the server's now.
				void appUpdateApi.load().catch(() => {});
			}
		} finally {
			setBusy(null);
		}
	};

	const dialog = (
		<Modal
			open={asking !== null}
			onOpenChange={(o) => !o && busy !== "install" && setAsking(null)}
			title={t("update.confirmTitle")}
		>
			<div data-testid="update-confirm-replying">
				<p className="text-sm">
					{asking?.stopped === 1
						? t("update.confirmBodyOne")
						: t("update.confirmBodyMany", { n: asking?.stopped ?? 0 })}
				</p>
				{asking?.staying ? (
					<p className="mt-1 text-sm text-muted">
						{asking.staying === 1
							? t("update.confirmStayingOne")
							: t("update.confirmStayingMany", { n: asking.staying })}
					</p>
				) : null}
				<div className="mt-4 flex justify-end gap-2">
					<Button variant="ghost" disabled={busy === "install"} onClick={() => setAsking(null)}>
						{t("common.cancel")}
					</Button>
					<Button
						variant="danger"
						data-testid="update-confirm-anyway"
						disabled={busy === "install"}
						onClick={() => asking && void install(asking.tag, true)}
					>
						{busy === "install" ? <Spinner size={14} /> : <RefreshCw size={13} />} {t("update.confirmAnyway")}
					</Button>
				</div>
			</div>
		</Modal>
	);

	const autoCheck = (
		<label className="mt-3 flex cursor-pointer items-start gap-3 border-t border-border pt-3 text-sm">
			<input
				type="checkbox"
				className="mt-1 accent-[var(--accent)]"
				data-testid="update-auto"
				checked={auto}
				onChange={(e) => {
					setPref(PREF.appUpdateCheck, e.target.checked ? "on" : "off");
					setAuto(e.target.checked);
				}}
			/>
			<span>
				{t("update.auto")}
				<span className="block text-xs text-muted">{t("update.autoHint")}</span>
			</span>
		</label>
	);

	if (!state) {
		return (
			<section className="rounded-2xl border border-border bg-surface p-4" data-testid="update-settings">
				<CardHeader icon={<Download size={16} />} title={t("update.title")} hint={t("update.hint")} />
				{loaded ? (
					<div className="flex flex-wrap items-center gap-2">
						<p className="min-w-0 flex-1 basis-56 text-sm text-muted" role="status">
							{t("update.loadFailed")}
						</p>
						<Button size="sm" data-testid="update-check" disabled={busy === "check"} onClick={check}>
							{busy === "check" ? <Spinner size={13} /> : <RefreshCw size={13} />} {t("update.check")}
						</Button>
					</div>
				) : (
					<Spinner />
				)}
				{autoCheck}
			</section>
		);
	}

	const { latest, job, failed, outcome, install: can } = state;
	const checking = state.checking || busy === "check";
	const releaseUrl = webUrl(latest?.url);
	const notes = latest && state.newer ? notesFor(latest.notes, lang) : "";
	const blocked = can.allowed ? null : can.reason;
	const failure = failed ? failureMessage(failed) : null;
	const outcomeText = outcome ? outcomeMessage(outcome) : null;

	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="update-settings">
			<CardHeader icon={<Download size={16} />} title={t("update.title")} hint={t("update.hint")} />

			{outcome && outcomeText ? (
				<div
					className={cx(
						"mb-3 flex items-start gap-2 rounded-xl px-3 py-2 text-sm",
						outcome.ok ? "bg-success/15" : "bg-warning/15",
					)}
					role="status"
					data-testid="update-outcome"
					data-ok={outcome.ok}
				>
					<span className={cx("mt-0.5 shrink-0", outcome.ok ? "text-success" : "text-warning")}>
						{outcome.ok ? <CircleCheck size={15} /> : <TriangleAlert size={15} />}
					</span>
					<span className="min-w-0 flex-1">{t(outcomeText.key, outcomeText.vars)}</span>
					<button
						type="button"
						aria-label={t("update.dismiss")}
						data-testid="update-outcome-dismiss"
						className="shrink-0 rounded-md p-1 text-muted hover:bg-hover hover:text-fg"
						onClick={() => void appUpdateApi.dismiss().catch((e: Error) => toast("error", e.message))}
					>
						<X size={14} />
					</button>
				</div>
			) : null}

			<div className="space-y-1 text-sm">
				<div data-testid="update-installed">{t("update.versionInstalled", { version: state.installed })}</div>
				<div role="status" data-testid="update-latest" data-newer={state.newer}>
					{latest ? (
						state.newer ? (
							<span className="font-medium">{t("update.available", { version: latest.version })}</span>
						) : (
							<>
								{t("update.versionLatest", { version: latest.version })}{" "}
								<span className="text-muted">{t("update.upToDate")}</span>
							</>
						)
					) : (
						<span className="text-muted">{t("update.versionLatestUnknown")}</span>
					)}
				</div>
			</div>

			<div className="mt-2 flex flex-wrap items-center gap-2">
				<div className="min-w-0 flex-1 basis-56 space-y-1">
					<p className="text-xs text-muted" data-testid="update-checked">
						{state.checkedAt === null
							? t("update.neverChecked")
							: t("update.checkedAt", { when: fmtTime(state.checkedAt) })}
					</p>
					{state.failure ? <CheckFailureLine failure={state.failure} /> : null}
				</div>
				<Button size="sm" data-testid="update-check" disabled={checking} onClick={check}>
					{checking ? <Spinner size={13} /> : <RefreshCw size={13} />}{" "}
					{checking ? t("update.checking") : t("update.check")}
				</Button>
			</div>

			{latest && state.newer ? (
				<div className="mt-3 space-y-3 border-t border-border pt-3">
					{notes ? (
						<div>
							<div className="mb-1 text-xs font-medium text-muted">
								{t("update.notesLabel", { version: latest.version })}
							</div>
							{/* A box that scrolls must be reachable with the keyboard, or its end cannot be read without a mouse. */}
							<section
								className="prose-flush max-h-64 overflow-y-auto rounded-xl border border-border bg-bg-soft p-3 text-sm"
								data-testid="update-notes"
								// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region has to take focus
								tabIndex={0}
								aria-label={t("update.notesLabel", { version: latest.version })}
							>
								<Suspense fallback={<p className="whitespace-pre-wrap">{notes}</p>}>
									<Markdown text={notes} />
								</Suspense>
							</section>
						</div>
					) : null}

					<div className="flex flex-wrap items-center gap-2">
						{releaseUrl ? (
							<a
								href={releaseUrl}
								target="_blank"
								rel="noreferrer noopener"
								data-testid="update-release-link"
								className="inline-flex items-center gap-1 text-sm text-accent underline"
							>
								{t("update.releasePage")} <ExternalLink size={12} />
							</a>
						) : null}
						{latest.asset && !job ? (
							<div className="ml-auto flex items-center gap-2">
								<span className="text-xs text-muted" data-testid="update-size">
									{formatBytes(latest.asset.size)}
								</span>
								<Button
									variant="primary"
									data-testid="update-install"
									disabled={blocked !== null || busy === "install"}
									onClick={() => void install(latest.tag, false)}
								>
									{busy === "install" ? <Spinner size={14} /> : <Download size={14} />} {t("update.install")}
								</Button>
							</div>
						) : null}
					</div>

					{latest.asset ? null : (
						<p className="text-sm text-muted" role="status" data-testid="update-no-asset">
							{t("update.noAsset", { version: latest.version })}
						</p>
					)}
					{latest.asset && blocked ? (
						<p className="text-xs text-muted" role="status" data-testid="update-blocked" data-reason={blocked}>
							{t(BLOCK_KEYS[blocked], { version: latest.version })}
						</p>
					) : null}
				</div>
			) : null}

			{refusal ? (
				<p className="mt-3 flex items-start gap-1.5 text-xs text-warning" role="status" data-testid="update-refusal">
					<TriangleAlert size={13} className="mt-px shrink-0" /> {refusal}
				</p>
			) : null}

			{job ? (
				<div className="mt-3">
					<Progress
						job={job}
						onCancel={() => void appUpdateApi.cancel().catch((e: Error) => toast("error", e.message))}
					/>
				</div>
			) : null}

			{failed && failure ? (
				<div
					className="mt-3 space-y-2 rounded-xl bg-warning/15 px-3 py-2.5 text-sm"
					role="alert"
					data-testid="update-failed"
					data-code={failed.code}
				>
					<div className="flex items-start gap-2">
						<TriangleAlert size={15} className="mt-0.5 shrink-0 text-warning" />
						<div className="min-w-0 flex-1">
							<div className="font-medium">{t("update.failedTitle")}</div>
							<p className="whitespace-pre-wrap break-words">
								{failed.code === "bundleId" || failed.code === "notWritable" ? (
									<WithCode text={t(failure.key, failure.vars)} />
								) : (
									t(failure.key, failure.vars)
								)}
							</p>
						</div>
						<button
							type="button"
							aria-label={t("update.dismiss")}
							data-testid="update-dismiss"
							className="shrink-0 rounded-md p-1 text-muted hover:bg-hover hover:text-fg"
							onClick={() => void appUpdateApi.dismiss().catch((e: Error) => toast("error", e.message))}
						>
							<X size={14} />
						</button>
					</div>
					{!job && latest?.tag === failed.tag && !blocked ? (
						<div className="pl-6">
							<Button
								size="sm"
								data-testid="update-retry"
								disabled={busy === "install"}
								onClick={() => void install(failed.tag, false)}
							>
								<RefreshCw size={13} /> {t("update.retry")}
							</Button>
						</div>
					) : null}
				</div>
			) : null}

			{autoCheck}
			{dialog}
		</section>
	);
}
