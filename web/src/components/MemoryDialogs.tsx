import { looksLikeSecret, MEMORY_CONTENT_MAX, type MemoryDetail, type MemoryOverview } from "@shared/memory.ts";
import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { useT } from "../i18n/index.ts";
import { memoryApi, memoryErrorText } from "../lib/memory-api.ts";
import { addableProjects, importanceOf, projectNames } from "../lib/memory-view.ts";
import { useApp } from "../store/app.ts";
import { Button, Modal, Select, Spinner, WithCode } from "./ui.tsx";

/** How much of a memory the delete dialog repeats: enough to know which one it is. */
const PREVIEW = 280;

function DeleteForm({
	item,
	busy,
	error,
	onCancel,
	onConfirm,
}: {
	item: MemoryDetail;
	busy: boolean;
	error: string | null;
	onCancel: () => void;
	onConfirm: (alsoRetire: boolean) => void;
}) {
	const t = useT();
	// Not retired unless asked: a consolidated memory sums up several, and the rest of them are not being deleted.
	const [alsoRetire, setAlsoRetire] = useState(false);
	const copies = item.consolidatedInto.length;
	return (
		<div className="space-y-3" data-testid="memory-delete-dialog">
			<blockquote className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-bg-soft p-3 text-sm text-muted">
				{item.content.length > PREVIEW ? `${item.content.slice(0, PREVIEW)}…` : item.content}
			</blockquote>
			{copies > 0 ? (
				<div className="space-y-2 text-sm">
					<p>{t("memory.deleteConsolidated")}</p>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={alsoRetire}
							onChange={(e) => setAlsoRetire(e.target.checked)}
							className="size-4 accent-accent"
							data-testid="memory-delete-also-retire"
						/>
						{t("memory.deleteAlsoRetire")}
					</label>
				</div>
			) : null}
			{error ? (
				<div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
					{error}
				</div>
			) : null}
			<div className="flex justify-end gap-2 pt-1">
				{/* Cancel holds focus when it opens: Enter on a dialog that deletes must not be a delete. */}
				<Button autoFocus disabled={busy} onClick={onCancel} data-testid="memory-delete-cancel">
					{t("memory.cancel")}
				</Button>
				<Button
					variant="danger"
					disabled={busy}
					onClick={() => onConfirm(alsoRetire)}
					data-testid="memory-delete-confirm"
				>
					{busy ? <Spinner size={13} /> : null}
					{busy ? t("memory.deleting") : t("memory.deleteConfirm")}
				</Button>
			</div>
		</div>
	);
}

/** Deleting a memory is asked first: what it is, what it takes with it, and where the copy that is made first is kept. */
export function DeleteMemory({
	open,
	onOpenChange,
	item,
	busy,
	error,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	item: MemoryDetail;
	busy: boolean;
	error: string | null;
	onConfirm: (alsoRetire: boolean) => void;
}) {
	const t = useT();
	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			title={t("memory.deleteTitle")}
			description={<WithCode text={t("memory.deleteBody")} />}
		>
			<DeleteForm item={item} busy={busy} error={error} onCancel={() => onOpenChange(false)} onConfirm={onConfirm} />
		</Modal>
	);
}

type Where = "global" | "project";

