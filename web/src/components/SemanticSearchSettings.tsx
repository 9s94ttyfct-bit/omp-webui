import type { SemanticFailure, SemanticStatus } from "@shared/semantic.ts";
import { useEffect, useId, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { useConfirmFocus } from "../lib/confirm-focus.ts";
import { fmtInt } from "../lib/format.ts";
import { fmtMem } from "../lib/host-rows.ts";
import { semanticApi } from "../lib/semantic-api.ts";
import { useApp } from "../store/app.ts";
import { LoadError } from "./LoadError.tsx";
import { Button, CardHeader, cx, Spinner } from "./ui.tsx";

/** How often the card asks while something moves (a download, the indexing), and while nothing does. */
const BUSY_POLL_MS = 1000;
const IDLE_POLL_MS = 15_000;

const FAILURE_KEYS: Record<SemanticFailure["code"], MessageKey> = {
	unsupported: "pages.settingsSemanticFailUnsupported",
	download: "pages.settingsSemanticFailDownload",
	verify: "pages.settingsSemanticFailVerify",
	space: "pages.settingsSemanticFailSpace",
	unpack: "pages.settingsSemanticFailUnpack",
	runtime: "pages.settingsSemanticFailRuntime",
};

/**
 * Settings › Conversations › Semantic search (`shared/semantic.ts`): off until the person turns it on; on, it says how far
 * the download and then the indexing are, what the model runs on (the GPU llama.cpp found, or the processor) and what it
 * takes on disk, and turning it off deletes all of it (after a question: it is a download of hundreds of megabytes to get
 * back). Only the person's own page may turn it on or off (`canChange`); any other page sees it as it is.
 */
export function SemanticSearchSettings() {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const [status, setStatus] = useState<SemanticStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const opener = useConfirmFocus<HTMLButtonElement>(confirming);
	const questionId = useId();
	// Why the state could not be read (until it can be), and the number of the read Try again starts.
	const [loadError, setLoadError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const moving = status?.state === "installing" || (status?.state === "on" && status.index?.running === true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a Try again is a new read
	useEffect(() => {
		let live = true;
		let timer: ReturnType<typeof setTimeout>;
		const ask = () =>
			semanticApi.status().then(
				(s) => {
					if (!live) return;
					setStatus(s);
					setLoadError(null);
					timer = setTimeout(ask, moving ? BUSY_POLL_MS : IDLE_POLL_MS);
				},
				(e: unknown) => {
					if (!live) return;
					setLoadError((e as Error).message);
					timer = setTimeout(ask, IDLE_POLL_MS);
				},
			);
		void ask();
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [moving, attempt]);
	const set = async (on: boolean) => {
		setBusy(true);
		try {
			setStatus(await semanticApi.set(on));
			setConfirming(false);
		} catch (e) {
			toast("error", (e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const size = status ? fmtMem(status.downloadBytes) : "";
	const disk = status?.diskBytes ? fmtMem(status.diskBytes) : null;
	const off = (
		<div className="mt-3 space-y-2" data-testid="semantic-off-area">
			{confirming ? (
				<div
					className="space-y-2 rounded-lg border border-border p-3 text-sm"
					role="alertdialog"
					aria-labelledby={questionId}
				>
					<p id={questionId}>{t("pages.settingsSemanticOffConfirm", { size: disk ?? size })}</p>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="danger"
							disabled={busy}
							data-testid="semantic-off-yes"
							onClick={() => void set(false)}
						>
							{busy ? <Spinner size={12} /> : null}
							{t("pages.settingsSemanticOffYes")}
						</Button>
						<Button size="sm" autoFocus disabled={busy} onClick={() => setConfirming(false)}>
							{t("common.cancel")}
						</Button>
					</div>
				</div>
			) : (
				<Button
					ref={opener}
					size="sm"
					disabled={!status?.canChange || busy}
					data-testid="semantic-off"
					onClick={() => setConfirming(true)}
				>
					{t(status?.state === "installing" ? "pages.settingsSemanticCancel" : "pages.settingsSemanticOff")}
				</Button>
			)}
		</div>
	);
	return (
		<section
			className="rounded-2xl border border-border bg-surface p-4"
			data-testid="semantic-settings"
			data-setting="semantic-search"
			data-state={status?.state}
		>
			<CardHeader title={t("pages.settingsSemantic")} hint={t("pages.settingsSemanticHint")} />
			{status === null ? (
				loadError ? (
					<LoadError
						title={t("pages.settingsSemanticLoadFailed")}
						error={loadError}
						onRetry={() => {
							setLoadError(null);
							setAttempt((n) => n + 1);
						}}
					/>
				) : (
					<Spinner size={14} />
				)
			) : !status.supported ? (
				<p className="text-sm text-muted" data-testid="semantic-unsupported">
					{t("pages.settingsSemanticUnsupported")}
				</p>
			) : status.state === "off" ? (
				<div className="space-y-2">
					<p className="text-xs text-muted">{t("pages.settingsSemanticWhat", { size })}</p>
					<Button disabled={!status.canChange || busy} data-testid="semantic-on" onClick={() => void set(true)}>
						{busy ? <Spinner size={12} /> : null}
						{t("pages.settingsSemanticOn", { size })}
					</Button>
				</div>
			) : (
				<div className="space-y-1.5 text-sm" data-testid="semantic-status">
					{status.state === "installing" ? (
						<Progress
							label={t("pages.settingsSemanticDownloading", {
								done: fmtMem(status.download?.received ?? 0),
								total: fmtMem(status.download?.total || status.downloadBytes),
							})}
							value={status.download?.received ?? 0}
							max={status.download?.total || status.downloadBytes}
							testId="semantic-download"
						/>
					) : null}
					{status.state === "on" && status.index ? (
						status.index.running && status.index.indexed < status.index.total ? (
							<Progress
								label={t("pages.settingsSemanticIndexing", {
									done: fmtInt(status.index.indexed),
									total: fmtInt(status.index.total),
								})}
								value={status.index.indexed}
								max={status.index.total}
								testId="semantic-indexing"
							/>
						) : (
							<p data-testid="semantic-indexed">
								{t("pages.settingsSemanticIndexed", { total: fmtInt(status.index.indexed) })}
							</p>
						)
					) : null}
					{status.state === "on" && status.device !== undefined ? (
						<p className="text-xs text-muted" data-testid="semantic-device">
							{status.device === null
								? t("pages.settingsSemanticCpu")
								: t("pages.settingsSemanticDevice", { device: status.device })}
						</p>
					) : null}
					{disk && status.state !== "installing" ? (
						<p className="text-xs text-muted">{t("pages.settingsSemanticDisk", { size: disk })}</p>
					) : null}
					{status.failure ? (
						<p className="text-xs text-warning" role="status" data-testid="semantic-failure">
							{t(FAILURE_KEYS[status.failure.code], { detail: status.failure.detail ?? "" })}
						</p>
					) : null}
					{status.state === "failed" ? (
						<Button
							size="sm"
							disabled={!status.canChange || busy}
							data-testid="semantic-retry"
							onClick={() => void set(true)}
						>
							{t("pages.settingsSemanticRetry")}
						</Button>
					) : null}
					{off}
				</div>
			)}
			{status && !status.canChange && status.supported ? (
				<p className="mt-2 text-xs text-muted" data-testid="semantic-not-owner">
					{t("pages.settingsSemanticRemote")}
				</p>
			) : null}
		</section>
	);
}

function Progress({ label, value, max, testId }: { label: string; value: number; max: number; testId: string }) {
	const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : null;
	return (
		<div className="space-y-1" data-testid={testId}>
			<div
				role="progressbar"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={percent ?? undefined}
				className="h-1.5 overflow-hidden rounded-full bg-border"
			>
				<div
					className={cx("h-full rounded-full bg-accent transition-[width]", percent === null && "w-1/3 animate-pulse")}
					style={percent === null ? undefined : { width: `${percent}%` }}
				/>
			</div>
			<p className="text-xs text-muted">{label}</p>
		</div>
	);
}
