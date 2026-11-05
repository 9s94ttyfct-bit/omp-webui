import type { BrowserAutoCheck } from "@shared/browser.ts";
import { BROWSER_SIZE_BOUNDS, DESKTOP_SIZE, formatBrowserSize, parseBrowserSize } from "@shared/browser-protocol.ts";
import { PREF } from "@shared/prefs.ts";
import { TriangleAlert } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { en } from "../../i18n/browser.ts";
import { registerStrings, useT } from "../../i18n/index.ts";
import { formatProgress, progressPercent } from "../../lib/app-update.ts";
import { storedBrowserSize } from "../../lib/browser-size.ts";
import { fmtTime } from "../../lib/format.ts";
import { reloadPanes } from "../../lib/panel-panes.ts";
import { onPrefsChanged, setPref } from "../../lib/prefs.ts";
import { useApp } from "../../store/app.ts";
import { browserApi, useBrowserState } from "../../store/browser.ts";
import { Button, CardHeader, cx, Modal, Spinner } from "../ui.tsx";

// This card is a lazy chunk (Settings); the strings are not in the first page, so the card brings its own.
registerStrings("browser", en);

/**
 * Settings › Browser (docs/agents/browser.md): whether the built-in browser is used at all (`ompw.browser`: off, no Browser
 * tab and no browser tool for the agents), which engine this server drives and its version, and Clear browser data, which
 * asks first. Chrome for Testing (the server runs it alone) also has whether it updates itself (`ompw.browserAutoUpdate`, on
 * by default, with what the last automatic check came to), the newest version, Install / Update with progress and Cancel,
 * and Uninstall; CEF comes with the Mac app and updates with it. The server decides who may manage it (`canManage`: this
 * computer, or a page signed in through Access); a page that may not sees the versions and no buttons. Under it, the size
 * new pages are laid out at.
 */
