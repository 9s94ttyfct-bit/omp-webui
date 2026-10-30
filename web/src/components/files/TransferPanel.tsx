import { type ArchivePlan, TRANSFER_LIMITS } from "@shared/transfer.ts";
import { CircleAlert, FileArchive, FileUp, FolderUp, X } from "lucide-react";
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useLang, useT } from "../../i18n/index.ts";
import { fmtBytes } from "../../lib/files-rows.ts";
import type { FolderScope } from "../../lib/folder-api.ts";
import { downloadFile, isAbort, planArchive, startSave, TransferError } from "../../lib/transfer-api.ts";
import { baseName, joinPath, progressOf, typedPath } from "../../lib/transfer-plan.ts";
import { cancelUpload, clearUpload, isBusy, pickUpload, resolveHeld, useUpload } from "../../lib/transfer-store.ts";
import { describeFailure, leftOutCount, leftOutText } from "../../lib/transfer-words.ts";
import { useApp } from "../../store/app.ts";
import { keyOf } from "../../store/files.ts";
import { Button, IconButton, Modal, Spinner } from "../ui.tsx";

/**
 * Moving files between a page that is not on the computer the server runs on and the folder a conversation works in
 * (#614, step two): upload files or a folder into the folder picked in the tree, download a folder as a ZIP (after
 * seeing what it will hold), download by path what the tree does not show, and watch the uploads. The words of a
 * refusal come from `lib/transfer-words.ts`; nothing is sent that the server would refuse by name.
 */

/** A ZIP being looked at: nothing yet, the server counting what it holds, or its plan waiting for a yes. */
type Zip =
	| { state: "idle" }
	| { state: "planning" }
	| { state: "ready"; path: string; plan: ArchivePlan; hidden: boolean; busy: boolean; expired: boolean };

/** The rows the list draws at most (a folder of thousands of files is a list of thousands of rows). */
const SHOWN = 120;

const failureText = (e: unknown, name: string): string =>
	e instanceof TransferError ? describeFailure(e, name) : e instanceof Error ? e.message : String(e);

