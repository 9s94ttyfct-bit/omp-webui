import {
	applyChange,
	CONFLICT_LIMITS,
	type ConflictCheckResult,
	type ConflictSource,
	type DiffLine,
	type GuidanceConflict,
} from "@shared/guidance-conflict.ts";
import { AlertTriangle, Check, RotateCcw, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { type Translate, useT } from "../i18n/index.ts";
import { saveFailureText, saveFile } from "../lib/file-save.ts";
import { folder } from "../lib/folder-api.ts";
import { memoryApi } from "../lib/memory-api.ts";
import { Button, cx, IconButton, Spinner } from "./ui.tsx";

/** Where one conflict's proposal stands. */
type Status =
	| { state: "busy" }
	| { state: "applied" }
	| { state: "skipped" }
	| { state: "outdated" }
	| { state: "failed"; error: string };

export interface ConflictScope {
	liveId: string | null;
	file: string | null;
}

/**
 * The review of a guidance conflict check (v0.13.0, `shared/guidance-conflict.ts`), under the Guidance tab's box: each
 * conflict with the two statements, why they clash, and the change the checker proposes as a diff, to apply or skip one by
 * one (or all at once). Applying is the only way anything outside the guidance changes, and each change goes through the
 * route that change always goes through:
 *
 * - the guidance: saved as this conversation's own text (`saveGuidance`, the tab's Save for this conversation), from what
 *   it carries now, so that two changes to it apply one after the other;
 * - a file of the folder: read again and saved with the etag it was read with (`POST /api/folder/file`, the Files tab's
 *   save and its rules), so a file changed since is never overwritten;
 * - a memory: retired (`/api/memory/retire`, the Memory page's Forget), which omp stops recalling and the Memory page can
 *   bring back.
 *
 * A change whose text is no longer in what it changes (edited since the check) is not applied: the person is told to
 * check again. Saving or applying never asks for another check.
 */
export function GuidanceConflicts({
	result,
	scope,
	carried,
	saveGuidance,
	onRetry,
	onClose,
}: {
	/** Null while the check runs. */
	result: ConflictCheckResult | null;
	scope: ConflictScope;
	/** The guidance the conversation carries now. */
	carried: string;
	/** Save `text` as the conversation's own guidance; resolves to what it carries then. */
	saveGuidance: (text: string) => Promise<string>;
	onRetry: () => void;
	onClose: () => void;
}) {
	const t = useT();
	const titleId = useId();
	const [statuses, setStatuses] = useState<Record<number, Status>>({});
	// What the next change to the guidance applies to: what the conversation carries, kept current between two applies.
	const latest = useRef(carried);
	useEffect(() => {
		latest.current = carried;
	}, [carried]);
	// A new answer starts a new review.
	useEffect(() => {
		if (result) setStatuses({});
	}, [result]);
	const set = (i: number, status: Status) => setStatuses((s) => ({ ...s, [i]: status }));

	const conflicts = result?.state === "found" ? result.conflicts : [];
	const sources = result && "sources" in result ? result.sources : [];
	const byId = new Map(sources.map((s) => [s.id, s]));

	const applyOne = async (i: number): Promise<void> => {
		const change = conflicts[i]?.change;
		if (!change) return;
		set(i, { state: "busy" });
		try {
			if (change.target === "guidance") {
				const next = applyChange(latest.current, change.find, change.replace);
				if (next === null) return set(i, { state: "outdated" });
				latest.current = await saveGuidance(next);
			} else if (change.target === "file") {
				const at = { live: scope.liveId, file: scope.file };
				const read = await folder.file(at, change.rel);
				if (read.kind !== "text" || read.truncated) return set(i, { state: "outdated" });
				const next = applyChange(read.text, change.find, change.replace);
				if (next === null) return set(i, { state: "outdated" });
				try {
					await saveFile(at, change.rel, next, read.etag);
				} catch (e) {
					return set(i, { state: "failed", error: saveFailureText(e, change.rel) });
				}
			} else {
				await memoryApi.retire({ bank: change.bank, id: change.memoryId });
			}
			set(i, { state: "applied" });
		} catch (e) {
			set(i, { state: "failed", error: e instanceof Error ? e.message : String(e) });
		}
	};
	const pending = conflicts
		.map((c, i) => (c.change && (statuses[i] === undefined || statuses[i].state === "failed") ? i : -1))
		.filter((i) => i >= 0);
	const applyAll = async () => {
		for (const i of pending) await applyOne(i);
	};
	const busy = Object.values(statuses).some((s) => s.state === "busy");
	const cut = sources.filter((s) => s.truncated && s.kind === "file").map((s) => s.label);

	return (
		<section
			aria-labelledby={titleId}
			// A file's path is one long word: it wraps anywhere rather than widening the side panel.
			className="space-y-2 rounded-xl border border-border bg-bg-soft p-3 text-sm wrap-anywhere"
			data-testid="guidance-conflicts"
			data-state={result?.state ?? "checking"}
		>
			<div className="flex items-start justify-between gap-2">
				<h3 id={titleId} className="flex min-w-0 items-center gap-1.5 font-medium">
					<AlertTriangle size={14} className="shrink-0 text-warning" aria-hidden />
					{t("guidance.conflictTitle")}
				</h3>
				<IconButton label={t("guidance.conflictClose")} data-testid="guidance-conflicts-close" onClick={onClose}>
					<X size={14} />
				</IconButton>
			</div>
			<p role="status" className="text-xs text-muted" data-testid="guidance-conflicts-status">
				{result === null ? (
					<span className="flex items-center gap-2">
						<Spinner size={12} /> {t("guidance.conflictChecking")}
					</span>
				) : (
					statusText(result, t)
				)}
			</p>
			{result?.state === "failed" ? (
				<Button size="sm" data-testid="guidance-conflicts-retry" onClick={onRetry}>
					<RotateCcw size={13} /> {t("guidance.conflictRetry")}
				</Button>
			) : null}
			{conflicts.length > 0 ? (
				<>
					{conflicts.some((c) => c.change?.target === "guidance") ? (
						<p className="text-xs text-faint">{t("guidance.conflictGuidanceNote")}</p>
					) : null}
					<ol className="space-y-2" aria-label={t("guidance.conflictListLabel")}>
						{conflicts.map((c, i) => (
							<ConflictItem
								// The answer's order is its identity: a new answer is a new list.
								// biome-ignore lint/suspicious/noArrayIndexKey: see above
								key={i}
								index={i}
								total={conflicts.length}
								conflict={c}
								source={byId.get(c.source)}
								status={statuses[i]}
								onApply={() => void applyOne(i)}
								onSkip={() => set(i, { state: "skipped" })}
							/>
						))}
					</ol>
				</>
			) : null}
			{result && (result.state === "found" || result.state === "clear") ? (
				<div className="flex flex-wrap items-center justify-between gap-2 pt-1">
					<span className="text-xs text-faint" data-testid="guidance-conflicts-model">
						{t(result.cached ? "guidance.conflictCached" : "guidance.conflictModel", { model: result.model })}
						{cut.length > 0 ? ` ${t("guidance.conflictTruncated", { files: cut.join(", ") })}` : ""}
					</span>
					<div className="flex flex-wrap gap-2">
						<Button size="sm" variant="ghost" data-testid="guidance-conflicts-retry" disabled={busy} onClick={onRetry}>
							<RotateCcw size={13} /> {t("guidance.conflictRetry")}
						</Button>
						{pending.length > 1 ? (
							<Button
								size="sm"
								variant="primary"
								data-testid="guidance-conflicts-apply-all"
								disabled={busy}
								onClick={() => void applyAll()}
							>
								{t("guidance.conflictApplyAll")}
							</Button>
						) : null}
					</div>
				</div>
			) : null}
		</section>
	);
}

/** What the check found, in a line. */
function statusText(result: ConflictCheckResult, t: Translate): string {
	switch (result.state) {
		case "found":
			return t("guidance.conflictFound", { n: result.conflicts.length });
		case "clear":
			return t("guidance.conflictClear", { n: result.sources.length });
		case "nothing":
			return t("guidance.conflictNothing");
		case "failed": {
			const reason =
				result.reason === "noModel"
					? t("guidance.conflictReasonNoModel")
					: result.reason === "timeout"
						? t("guidance.conflictReasonTimeout", { s: Math.round(CONFLICT_LIMITS.checkMs / 1000) })
						: result.reason === "malformed"
							? t("guidance.conflictReasonMalformed")
							: result.reason === "folder"
								? t("guidance.conflictReasonFolder")
								: t("guidance.conflictReasonModel", { detail: result.detail ?? "" });
			return t("guidance.conflictFailed", { reason });
		}
		case "off":
			return t("guidance.conflictCheckOff");
		case "empty":
			return t("guidance.conflictNothing");
	}
}

function ConflictItem({
	index,
	total,
	conflict,
	source,
	status,
	onApply,
	onSkip,
}: {
	index: number;
	total: number;
	conflict: GuidanceConflict;
	source: ConflictSource | undefined;
	status: Status | undefined;
	onApply: () => void;
	onSkip: () => void;
}) {
	const t = useT();
	const n = index + 1;
	const change = conflict.change;
	const sourceName = source?.kind === "memory" ? t("guidance.conflictMemory") : (source?.label ?? conflict.source);
	const heading =
		change?.target === "guidance"
			? t("guidance.conflictChangeGuidance")
			: change?.target === "file"
				? t("guidance.conflictChangeFile", { file: source?.label ?? change.rel })
				: change?.target === "memory"
					? t("guidance.conflictChangeMemory")
					: t("guidance.conflictNoChange");
	const done = status?.state === "applied" || status?.state === "skipped";
	return (
		<li
			className={cx("space-y-1.5 rounded-lg border border-border bg-surface p-2.5", done && "opacity-70")}
			aria-label={t("guidance.conflictItem", { i: n, n: total })}
			data-testid="guidance-conflict"
			data-status={status?.state ?? "pending"}
		>
			<Quote who={t("guidance.conflictGuidance")} text={conflict.guidance} />
			<Quote who={sourceName} text={conflict.other} />
			{conflict.why ? <p className="text-xs text-muted">{conflict.why}</p> : null}
			<p className="text-xs font-medium">{heading}</p>
			{change && change.target !== "memory" ? <Diff lines={change.diff} /> : null}
			{change ? (
				<div className="flex flex-wrap items-center gap-2" data-testid="guidance-conflict-actions">
					{status?.state === "applied" ? (
						<span className="flex items-center gap-1 text-xs text-success" data-testid="guidance-conflict-applied">
							<Check size={13} aria-hidden /> {t("guidance.conflictApplied")}
						</span>
					) : status?.state === "skipped" ? (
						<span className="text-xs text-muted">{t("guidance.conflictSkipped")}</span>
					) : status?.state === "outdated" ? (
						<span className="text-xs text-warning" data-testid="guidance-conflict-outdated">
							{t("guidance.conflictOutdated")}
						</span>
					) : (
						<>
							<Button
								size="sm"
								variant="primary"
								data-testid="guidance-conflict-apply"
								aria-label={t("guidance.conflictApplyLabel", { i: n })}
								disabled={status?.state === "busy"}
								onClick={onApply}
							>
								{status?.state === "busy" ? <Spinner size={12} /> : null} {t("guidance.conflictApply")}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								data-testid="guidance-conflict-skip"
								aria-label={t("guidance.conflictSkipLabel", { i: n })}
								disabled={status?.state === "busy"}
								onClick={onSkip}
							>
								{t("guidance.conflictSkip")}
							</Button>
						</>
					)}
					{status?.state === "failed" ? (
						<span className="w-full text-xs text-danger" data-testid="guidance-conflict-error">
							{t("guidance.conflictApplyFailed", { error: status.error })}
						</span>
					) : null}
				</div>
			) : null}
		</li>
	);
}

function Quote({ who, text }: { who: string; text: string }) {
	return (
		<blockquote className="border-l-2 border-border pl-2 text-xs">
			<span className="block text-faint">{who}</span>
			<span className="whitespace-pre-wrap break-words">“{text}”</span>
		</blockquote>
	);
}

/** A proposal as lines removed (−) and added (+), with the unchanged ones around them and the rest folded. */
function Diff({ lines }: { lines: DiffLine[] }) {
	const t = useT();
	return (
		<pre
			className="max-h-60 overflow-auto rounded-md border border-border bg-bg py-1 font-mono text-xs"
			data-testid="guidance-conflict-diff"
		>
			{lines.map((line, i) =>
				line.kind === "gap" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: the lines of one diff, which never change
					<div key={i} className="px-2 text-faint">
						⋯ {t("guidance.diffFolded", { n: line.lines })}
					</div>
				) : (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: the lines of one diff, which never change
						key={i}
						className={cx(
							"whitespace-pre-wrap break-words px-2",
							line.kind === "del" && "bg-danger/10",
							line.kind === "add" && "bg-success/10",
						)}
					>
						<span
							className={cx(line.kind === "del" ? "text-danger" : line.kind === "add" ? "text-success" : "text-faint")}
						>
							<span aria-hidden>{line.kind === "del" ? "− " : line.kind === "add" ? "+ " : "  "}</span>
							{line.kind === "same" ? null : (
								<span className="sr-only">
									{t(line.kind === "del" ? "guidance.diffRemoved" : "guidance.diffAdded")}
								</span>
							)}
						</span>
						{line.text}
					</div>
				),
			)}
		</pre>
	);
}