export function BrowserSettings() {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const state = useBrowserState((s) => s.state);
	const [busy, setBusy] = useState<"check" | "install" | "clear" | "uninstall" | null>(null);
	const [asking, setAsking] = useState<"clear" | "uninstall" | null>(null);
	const [on, setOn] = useState(() => localStorage.getItem(PREF.browser) !== "off");
	const [auto, setAuto] = useState(() => localStorage.getItem(PREF.browserAutoUpdate) !== "off");

	useEffect(() => {
		browserApi.load().catch(() => {});
	}, []);
	useEffect(
		() =>
			onPrefsChanged((keys) => {
				if (keys.includes(PREF.browser)) setOn(localStorage.getItem(PREF.browser) !== "off");
				if (keys.includes(PREF.browserAutoUpdate)) setAuto(localStorage.getItem(PREF.browserAutoUpdate) !== "off");
			}),
		[],
	);

	const run = (what: "check" | "install" | "clear" | "uninstall", call: () => Promise<unknown>) => {
		setBusy(what);
		call()
			.catch((e: Error) => toast("error", t("browser.requestFailed", { error: e.message })))
			.finally(() => setBusy(null));
	};

	const job = state?.job ?? null;
	const cef = state?.engine === "cef";
	const newer = state?.installed && state.latest && state.latest !== state.installed.version ? state.latest : null;
	const percent = job ? progressPercent(job.received, job.total) : null;

	return (
		<section
			className="space-y-3 rounded-2xl border border-border bg-surface p-4"
			data-testid="browser-settings"
			data-setting="browser"
		>
			<CardHeader title={t("browser.title")} hint={t("browser.hint")} />
			<label className="flex cursor-pointer items-start gap-3 text-sm">
				<input
					type="checkbox"
					className="mt-1 accent-[var(--accent)]"
					data-testid="browser-enabled"
					checked={on}
					disabled={!state?.canManage}
					onChange={(e) => {
						setPref(PREF.browser, e.target.checked ? null : "off");
						setOn(e.target.checked);
						// The side panel of this page draws its tabs again (another page hears it from the server).
						reloadPanes();
					}}
				/>
				<span>
					{t("browser.enabledTitle")}
					<span className="block text-xs text-muted">{t("browser.enabledHint")}</span>
				</span>
			</label>
			{on ? null : (
				<p className="text-xs text-warning" role="status" data-testid="browser-off">
					{t("browser.offNote")}
				</p>
			)}
			{state?.engine === "cft" ? (
				<label className="flex cursor-pointer items-start gap-3 text-sm">
					<input
						type="checkbox"
						className="mt-1 accent-[var(--accent)]"
						data-testid="browser-auto-update"
						checked={auto}
						disabled={!state.canManage}
						onChange={(e) => {
							setPref(PREF.browserAutoUpdate, e.target.checked ? null : "off");
							setAuto(e.target.checked);
						}}
					/>
					<span>
						{t("browser.autoUpdateTitle")}
						<span className="block text-xs text-muted">{t("browser.autoUpdateHint")}</span>
					</span>
				</label>
			) : null}
			{state ? (
				<>
					<dl className="divide-y divide-border rounded-xl border border-border text-sm">
						<div className="flex justify-between gap-3 px-3 py-1.5">
							<dt className="text-muted">{t("browser.engine")}</dt>
							<dd data-testid="browser-engine" data-engine={state.engine}>
								{cef ? t("browser.engineCef") : t("browser.engineCft")}
							</dd>
						</div>
						<div className="flex justify-between gap-3 px-3 py-1.5">
							<dt className="text-muted">{t(cef ? "browser.version" : "browser.installed")}</dt>
							<dd className="font-mono text-xs tabular-nums" data-testid="browser-installed">
								{state.installed ? state.installed.version : t("browser.notInstalled")}
							</dd>
						</div>
						{cef ? null : (
							<div className="flex justify-between gap-3 px-3 py-1.5">
								<dt className="text-muted">{t("browser.newest")}</dt>
								<dd className="font-mono text-xs tabular-nums" data-testid="browser-latest">
									{state.latest ?? t("browser.newestUnknown")}
								</dd>
							</div>
						)}
					</dl>
					{cef ? (
						<p className="text-xs text-muted" data-testid="browser-cef-bundled">
							{t("browser.cefBundled")}
						</p>
					) : newer ? (
						<p className="text-xs" data-testid="browser-newer">
							{t("browser.newer", { version: newer })}
						</p>
					) : state.installed && state.latest ? (
						<p className="text-xs text-muted" data-testid="browser-up-to-date">
							{t("browser.upToDate")}
						</p>
					) : null}
					{!cef && auto && state.autoCheck ? <AutoCheckLine check={state.autoCheck} /> : null}
					{job ? (
						<div
							className="space-y-2 rounded-xl border border-border bg-bg-soft px-3 py-2.5"
							data-testid="browser-progress"
							data-kind={job.kind}
						>
							<div className="flex flex-wrap items-center gap-2">
								<span className="flex min-w-0 flex-1 basis-48 items-center gap-2 text-sm" role="status">
									<Spinner size={14} />
									{t(
										job.kind === "clear"
											? "browser.jobClear"
											: job.kind === "uninstall"
												? "browser.jobUninstall"
												: job.kind === "update"
													? "browser.jobUpdate"
													: "browser.jobInstall",
									)}
								</span>
								{(job.kind === "install" || job.kind === "update") && state.canManage ? (
									<Button
										size="sm"
										data-testid="browser-cancel"
										onClick={() => run("install", () => browserApi.cancel())}
									>
										{t("browser.cancel")}
									</Button>
								) : null}
							</div>
							{job.kind === "install" || job.kind === "update" ? (
								<div className="space-y-1">
									<div
										role="progressbar"
										aria-label={t("browser.progressLabel")}
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
									<div className="text-xs text-muted" data-testid="browser-progress-text">
										{formatProgress(job.received, job.total)}
									</div>
								</div>
							) : null}
						</div>
					) : null}
					{state.error ? (
						<p className="flex items-start gap-1.5 text-xs text-warning" role="status" data-testid="browser-error">
							<TriangleAlert size={13} className="mt-px shrink-0" /> {t("browser.failed", { error: state.error })}
						</p>
					) : null}
					{state.restartNeeded ? (
						<p className="text-xs text-warning" role="status" data-testid="browser-restart-needed">
							{t("browser.restartNeeded")}
						</p>
					) : null}
					{state.canManage ? (
						<>
							{cef ? null : (
								<div className="flex flex-wrap gap-2">
									{!state.installed ? (
										<Button
											variant="primary"
											disabled={job !== null || busy !== null}
											data-testid="browser-install"
											onClick={() => run("install", () => browserApi.install())}
										>
											{t("browser.install")}
										</Button>
									) : newer ? (
										<Button
											variant="primary"
											disabled={job !== null || busy !== null}
											data-testid="browser-update"
											onClick={() => run("install", () => browserApi.install())}
										>
											{t("browser.update")}
										</Button>
									) : null}
									<Button
										disabled={job !== null || busy !== null}
										data-testid="browser-check"
										onClick={() => run("check", () => browserApi.check())}
									>
										{busy === "check" ? <Spinner size={13} /> : null}
										{t("browser.check")}
									</Button>
								</div>
							)}
							<div className={cx("space-y-1", !cef && "border-t border-border pt-3")}>
								<div className="flex flex-wrap gap-2">
									<Button
										variant="outline"
										disabled={job !== null || busy !== null}
										data-testid="browser-clear"
										onClick={() => setAsking("clear")}
									>
										{t("browser.clear")}
									</Button>
									{state.installed && !cef ? (
										<Button
											variant="outline"
											disabled={job !== null || busy !== null}
											data-testid="browser-uninstall"
											onClick={() => setAsking("uninstall")}
										>
											{t("browser.uninstall")}
										</Button>
									) : null}
								</div>
								<p className="text-xs text-muted">{t("browser.clearHint")}</p>
								{state.installed && !cef ? <p className="text-xs text-muted">{t("browser.uninstallHint")}</p> : null}
							</div>
						</>
					) : (
						<p className="text-xs text-muted" data-testid="browser-cannot-manage">
							{t("browser.cannotManage")}
						</p>
					)}
				</>
			) : (
				<p className="flex items-center gap-2 text-sm text-muted">
					<Spinner size={14} />
				</p>
			)}
			<SizeSetting />
			<Modal
				open={asking !== null}
				onOpenChange={(open) => !open && setAsking(null)}
				title={t(asking === "uninstall" ? "browser.uninstallTitle" : "browser.clearTitle")}
			>
				<div data-testid={asking === "uninstall" ? "browser-uninstall-confirm" : "browser-clear-confirm"}>
					<p className="text-sm">
						{asking === "uninstall"
							? t("browser.uninstallBody")
							: t(cef ? "browser.clearBodyCef" : "browser.clearBodyCft")}
					</p>
					<div className="mt-4 flex justify-end gap-2">
						<Button onClick={() => setAsking(null)}>{t("browser.cancel")}</Button>
						{asking === "uninstall" ? (
							<Button
								variant="danger"
								data-testid="browser-uninstall-go"
								onClick={() => {
									setAsking(null);
									run("uninstall", () => browserApi.uninstall());
								}}
							>
								{t("browser.uninstallConfirm")}
							</Button>
						) : (
							<Button
								variant="danger"
								data-testid="browser-clear-go"
								onClick={() => {
									setAsking(null);
									run("clear", () => browserApi.clear());
								}}
							>
								{t("browser.clearConfirm")}
							</Button>
						)}
					</div>
				</div>
			</Modal>
		</section>
	);
}