export default function TransferPanel({
	scope,
	target,
	canUpload,
}: {
	scope: FolderScope;
	/** The folder uploads go into and a ZIP is made of ("" is the conversation's own folder). */
	target: string;
	canUpload: boolean;
}) {
	const t = useT();
	const lang = useLang((s) => s.lang);
	const toast = useApp((s) => s.toast);
	const upload = useUpload(keyOf(scope));
	const busy = isBusy(upload.rows);
	const filesInput = useRef<HTMLInputElement>(null);
	const folderInput = useRef<HTMLInputElement | null>(null);
	const [zip, setZip] = useState<Zip>({ state: "idle" });
	const [error, setError] = useState<string | null>(null);
	const [pathText, setPathText] = useState("");
	const planning = useRef<AbortController | null>(null);
	useEffect(() => () => planning.current?.abort(), []);

	const saveFile = useCallback(
		async (path: string) => {
			setError(null);
			try {
				await downloadFile(scope, path);
				toast("success", t("files.transferStarted", { name: baseName(path) }));
			} catch (e) {
				setError(failureText(e, baseName(path)));
			}
		},
		[scope, t, toast],
	);

	/** Ask what the ZIP of `path` will hold. `viaPath`: the path was typed, and a file is downloaded as a file instead. */
	const planZip = useCallback(
		async (path: string, hidden: boolean, viaPath = false): Promise<void> => {
			planning.current?.abort();
			const control = new AbortController();
			planning.current = control;
			setError(null);
			// Asking again about the plan on screen keeps it there (and the checkbox that was touched with its focus).
			setZip((z) => (z.state === "ready" && z.path === path ? { ...z, busy: true } : { state: "planning" }));
			try {
				const plan = await planArchive(scope, path, hidden, control.signal);
				if (control.signal.aborted) return;
				setZip({ state: "ready", path, plan, hidden, busy: false, expired: false });
			} catch (e) {
				if (isAbort(e) || control.signal.aborted) return;
				setZip({ state: "idle" });
				if (viaPath && e instanceof TransferError && e.code === "notFolder") {
					await saveFile(path);
				} else if (e instanceof TransferError && (e.code === "tooLarge" || e.code === "tooMany")) {
					setError(
						t("files.transferZipTooLarge", {
							files: TRANSFER_LIMITS.archiveFiles,
							size: fmtBytes(TRANSFER_LIMITS.archiveBytes),
						}),
					);
				} else setError(failureText(e, baseName(path) || path));
			}
		},
		[scope, saveFile, t],
	);

	// A ticket is good for a few minutes, once: the plan says so when it is no more (by this page's clock, which is the one
	// that is certain to agree with itself).
	const ready = zip.state === "ready" ? zip : null;
	useEffect(() => {
		if (!ready) return;
		const timer = setTimeout(
			() => setZip((z) => (z.state === "ready" ? { ...z, expired: true } : z)),
			TRANSFER_LIMITS.ticketMs - 10_000,
		);
		return () => clearTimeout(timer);
	}, [ready]);

	const downloadZip = (plan: Extract<Zip, { state: "ready" }>) => {
		if (plan.expired) {
			void planZip(plan.path, plan.hidden);
			return;
		}
		startSave(plan.plan.url, plan.plan.name);
		toast("success", t("files.transferStarted", { name: plan.plan.name }));
		setZip({ state: "idle" });
	};

	const submitPath = (e: FormEvent) => {
		e.preventDefault();
		const path = typedPath(pathText);
		if (path === null) setError(t("files.transferErrBadRequest"));
		else void planZip(path, false, true);
	};

	const picked = (e: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files ?? []);
		// Chosen again, the same files must count as a choice again.
		e.target.value = "";
		if (files.length > 0) pickUpload(scope, target, files);
	};

	const { rows, notes } = upload;
	const total = progressOf(rows);
	const pct = total.bytes > 0 ? Math.round((100 * total.sent) / total.bytes) : busy ? 0 : 100;
	const ordered =
		rows.length > SHOWN ? [...rows.filter((r) => r.state !== "done"), ...rows.filter((r) => r.state === "done")] : rows;
	const shown = ordered.slice(0, SHOWN);

	return (
		<div className="text-sm" data-testid="transfer-body">
			<h2 className="text-sm font-semibold">{t("files.transferTitle")}</h2>
			<div className="mt-2 text-xs">
				<span className="text-muted">{t("files.transferFolder")}: </span>
				<code className="break-all font-mono" data-testid="transfer-target">
					{target || t("files.transferFolderRoot")}
				</code>
			</div>
			{canUpload ? <p className="mt-0.5 text-xs text-faint">{t("files.transferFolderHint")}</p> : null}

			<div className="mt-2 flex flex-wrap gap-1.5">
				{canUpload ? (
					<>
						<Button
							size="sm"
							className="pointer-coarse:h-9"
							data-testid="transfer-upload-files"
							onClick={() => filesInput.current?.click()}
						>
							<FileUp size={13} /> {t("files.transferUploadFiles")}
						</Button>
						<Button
							size="sm"
							className="pointer-coarse:h-9"
							data-testid="transfer-upload-folder"
							onClick={() => folderInput.current?.click()}
						>
							<FolderUp size={13} /> {t("files.transferUploadFolder")}
						</Button>
					</>
				) : null}
				<Button
					size="sm"
					className="pointer-coarse:h-9"
					data-testid="transfer-zip"
					disabled={zip.state === "planning"}
					onClick={() => void planZip(target, false)}
				>
					<FileArchive size={13} /> {t("files.transferDownloadZip")}
				</Button>
			</div>
			{canUpload ? (
				<>
					<input
						ref={filesInput}
						type="file"
						multiple
						hidden
						tabIndex={-1}
						aria-hidden
						data-testid="transfer-input-files"
						onChange={picked}
					/>
					<input
						ref={(el) => {
							folderInput.current = el;
							el?.setAttribute("webkitdirectory", "");
						}}
						type="file"
						multiple
						hidden
						tabIndex={-1}
						aria-hidden
						data-testid="transfer-input-folder"
						onChange={picked}
					/>
				</>
			) : null}

			{zip.state === "planning" ? (
				<p role="status" className="mt-3 flex items-center gap-2 text-xs text-muted" data-testid="transfer-planning">
					<Spinner size={12} /> {t("files.transferPlanning")}
				</p>
			) : null}
			{ready ? (
				<section
					className="mt-3 rounded-xl border border-border bg-bg-soft p-2.5"
					aria-label={ready.plan.name}
					aria-busy={ready.busy}
					data-testid="transfer-plan"
				>
					<p className="break-words text-sm font-medium" data-testid="transfer-plan-summary">
						{ready.plan.files === 1
							? t("files.transferPlanSummaryOne", { name: ready.plan.name, size: fmtBytes(ready.plan.bytes) })
							: t("files.transferPlanSummary", {
									name: ready.plan.name,
									files: ready.plan.files,
									size: fmtBytes(ready.plan.bytes),
								})}
					</p>
					{leftOutCount(ready.plan.skipped) > 0 ? (
						<p className="mt-1 text-xs text-muted" data-testid="transfer-plan-left-out">
							{t("files.transferPlanLeftOut", {
								n: leftOutCount(ready.plan.skipped),
								reasons: leftOutText(ready.plan.skipped, lang),
							})}
						</p>
					) : null}
					<label className="mt-2 flex items-start gap-2 text-xs">
						<input
							type="checkbox"
							className="mt-0.5 accent-[var(--accent)]"
							checked={ready.plan.hidden}
							disabled={!ready.plan.hiddenAllowed || ready.busy}
							data-testid="transfer-plan-hidden"
							onChange={(e) => void planZip(ready.path, e.target.checked)}
						/>
						<span>{t("files.transferIncludeHidden")}</span>
					</label>
					{ready.plan.hiddenAllowed ? null : (
						<p className="mt-1 text-xs text-faint" data-testid="transfer-plan-hidden-off">
							{t("files.transferIncludeHiddenOff")}
						</p>
					)}
					{ready.expired ? <p className="mt-1 text-xs text-muted">{t("files.transferZipExpired")}</p> : null}
					<div className="mt-2 flex gap-1.5">
						<Button
							size="sm"
							variant="primary"
							className="pointer-coarse:h-9"
							disabled={ready.busy}
							data-testid="transfer-plan-download"
							onClick={() => downloadZip(ready)}
						>
							{ready.expired ? t("files.transferZipAgain") : t("files.transferZipDownload")}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							className="pointer-coarse:h-9"
							data-testid="transfer-plan-cancel"
							onClick={() => setZip({ state: "idle" })}
						>
							{t("common.cancel")}
						</Button>
					</div>
				</section>
			) : null}

			<form className="mt-3 border-t border-border pt-3" onSubmit={submitPath}>
				<label htmlFor="transfer-path" className="text-xs font-medium">
					{t("files.transferByPathLabel")}
				</label>
				<div className="mt-1 flex gap-1.5">
					<input
						id="transfer-path"
						value={pathText}
						onChange={(e) => setPathText(e.target.value)}
						placeholder={t("files.transferByPathPlaceholder")}
						aria-describedby="transfer-path-hint"
						autoComplete="off"
						autoCapitalize="off"
						spellCheck={false}
						data-testid="transfer-path"
						className="h-7 min-w-0 flex-1 rounded-lg border border-border bg-bg-soft px-2 font-mono text-xs outline-none focus:border-faint pointer-coarse:h-9"
					/>
					<Button
						type="submit"
						size="sm"
						className="pointer-coarse:h-9"
						disabled={pathText.trim() === "" || zip.state === "planning"}
						data-testid="transfer-path-go"
					>
						{t("files.transferByPathGo")}
					</Button>
				</div>
				<p id="transfer-path-hint" className="mt-1 text-xs text-faint">
					{t("files.transferByPathHint")}
				</p>
			</form>

			{error ? (
				<p role="alert" className="mt-3 flex items-start gap-1.5 text-xs text-danger" data-testid="transfer-error">
					<CircleAlert size={14} className="mt-px shrink-0" /> <span className="min-w-0 break-words">{error}</span>
				</p>
			) : null}

			{rows.length > 0 || notes.length > 0 ? (
				<section className="mt-3 border-t border-border pt-3" aria-label={t("files.transferProgressTitle")}>
					<div className="flex items-center gap-2">
						<h3 className="min-w-0 flex-1 text-xs font-medium">{t("files.transferProgressTitle")}</h3>
						{busy ? (
							<Button
								size="sm"
								variant="ghost"
								className="pointer-coarse:h-9"
								data-testid="transfer-cancel-all"
								onClick={() => cancelUpload(scope)}
							>
								{t("files.transferCancelAll")}
							</Button>
						) : (
							<Button
								size="sm"
								variant="ghost"
								className="pointer-coarse:h-9"
								data-testid="transfer-clear"
								onClick={() => clearUpload(scope)}
							>
								{t("files.transferClear")}
							</Button>
						)}
					</div>
					<div aria-live="polite" data-testid="transfer-notes">
						{upload.halted ? (
							<p role="alert" className="mt-1 text-xs text-danger" data-testid="transfer-halted">
								{describeFailure(upload.halted, "")}
							</p>
						) : null}
						{notes.map((note) => (
							<p key={`${note.key}:${JSON.stringify(note.vars ?? {})}`} className="mt-1 text-xs text-muted">
								{t(note.key, note.vars)}
							</p>
						))}
						{rows.length > 0 ? (
							<p className="mt-1 text-xs text-muted" data-testid="transfer-overall">
								{t("files.transferOverall", {
									done: total.done,
									total: total.files,
									sent: fmtBytes(total.sent),
									size: fmtBytes(total.bytes),
								})}
								{total.failed > 0 ? `; ${t("files.transferOverallFailed", { n: total.failed })}` : ""}
							</p>
						) : null}
					</div>
					{busy ? (
						<div
							role="progressbar"
							aria-label={t("files.transferProgressTitle")}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={pct}
							className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-hover"
							data-testid="transfer-overall-bar"
						>
							<div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
						</div>
					) : null}
					<ul className="mt-2 space-y-1.5" data-testid="transfer-rows">
						{shown.map((row) => {
							const path = joinPath(row.dir, row.name);
							const rowPct =
								row.size > 0 ? Math.min(100, Math.round((100 * row.sent) / row.size)) : row.state === "done" ? 100 : 0;
							const label = {
								waiting: t("files.transferStateWaiting"),
								sending: t("files.transferStateSending"),
								held: t("files.transferStateHeld"),
								done: t("files.transferStateDone"),
								failed: t("files.transferStateFailed"),
								skipped: t("files.transferStateSkipped"),
								cancelled: t("files.transferStateCancelled"),
							}[row.state];
							const said =
								(row.state === "failed" || row.state === "skipped") && row.error
									? describeFailure(row.error, row.name)
									: row.state === "done" && row.saved && row.saved.name !== row.name
										? t("files.transferSavedAs", { name: row.saved.name })
										: null;
							return (
								<li
									key={row.key}
									className="rounded-lg border border-border px-2 py-1.5"
									data-testid="transfer-row"
									data-state={row.state}
									data-name={row.name}
								>
									<div className="flex items-center gap-2">
										<span className="min-w-0 flex-1 truncate text-xs" title={path}>
											{path}
										</span>
										<span
											className={`shrink-0 text-xs ${row.state === "failed" ? "text-danger" : "text-muted"}`}
											data-testid="transfer-row-state"
										>
											{label}
										</span>
										{row.state === "waiting" || row.state === "sending" ? (
											<IconButton
												label={t("files.transferCancelOne", { name: row.name })}
												size="sm"
												data-testid="transfer-row-cancel"
												onClick={() => cancelUpload(scope, row.key)}
											>
												<X size={12} />
											</IconButton>
										) : null}
									</div>
									{row.state === "waiting" || row.state === "sending" ? (
										<div
											role="progressbar"
											aria-label={`${t("files.transferStateSending")}: ${path}`}
											aria-valuemin={0}
											aria-valuemax={100}
											aria-valuenow={rowPct}
											className="mt-1 h-1 overflow-hidden rounded-full bg-hover"
											data-testid="transfer-row-bar"
										>
											<div className="h-full rounded-full bg-accent" style={{ width: `${rowPct}%` }} />
										</div>
									) : null}
									{said ? (
										<p
											className={`mt-0.5 break-words text-xs ${row.state === "failed" ? "text-danger" : "text-muted"}`}
											data-testid="transfer-row-note"
										>
											{said}
										</p>
									) : null}
								</li>
							);
						})}
					</ul>
					{rows.length > shown.length ? (
						<p className="mt-1.5 text-xs text-muted">{t("files.transferMore", { n: rows.length - shown.length })}</p>
					) : null}
				</section>
			) : null}
		</div>
	);
}

