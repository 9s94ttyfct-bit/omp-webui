import type { OmpRelease } from "@shared/omp-install.ts";
import { CircleCheck, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useT } from "../i18n/index.ts";
import { jobErrorText } from "../lib/error-text.ts";
import { describeHolds, needsYou } from "../lib/omp-holds.ts";
import { useApp } from "../store/app.ts";
import { dismissedNotices, dismissNotice, OmpRequestError, ompApi, useOmp } from "../store/omp.ts";
import { OmpLog } from "./OmpLog.tsx";
import { Button, cx, Modal, Spinner } from "./ui.tsx";

/**
 * Starting an update: now, or after asking when the release is outside the versions this web UI supports (the
 * server asks for that acknowledgement too, so a page that missed the release being outside still gets asked).
 * `dialog` must be rendered where `start` is used.
 */
export function useOmpUpdate(): { start(release: Pick<OmpRelease, "latest" | "compat">): void; dialog: ReactNode } {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const range = useOmp((s) => s.state?.compat.range ?? "");
	const [asking, setAsking] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);

	const run = async (latest: string, acknowledge: boolean) => {
		setStarting(true);
		try {
			await ompApi.update(acknowledge);
			setAsking(null);
		} catch (e) {
			if (e instanceof OmpRequestError && e.code === "outside_compat") setAsking(latest);
			else {
				setAsking(null);
				toast("error", t("omp.noticeStartFailed", { error: (e as Error).message }));
			}
		} finally {
			setStarting(false);
		}
	};

	return {
		start: (release) => (release.compat === "supported" ? void run(release.latest, false) : setAsking(release.latest)),
		dialog: (
			<Modal
				open={asking !== null}
				onOpenChange={(o) => !o && !starting && setAsking(null)}
				title={t("omp.confirmTitle")}
				description={t("omp.confirmBody", { latest: asking ?? "", range })}
			>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" disabled={starting} onClick={() => setAsking(null)}>
						{t("common.cancel")}
					</Button>
					<Button
						variant="danger"
						data-testid="confirm-outside-compat"
						disabled={starting}
						onClick={() => asking && void run(asking, true)}
					>
						{starting ? <Spinner size={14} /> : <RefreshCw size={13} />} {t("omp.confirmUpdate")}
					</Button>
				</div>
			</Modal>
		),
	};
}

type Tone = "info" | "warning" | "error" | "success";

const TONES: Record<Tone, string> = {
	info: "bg-accent-soft",
	warning: "bg-warning/15",
	error: "bg-danger/10",
	success: "bg-success/15",
};

const ICON_TONES: Record<Tone, string> = {
	info: "text-accent",
	warning: "text-warning",
	error: "text-danger",
	success: "text-success",
};

/**
 * The strip above the page that tells about omp itself: a newer release (with its release notes and an Update
 * button), an update waiting for the conversations to finish or running, how it ended, and — at start and after
 * an update — an installed omp outside the versions this web UI is made for. One notice at a time, the most
 * pressing first; a release or a version warning can be put away until the version it names changes.
 */