/** What the last automatic update check came to, and when (never an error toast: a failure waits for the next check). */
function AutoCheckLine({ check }: { check: BrowserAutoCheck }) {
	const t = useT();
	const vars = { time: fmtTime(check.at), version: check.version ?? "", error: check.error ?? "" };
	const text =
		check.result === "failed"
			? t("browser.autoFailed", vars)
			: check.result === "waiting"
				? t("browser.autoWaiting", vars)
				: check.result === "updated"
					? t("browser.autoUpdated", vars)
					: t("browser.autoUpToDate", vars);
	return (
		<p
			className={cx("text-xs", check.result === "failed" ? "text-warning" : "text-muted")}
			role="status"
			data-testid="browser-auto-check"
			data-result={check.result}
		>
			{text}
		</p>
	);
}

/**
 * The desktop size new pages are laid out at (`ompw.browserSize`): kept when both sides are within bounds. A size out of
 * them is not kept, and the line under the fields says so (with the size that is kept) until a size is kept.
 */
function SizeSetting() {
	const t = useT();
	const errorId = useId();
	const [kept, setKept] = useState(storedBrowserSize);
	const [draft, setDraft] = useState({ w: String(kept.w), h: String(kept.h) });
	const [refused, setRefused] = useState(false);
	useEffect(
		() =>
			onPrefsChanged((keys) => {
				if (!keys.includes(PREF.browserSize)) return;
				const now = storedBrowserSize();
				setKept(now);
				setDraft({ w: String(now.w), h: String(now.h) });
				setRefused(false);
			}),
		[],
	);
	const save = (next: { w: string; h: string }) => {
		const size = parseBrowserSize(`${next.w}x${next.h}`);
		setRefused(!size);
		if (!size || (size.w === kept.w && size.h === kept.h)) return;
		setKept(size);
		const isDefault = size.w === DESKTOP_SIZE.w && size.h === DESKTOP_SIZE.h;
		setPref(PREF.browserSize, isDefault ? null : formatBrowserSize(size));
	};
	const field = (side: "w" | "h", label: string) => {
		// This side alone, against the shared rule (the other side given one it takes).
		const invalid = refused && !parseBrowserSize(`${draft[side]}x${BROWSER_SIZE_BOUNDS.min}`);
		return (
			<label className="flex items-center gap-1.5 text-xs text-muted">
				{label}
				<input
					type="number"
					inputMode="numeric"
					min={BROWSER_SIZE_BOUNDS.min}
					max={BROWSER_SIZE_BOUNDS.max}
					value={draft[side]}
					aria-invalid={invalid || undefined}
					aria-describedby={invalid ? errorId : undefined}
					className="h-8 w-20 rounded-lg border border-border bg-bg px-2 text-sm text-fg tabular-nums"
					data-testid={`browser-size-${side === "w" ? "width" : "height"}`}
					onChange={(e) => setDraft({ ...draft, [side]: e.target.value })}
					onBlur={() => save(draft)}
					onKeyDown={(e) => e.key === "Enter" && save(draft)}
				/>
			</label>
		);
	};
	return (
		<div className="space-y-1.5 border-t border-border pt-3" data-testid="browser-size-setting">
			<div className="text-sm font-medium">{t("browser.sizeTitle")}</div>
			<p className="text-xs text-muted">{t("browser.sizeHint")}</p>
			<div className="flex flex-wrap items-center gap-3">
				{field("w", t("browser.width"))}
				<span className="text-faint">×</span>
				{field("h", t("browser.height"))}
				{kept.w !== DESKTOP_SIZE.w || kept.h !== DESKTOP_SIZE.h ? (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							setKept(DESKTOP_SIZE);
							setDraft({ w: String(DESKTOP_SIZE.w), h: String(DESKTOP_SIZE.h) });
							setRefused(false);
							setPref(PREF.browserSize, null);
						}}
					>
						{t("browser.sizeReset")}
					</Button>
				) : null}
			</div>
			{refused ? (
				<p id={errorId} role="alert" className="text-xs text-danger" data-testid="browser-size-error">
					{t("browser.sizeRefused", {
						min: BROWSER_SIZE_BOUNDS.min,
						max: BROWSER_SIZE_BOUNDS.max,
						w: kept.w,
						h: kept.h,
					})}
				</p>
			) : null}
		</div>
	);
}