/**
 * The question asked once an upload is done and some of its files found one by the same name: keep both, replace, or leave
 * the new ones out, for all of them. Shown wherever the Files tab is (the panel may be shut), and closing it is leaving them out.
 */
export function TransferConflict({ scope }: { scope: FolderScope }) {
	const t = useT();
	const upload = useUpload(keyOf(scope));
	const open = upload.held.length > 0 && !isBusy(upload.rows);
	const replaceable = upload.held.filter((c) => c.failure.existing.replaceable).length;
	const names = upload.rows.filter((r) => r.state === "held");
	return (
		<Modal
			open={open}
			onOpenChange={(o) => {
				if (!o) resolveHeld(scope, "skip");
			}}
			title={t("files.transferConflictTitle")}
			description={t("files.transferConflictBody", { n: upload.held.length })}
		>
			<div data-testid="transfer-conflict">
				<ul className="max-h-40 overflow-y-auto rounded-lg border border-border px-2 py-1 text-xs">
					{names.slice(0, 20).map((r) => (
						<li key={r.key} className="truncate py-0.5" title={joinPath(r.dir, r.name)}>
							{joinPath(r.dir, r.name)}
						</li>
					))}
				</ul>
				{names.length > 20 ? (
					<p className="mt-1 text-xs text-muted">{t("files.transferMore", { n: names.length - 20 })}</p>
				) : null}
				{replaceable > 0 && replaceable < upload.held.length ? (
					<p className="mt-2 text-xs text-muted">{t("files.transferConflictReplaceSome", { n: replaceable })}</p>
				) : null}
				{replaceable === 0 ? <p className="mt-2 text-xs text-muted">{t("files.transferConflictReplaceNone")}</p> : null}
				<div className="mt-3 flex flex-wrap justify-end gap-2">
					<Button variant="ghost" data-testid="transfer-skip" onClick={() => resolveHeld(scope, "skip")}>
						{t("files.transferSkip")}
					</Button>
					{replaceable > 0 ? (
						<Button data-testid="transfer-replace" onClick={() => resolveHeld(scope, "replace")}>
							{t("files.transferReplace")}
						</Button>
					) : null}
					<Button variant="primary" data-testid="transfer-keep" onClick={() => resolveHeld(scope, "keep")}>
						{t("files.transferKeepBoth")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}

export { dropUpload } from "../../lib/transfer-store.ts";
