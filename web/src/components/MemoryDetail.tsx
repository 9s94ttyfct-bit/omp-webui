import { type MemoryDetail as Detail, MEMORY_CONTENT_MAX, type MemoryBank } from "@shared/memory.ts";
import { Archive, ArchiveRestore, ArrowLeft, CircleAlert, Copy, Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { fmtRelative, fmtTime, shortPath } from "../lib/format.ts";
import { isGone, isStale, memoryApi, memoryErrorText } from "../lib/memory-api.ts";
import {
	changeOf,
	type Draft,
	dirty,
	draftOf,
	importanceValid,
	KIND_LABEL,
	movedOn,
	ORIGIN_LABEL,
	rebase,
	saveable,
	secretTyped,
} from "../lib/memory-view.ts";
import { useApp } from "../store/app.ts";
import { DeleteMemory } from "./MemoryDialogs.tsx";
import { Badge, Button, Spinner } from "./ui.tsx";

const toast = (level: "success" | "warning" | "error", text: string) => useApp.getState().toast(level, text);

type Loaded = { kind: "loading" } | { kind: "error"; error: string } | { kind: "ok"; item: Detail };

/** A row of the facts about a memory: what it is called, then what it says. */
function Field({ label, children, id }: { label: string; children: ReactNode; id: string }) {
	return (
		<>
			<dt className="text-muted">{label}</dt>
			<dd className="min-w-0 break-words" data-field={id}>
				{children}
			</dd>
		</>
	);
}

/**
 * One memory in full: its text, where it came from and what omp keeps of it, and what can be done with it (rewrite,
 * retire or bring back, delete). The text being edited is the page's (`draft`), so that opening another memory does not
 * lose it. A change carries the `etag` of what was read, so one that omp or another page made meanwhile is not overwritten:
 * the server refuses, the memory is read again, and the person looks at it before saving a second time.
 */
export function MemoryDetail({
	bank,
	id,
	info,
	draft,
	onDraft,
	onChanged,
	onDeleted,
	onGone,
	onOpen,
	onBack,
	narrow,
}: {
	bank: string;
	id: string;
	/** What the overview says of the memory's bank (its project, and whether this page writes to it). */
	info: MemoryBank | undefined;
	draft: Draft | undefined;
	onDraft: (draft: Draft | null) => void;
	/** The memory is as it is now (saved, retired, brought back): the list is read again. */
	onChanged: (item: Detail) => void;
	onDeleted: () => void;
	/** The memory is not in the store any more. */
	onGone: () => void;
	onOpen: (bank: string, id: string) => void;
	onBack: () => void;
	/** The list is not beside this but behind it (a narrow window): there is a way back to it, and focus comes along. */
	narrow: boolean;
}) {
	const t = useT();
	const sessions = useApp((s) => s.sessions);
	const home = useApp((s) => s.meta?.home);
	const setView = useApp((s) => s.setView);
	const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
	const [busy, setBusy] = useState<"save" | "retire" | "restore" | "delete" | null>(null);
	const [error, setError] = useState<string | null>(null);
	/** The person said that a text that looks like a key or token is meant (it is asked for again by the next edit). */
	const [ackSecret, setAckSecret] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);

	const item = loaded.kind === "ok" ? loaded.item : null;

	useEffect(() => {
		let live = true;
		memoryApi.item(bank, id).then(
			(fresh) => live && setLoaded({ kind: "ok", item: fresh }),
			(e) => {
				if (!live) return;
				if (isGone(e)) {
					toast("error", memoryErrorText(e));
					onGone();
				} else setLoaded({ kind: "error", error: memoryErrorText(e) });
			},
		);
		return () => {
			live = false;
		};
	}, [bank, id, onGone]);

	const opened = item !== null;
	useEffect(() => {
		if (opened && narrow) headingRef.current?.focus();
	}, [opened, narrow]);

	/** Read the memory again, as it is stored now. Null when it could not be (it is gone, or the read failed: said). */
	const reload = async (): Promise<Detail | null> => {
		try {
			const fresh = await memoryApi.item(bank, id);
			setLoaded({ kind: "ok", item: fresh });
			return fresh;
		} catch (e) {
			if (isGone(e)) {
				toast("error", memoryErrorText(e));
				onGone();
			} else setError(memoryErrorText(e));
			return null;
		}
	};

	const save = async () => {
		if (!item || !draft) return;
		setBusy("save");
		setError(null);
		try {
			// The etag the edit began from, not the one just read: a memory that moved on meanwhile is refused, never overwritten.
			const done = await memoryApi.update({
				bank,
				id,
				etag: draft.base.etag,
				...changeOf(draft),
				...(secretTyped(draft) ? { acknowledgeSecret: true } : {}),
			});
			setLoaded({ kind: "ok", item: done.item });
			setAckSecret(false);
			onDraft(null);
			onChanged(done.item);
			toast("success", t("memory.saved"));
		} catch (e) {
			if (isStale(e)) {
				// Read again: the edit now differs from the memory's etag, which is what shows the choice (keep mine / use current).
				await reload();
			} else if (isGone(e)) {
				toast("error", memoryErrorText(e));
				onGone();
			} else setError(t("memory.saveFailed", { error: memoryErrorText(e) }));
		} finally {
			setBusy(null);
		}
	};

	const retire = async (retiring: boolean) => {
		if (!item) return;
		setBusy(retiring ? "retire" : "restore");
		setError(null);
		try {
			const call = retiring ? memoryApi.retire : memoryApi.restore;
			const done = await call({ bank, id, etag: item.etag });
			setLoaded({ kind: "ok", item: done.item });
			onChanged(done.item);
			toast("success", t(retiring ? "memory.retired" : "memory.restored"));
		} catch (e) {
			setError(t(retiring ? "memory.retireFailed" : "memory.restoreFailed", { error: memoryErrorText(e) }));
			// The memory changed meanwhile: what is shown is read again, so that the next try is made on what is there.
			if (isStale(e)) await reload();
		} finally {
			setBusy(null);
		}
	};

	const remove = async (alsoRetire: boolean) => {
		if (!item) return;
		setBusy("delete");
		setDeleteError(null);
		try {
			await memoryApi.remove({ bank, id, etag: item.etag, retireConsolidated: alsoRetire });
		} catch (e) {
			setBusy(null);
			if (isStale(e)) {
				// What is there now has to be looked at before it is deleted: the dialog goes, the memory is read again.
				setDeleteOpen(false);
				setError(t("memory.deleteFailed", { error: memoryErrorText(e) }));
				await reload();
			} else if (isGone(e)) {
				toast("error", memoryErrorText(e));
				onGone();
			} else setDeleteError(t("memory.deleteFailed", { error: memoryErrorText(e) }));
			return;
		}
		setBusy(null);
		setDeleteOpen(false);
		onDraft(null);
		onDeleted();
		toast("success", t("memory.deleted"));
	};

	if (loaded.kind === "loading") {
		return (
			<div className="flex justify-center py-16" data-testid="memory-detail-loading">
				<Spinner />
			</div>
		);
	}
	if (loaded.kind === "error") {
		return (
			<div className="space-y-3 p-6" data-testid="memory-detail">
				{narrow ? (
					<Button size="sm" variant="ghost" onClick={onBack}>
						<ArrowLeft size={13} /> {t("memory.back")}
					</Button>
				) : null}
				<div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
					{t("memory.loadFailed", { error: loaded.error })}
				</div>
			</div>
		);
	}

	const shown = loaded.item;
	const edit = shown.editable ? draft : undefined;
	const session = shown.provenance.sessionId ? sessions.find((s) => s.id === shown.provenance.sessionId) : undefined;
	const where =
		info?.scope === "project" ? t("memory.fieldWhereProject", { label: info.label }) : t("memory.fieldWhereGlobal");
	const cwd = shown.provenance.cwd;
	const origin = ORIGIN_LABEL[shown.provenance.origin];
	const secret = edit !== undefined && secretTyped(edit);
	const tooLong = edit !== undefined && edit.content.length > MEMORY_CONTENT_MAX;
	const importanceBad = edit !== undefined && !importanceValid(edit);
	/** The memory moved on since the edit began (omp or another page changed it): saving is not offered until a choice is made. */
	const conflict = edit !== undefined && movedOn(edit, shown);
	const copyId = () => {
		navigator.clipboard.writeText(shown.id).then(
			() => toast("success", t("memory.copied")),
			() => {},
		);
	};

	return (
		<article
			aria-label={t("memory.detailLabel")}
			className="space-y-4 p-4 md:p-6"
			data-testid="memory-detail"
			data-id={shown.id}
		>
			<div className="flex flex-wrap items-center gap-2">
				{narrow ? (
					<Button size="sm" variant="ghost" onClick={onBack} data-testid="memory-back">
						<ArrowLeft size={13} /> {t("memory.back")}
					</Button>
				) : null}
				<h2 ref={headingRef} tabIndex={-1} className="text-title font-semibold outline-none">
					{t(KIND_LABEL[shown.kind].one)}
				</h2>
				{info?.scope === "project" ? <Badge>{info.label}</Badge> : <Badge>{t("memory.globalBadge")}</Badge>}
				{shown.retired ? <Badge tone="warning">{t("memory.retiredBadge")}</Badge> : null}
				<span className="flex-1" />
				{edit ? (
					<>
						<Button
							size="sm"
							variant="primary"
							disabled={busy !== null || conflict || (secret && !ackSecret) || !saveable(edit)}
							onClick={() => void save()}
							data-testid="memory-save"
						>
							{busy === "save" ? <Spinner size={13} /> : null}
							{busy === "save" ? t("memory.saving") : t("memory.save")}
						</Button>
						<Button
							size="sm"
							disabled={busy !== null}
							onClick={() => {
								setError(null);
								onDraft(null);
							}}
							data-testid="memory-cancel"
						>
							{dirty(edit) ? t("memory.discard") : t("memory.cancel")}
						</Button>
					</>
				) : (
					<>
						{shown.editable ? (
							<Button
								size="sm"
								disabled={busy !== null}
								onClick={() => onDraft(draftOf(shown))}
								data-testid="memory-edit"
							>
								<Pencil size={13} /> {t("memory.edit")}
							</Button>
						) : null}
						{shown.retirable ? (
							<Button
								size="sm"
								disabled={busy !== null}
								onClick={() => void retire(!shown.retired)}
								title={shown.retired ? undefined : t("memory.retireHint")}
								data-testid={shown.retired ? "memory-restore" : "memory-retire"}
							>
								{busy === "retire" || busy === "restore" ? (
									<Spinner size={13} />
								) : shown.retired ? (
									<ArchiveRestore size={13} />
								) : (
									<Archive size={13} />
								)}
								{shown.retired ? t("memory.restore") : t("memory.retire")}
							</Button>
						) : null}
						{shown.editable ? (
							<Button
								size="sm"
								className="text-danger"
								disabled={busy !== null}
								onClick={() => {
									setDeleteError(null);
									setDeleteOpen(true);
								}}
								data-testid="memory-delete"
							>
								<Trash2 size={13} /> {t("memory.delete")}
							</Button>
						) : null}
					</>
				)}
			</div>

			{shown.retired ? (
				<p
					className="rounded-lg border border-border bg-bg-soft p-3 text-sm text-muted"
					data-testid="memory-retired-note"
				>
					{t("memory.retiredNote")}
				</p>
			) : null}
			{!shown.editable ? (
				<p
					className="rounded-lg border border-border bg-bg-soft p-3 text-sm text-muted"
					data-testid="memory-readonly-note"
				>
					{shown.store === "episodic"
						? t("memory.notEditableConsolidated")
						: t("memory.notEditableLayout", { why: info?.writeProblem ?? t("memory.sourceUnknown") })}
				</p>
			) : null}
			{error ? (
				<div
					role="alert"
					className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
					data-testid="memory-error"
				>
					<CircleAlert size={15} className="mt-0.5 shrink-0" /> {error}
				</div>
			) : null}

			{edit ? (
				<div className="space-y-3" data-testid="memory-editor">
					{conflict ? (
						<div
							className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
							data-testid="memory-conflict"
						>
							<p>{t("memory.changedMeanwhile")}</p>
							<div className="text-xs text-muted">{t("memory.currentText")}</div>
							<div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-bg-soft p-2 text-sm">
								{shown.content}
							</div>
							<div className="flex flex-wrap gap-2 pt-1">
								<Button size="sm" onClick={() => onDraft(rebase(edit, shown))} data-testid="memory-keep-mine">
									{t("memory.keepMine")}
								</Button>
								<Button
									size="sm"
									onClick={() => {
										setError(null);
										onDraft(null);
									}}
									data-testid="memory-use-current"
								>
									{t("memory.useCurrent")}
								</Button>
							</div>
						</div>
					) : null}
					<label className="block space-y-1.5">
						<span className="text-sm font-medium">{t("memory.textLabel")}</span>
						<textarea
							value={edit.content}
							onChange={(e) => {
								// The tick was for a text that has just changed: it is asked for again.
								setAckSecret(false);
								onDraft({ ...edit, content: e.target.value });
							}}
							rows={10}
							className="block min-h-40 w-full resize-y rounded-xl border border-border bg-bg-soft p-3 text-sm outline-none focus:border-faint"
							data-testid="memory-text-input"
						/>
					</label>
					<div className={tooLong ? "text-xs text-danger" : "text-xs text-faint"} data-testid="memory-count">
						{t("memory.characters", {
							n: edit.content.length.toLocaleString(),
							max: MEMORY_CONTENT_MAX.toLocaleString(),
						})}
					</div>
					{secret ? (
						<div
							role="status"
							className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
							data-testid="memory-secret-warning"
						>
							<div className="flex items-start gap-2">
								<CircleAlert size={15} className="mt-0.5 shrink-0 text-warning" /> {t("memory.secretWarning")}
							</div>
							<label className="flex items-center gap-2">
								<input
									type="checkbox"
									checked={ackSecret}
									onChange={(e) => setAckSecret(e.target.checked)}
									className="size-4 accent-accent"
									data-testid="memory-secret-ack"
								/>
								{t("memory.secretAck")}
							</label>
						</div>
					) : null}
					<label className="block max-w-48 space-y-1.5">
						<span className="text-sm font-medium">{t("memory.importanceLabel")}</span>
						<input
							type="number"
							min={0}
							max={1}
							step={0.05}
							inputMode="decimal"
							value={edit.importance}
							onChange={(e) => onDraft({ ...edit, importance: e.target.value })}
							aria-invalid={importanceBad || undefined}
							className="block h-9 w-full rounded-xl border border-border bg-bg-soft px-3 text-sm outline-none focus:border-faint"
							data-testid="memory-importance-input"
						/>
					</label>
					{importanceBad ? <div className="text-xs text-danger">{t("memory.importanceInvalid")}</div> : null}
					{dirty(edit) ? <div className="text-xs text-faint">{t("memory.unsaved")}</div> : null}
				</div>
			) : (
				<div>
					<h3 className="sr-only">{t("memory.text")}</h3>
					<div
						className="whitespace-pre-wrap break-words rounded-xl border border-border bg-bg-soft p-3 text-sm"
						data-testid="memory-text"
					>
						{shown.content}
					</div>
				</div>
			)}

			<dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm @xl:grid-cols-[8rem_minmax(0,1fr)]">
				<Field id="where" label={t("memory.fieldWhere")}>
					{where}
				</Field>
				<Field id="origin" label={t("memory.fieldOrigin")}>
					{t(origin, { source: shown.provenance.source ?? t("memory.sourceUnknown") })}
				</Field>
				{shown.provenance.context ? (
					<Field id="reason" label={t("memory.fieldReason")}>
						{shown.provenance.context}
					</Field>
				) : null}
				{shown.provenance.sessionId ? (
					<Field id="conversation" label={t("memory.fieldConversation")}>
						{session ? (
							<button
								type="button"
								className="max-w-full truncate text-left text-link hover:underline"
								data-testid="memory-open-conversation"
								onClick={() => setView({ kind: "chat", file: session.file, liveId: null })}
							>
								{t("memory.openConversation")}: {session.title || session.preview || session.id}
							</button>
						) : (
							<span className="text-muted">{t("memory.conversationGone", { id: shown.provenance.sessionId })}</span>
						)}
					</Field>
				) : null}
				{cwd ? (
					<Field id="folder" label={t("memory.fieldFolder")}>
						<code className="text-xs" title={cwd}>
							{shortPath(cwd, home)}
						</code>
					</Field>
				) : null}
				{shown.createdAt ? (
					<Field id="created" label={t("memory.fieldCreated")}>
						<span title={fmtTime(shown.createdAt)}>{fmtRelative(shown.createdAt)}</span>
					</Field>
				) : null}
				{shown.importance !== null ? (
					<Field id="importance" label={t("memory.fieldImportance")}>
						{shown.importance}
					</Field>
				) : null}
				{shown.recallCount !== null ? (
					<Field id="recalled" label={t("memory.fieldRecalled")}>
						{shown.recallCount > 0 ? t("memory.recalledTimes", { n: shown.recallCount }) : t("memory.recalledNever")}
						{shown.recallCount > 0 && shown.lastRecalled ? (
							<span className="text-muted" title={fmtTime(shown.lastRecalled)}>
								{" "}
								({fmtRelative(shown.lastRecalled)})
							</span>
						) : null}
					</Field>
				) : null}
				{shown.retired ? (
					<Field id="retired" label={t("memory.fieldRetired")}>
						{shown.validUntil
							? t("memory.retiredSince", { date: fmtTime(shown.validUntil) })
							: t("memory.retiredBadge")}
					</Field>
				) : null}
				{shown.summaryOf.length > 0 ? (
					<Field id="made-from" label={t("memory.fieldMadeFrom")}>
						<ul className="space-y-0.5">
							{shown.summaryOf.map((from) => (
								<li key={from.id}>
									{from.exists ? (
										<button
											type="button"
											className="text-link hover:underline"
											data-testid="memory-open-related"
											onClick={() => onOpen(shown.bank, from.id)}
										>
											{t("memory.openRelated", { id: from.id })}
										</button>
									) : (
										<span className="text-muted">{t("memory.madeFromGone", { id: from.id })}</span>
									)}
								</li>
							))}
						</ul>
					</Field>
				) : null}
				{shown.consolidatedInto.length > 0 ? (
					<Field id="consolidated-into" label={t("memory.fieldConsolidatedInto")}>
						<ul className="space-y-0.5">
							{shown.consolidatedInto.map((into) => (
								<li key={into}>
									<button
										type="button"
										className="text-link hover:underline"
										data-testid="memory-open-related"
										onClick={() => onOpen(shown.bank, into)}
									>
										{t("memory.openRelated", { id: into })}
									</button>
								</li>
							))}
						</ul>
					</Field>
				) : null}
				<Field id="id" label={t("memory.fieldId")}>
					<span className="inline-flex max-w-full items-center gap-1.5">
						<code className="truncate text-xs">{shown.id}</code>
						<button
							type="button"
							aria-label={t("memory.copyId")}
							title={t("memory.copyId")}
							className="shrink-0 rounded-md p-1 text-muted hover:bg-hover hover:text-fg"
							onClick={copyId}
						>
							<Copy size={13} />
						</button>
					</span>
				</Field>
				<Field id="bank" label={t("memory.fieldBank")}>
					<code className="text-xs">{shown.bank}</code>
				</Field>
			</dl>

			<DeleteMemory
				open={deleteOpen}
				onOpenChange={(open) => !busy && setDeleteOpen(open)}
				item={shown}
				busy={busy === "delete"}
				error={deleteError}
				onConfirm={(alsoRetire) => void remove(alsoRetire)}
			/>
		</article>
	);
}