function AddForm({
	overview,
	onCancel,
	onAdded,
}: {
	overview: MemoryOverview;
	onCancel: () => void;
	onAdded: (item: MemoryDetail) => void;
}) {
	const t = useT();
	const home = useApp((s) => s.meta?.home);
	const projects = addableProjects(overview);
	const names = projectNames(projects, home);
	const [where, setWhere] = useState<Where>(overview.canAddGlobal || projects.length === 0 ? "global" : "project");
	const [bank, setBank] = useState(projects[0]?.bank ?? "");
	const [content, setContent] = useState("");
	const [importance, setImportance] = useState("0.75");
	const [context, setContext] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [ackSecret, setAckSecret] = useState(false);

	const importanceNow = importanceOf(importance);
	const target = where === "global" ? overview.canAddGlobal : bank !== "" && projects.some((p) => p.bank === bank);
	const tooLong = content.length > MEMORY_CONTENT_MAX;
	const ready = target && content.trim() !== "" && !tooLong && importanceNow !== undefined && !busy;
	const secret = looksLikeSecret(content) || looksLikeSecret(context);

	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			const done = await memoryApi.add({
				scope: where,
				...(where === "project" ? { bank } : {}),
				content,
				...(typeof importanceNow === "number" ? { importance: importanceNow } : {}),
				...(context.trim() ? { context: context.trim() } : {}),
				...(secret ? { acknowledgeSecret: true } : {}),
			});
			useApp.getState().toast("success", t("memory.added"));
			onAdded(done.item);
		} catch (e) {
			setError(t("memory.addFailed", { error: memoryErrorText(e) }));
			setBusy(false);
		}
	};

	return (
		<form
			className="space-y-4"
			data-testid="memory-add-dialog"
			onSubmit={(e) => {
				e.preventDefault();
				if (ready && (!secret || ackSecret)) void submit();
			}}
		>
			<p className="text-sm text-muted">{t("memory.addIntro")}</p>
			<fieldset className="space-y-2">
				<legend className="mb-1 text-sm font-medium">{t("memory.addWhere")}</legend>
				<label className="flex items-start gap-2 text-sm">
					<input
						type="radio"
						name="memory-where"
						checked={where === "global"}
						disabled={!overview.canAddGlobal}
						onChange={() => setWhere("global")}
						className="mt-1 accent-accent disabled:opacity-60"
						data-testid="memory-add-global"
					/>
					<span>
						{t("memory.addGlobal")}
						<span className="block text-xs text-muted">
							{overview.canAddGlobal ? t("memory.addGlobalHint") : t("memory.addGlobalNo")}
						</span>
					</span>
				</label>
				<label className="flex items-start gap-2 text-sm">
					<input
						type="radio"
						name="memory-where"
						checked={where === "project"}
						disabled={projects.length === 0}
						onChange={() => setWhere("project")}
						className="mt-1 accent-accent disabled:opacity-60"
						data-testid="memory-add-project"
					/>
					<span>
						{t("memory.addProject")}
						<span className="block text-xs text-muted">
							{projects.length === 0 ? t("memory.addProjectNone") : t("memory.addProjectHint")}
						</span>
					</span>
				</label>
				{where === "project" && projects.length > 0 ? (
					<label className="ml-6 block space-y-1">
						<span className="text-xs text-muted">{t("memory.addProjectLabel")}</span>
						<Select value={bank} onChange={(e) => setBank(e.target.value)} data-testid="memory-add-bank">
							{projects.map((p) => (
								<option key={p.bank} value={p.bank}>
									{names.get(p.bank)}
								</option>
							))}
						</Select>
					</label>
				) : null}
			</fieldset>
			<label className="block space-y-1.5">
				<span className="text-sm font-medium">{t("memory.addText")}</span>
				<textarea
					value={content}
					onChange={(e) => setContent(e.target.value)}
					rows={6}
					placeholder={t("memory.addTextPlaceholder")}
					className="block w-full resize-y rounded-xl border border-border bg-bg-soft p-3 text-sm outline-none focus:border-faint"
					data-testid="memory-add-text"
				/>
			</label>
			<div className={tooLong ? "text-xs text-danger" : "text-xs text-faint"}>
				{t("memory.characters", { n: content.length.toLocaleString(), max: MEMORY_CONTENT_MAX.toLocaleString() })}
			</div>
			{secret ? (
				<div role="status" className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
					<div className="flex items-start gap-2">
						<CircleAlert size={15} className="mt-0.5 shrink-0 text-warning" /> {t("memory.secretWarning")}
					</div>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={ackSecret}
							onChange={(e) => setAckSecret(e.target.checked)}
							className="size-4 accent-accent"
							data-testid="memory-add-secret-ack"
						/>
						{t("memory.secretAck")}
					</label>
				</div>
			) : null}
			<div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
				<label className="block space-y-1.5">
					<span className="text-sm font-medium">{t("memory.addImportance")}</span>
					<input
						type="number"
						min={0}
						max={1}
						step={0.05}
						inputMode="decimal"
						value={importance}
						onChange={(e) => setImportance(e.target.value)}
						aria-invalid={importanceNow === undefined || undefined}
						className="block h-9 w-full rounded-xl border border-border bg-bg-soft px-3 text-sm outline-none focus:border-faint"
						data-testid="memory-add-importance"
					/>
				</label>
				<label className="block space-y-1.5">
					<span className="text-sm font-medium">{t("memory.addContext")}</span>
					<input
						type="text"
						value={context}
						maxLength={400}
						onChange={(e) => setContext(e.target.value)}
						placeholder={t("memory.addContextPlaceholder")}
						className="block h-9 w-full rounded-xl border border-border bg-bg-soft px-3 text-sm outline-none focus:border-faint"
						data-testid="memory-add-context"
					/>
				</label>
			</div>
			{importanceNow === undefined ? <div className="text-xs text-danger">{t("memory.importanceInvalid")}</div> : null}
			{error ? (
				<div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
					{error}
				</div>
			) : null}
			<div className="flex justify-end gap-2">
				<Button disabled={busy} onClick={onCancel}>
					{t("memory.cancel")}
				</Button>
				<Button
					type="submit"
					variant="primary"
					disabled={!ready || (secret && !ackSecret)}
					data-testid="memory-add-submit"
				>
					{busy ? <Spinner size={13} /> : null}
					{busy ? t("memory.adding") : t("memory.addSubmit")}
				</Button>
			</div>
		</form>
	);
}

/** Add a memory, as if the agent had saved it: to the ones every project recalls, or to one project's. */
export function AddMemory({
	open,
	onOpenChange,
	overview,
	onAdded,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	overview: MemoryOverview;
	onAdded: (item: MemoryDetail) => void;
}) {
	const t = useT();
	return (
		<Modal open={open} onOpenChange={onOpenChange} title={t("memory.addTitle")}>
			<AddForm overview={overview} onCancel={() => onOpenChange(false)} onAdded={onAdded} />
		</Modal>
	);
}