export function OmpUpdateNotice() {
	const t = useT();
	const state = useOmp((s) => s.state);
	const log = useOmp((s) => s.log);
	const [dismissed, setDismissed] = useState(dismissedNotices);
	const [showLog, setShowLog] = useState(false);
	const toast = useApp((s) => s.toast);
	const { start, dialog } = useOmpUpdate();
	if (state?.status !== "ready") return null;

	const { job, release, compat } = state;
	const act = (p: Promise<unknown>) => p.catch((e: Error) => toast("error", e.message));
	const dismissJob = () => void act(ompApi.cancel());

	let tone: Tone;
	let kind: string;
	let icon: ReactNode;
	let text: ReactNode;
	let actions: ReactNode = null;
	let withLog = false;

	if (job?.kind === "update" && job.state === "waiting") {
		const held = job.waiting;
		// Paused conversations and ones waiting for an answer stay until the user acts: only the user can say "go on".
		const stuck = needsYou(held) > 0 && !job.anyway;
		tone = stuck ? "warning" : "info";
		kind = "waiting";
		icon = stuck ? <TriangleAlert size={14} /> : <Spinner size={14} />;
		if (stuck) text = t("omp.noticeWaitingHeld", { what: describeHolds(held, t) });
		else if (job.anyway) {
			text =
				held.working === 1 ? t("omp.noticeWaitingAnywayOne") : t("omp.noticeWaitingAnywayMany", { n: held.working });
		} else text = held.working === 1 ? t("omp.noticeWaitingOne") : t("omp.noticeWaitingMany", { n: held.working });
		actions = (
			<>
				{stuck ? (
					<Button
						size="sm"
						variant="primary"
						data-testid="omp-update-anyway"
						onClick={() => void act(ompApi.update(false, true))}
					>
						{t("omp.noticeUpdateAnyway")}
					</Button>
				) : null}
				<Button size="sm" variant="ghost" data-testid="omp-update-cancel" onClick={dismissJob}>
					{t("omp.noticeCancel")}
				</Button>
			</>
		);
	} else if (job?.kind === "update" && job.state === "running") {
		tone = "info";
		kind = "running";
		icon = <Spinner size={14} />;
		text = job.auto ? t("omp.noticeUpdatingAuto") : t("omp.noticeUpdating");
		withLog = true;
	} else if (job?.kind === "update" && job.state === "failed") {
		tone = "error";
		kind = "failed";
		icon = <TriangleAlert size={14} />;
		text = <span className="whitespace-pre-wrap">{t("omp.noticeUpdateFailed", { error: jobErrorText(job) })}</span>;
		withLog = true;
		actions = (
			<>
				{release?.newer ? (
					<Button size="sm" data-testid="omp-update-retry" onClick={() => start(release)}>
						{t("omp.noticeRetry")}
					</Button>
				) : null}
				<Button size="sm" variant="ghost" onClick={dismissJob}>
					{t("omp.noticeDismiss")}
				</Button>
			</>
		);
	} else if (job?.kind === "update" && job.state === "done") {
		tone = "success";
		kind = "done";
		icon = <CircleCheck size={14} />;
		text = t("omp.noticeUpdated", { version: job.version ?? state.version ?? "" });
		actions = (
			<Button size="sm" variant="ghost" data-testid="omp-update-done-dismiss" onClick={dismissJob}>
				{t("omp.noticeDismiss")}
			</Button>
		);
	} else if (
		(compat.verdict === "newer" || compat.verdict === "older") &&
		state.version &&
		dismissed.compat !== state.version
	) {
		const version = state.version;
		tone = "warning";
		kind = "compat";
		icon = <TriangleAlert size={14} />;
		text = t(compat.verdict === "newer" ? "omp.noticeCompatNewer" : "omp.noticeCompatOlder", {
			version,
			range: compat.range,
		});
		actions = (
			<>
				{compat.verdict === "older" && release?.newer && state.install?.updatable ? (
					<Button size="sm" data-testid="omp-update" onClick={() => start(release)}>
						{t("omp.noticeUpdate")}
					</Button>
				) : null}
				<Button
					size="sm"
					variant="ghost"
					data-testid="omp-notice-dismiss"
					onClick={() => {
						dismissNotice("compat", version);
						setDismissed(dismissedNotices());
					}}
				>
					{t("omp.noticeDismiss")}
				</Button>
			</>
		);
	} else if (release?.newer && state.install?.updatable && dismissed.update !== release.latest) {
		const outside = release.compat !== "supported";
		tone = outside ? "warning" : "info";
		kind = outside ? "update-outside" : "update";
		icon = outside ? <TriangleAlert size={14} /> : <RefreshCw size={14} />;
		text = (
			<>
				{outside
					? t("omp.noticeUpdateOutsideCompat", { latest: release.latest, range: compat.range })
					: t("omp.noticeUpdateAvailable", { latest: release.latest, current: state.version ?? "" })}{" "}
				<a
					href={release.changelogUrl}
					target="_blank"
					rel="noreferrer noopener"
					className="inline-flex items-center gap-1 text-accent underline"
					data-testid="omp-release-notes"
				>
					{t("omp.noticeReleaseNotes")} <ExternalLink size={12} />
				</a>
				{state.autoUpdate && state.autoWaitingFor && needsYou(state.autoWaitingFor) > 0 ? (
					<span className="mt-0.5 block" data-testid="omp-auto-waiting">
						{t("omp.noticeAutoWaiting", { what: describeHolds(state.autoWaitingFor, t) })}
					</span>
				) : null}
			</>
		);
		actions = (
			<>
				<Button size="sm" variant="primary" data-testid="omp-update" onClick={() => start(release)}>
					{outside ? t("omp.noticeUpdateAnyway") : t("omp.noticeUpdate")}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					data-testid="omp-notice-dismiss"
					onClick={() => {
						dismissNotice("update", release.latest);
						setDismissed(dismissedNotices());
					}}
				>
					{t("omp.noticeLater")}
				</Button>
			</>
		);
	} else {
		return null;
	}

	return (
		<div
			role="status"
			data-testid="omp-notice"
			data-kind={kind}
			className={cx("shrink-0 border-b border-border px-4 py-2 text-xs", TONES[tone])}
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				<span className={cx("shrink-0", ICON_TONES[tone])}>{icon}</span>
				<span className="min-w-0 flex-1 basis-64">{text}</span>
				<div className="flex items-center gap-1.5">
					{withLog && log ? (
						<Button size="sm" variant="ghost" aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>
							{showLog ? t("omp.noticeHideLog") : t("omp.noticeShowLog")}
						</Button>
					) : null}
					{actions}
				</div>
			</div>
			{withLog && showLog ? (
				<OmpLog log={log} label={t("omp.noticeLogLabel")} className="mt-2" testid="omp-update-log" />
			) : null}
			{dialog}
		</div>
	);
}
