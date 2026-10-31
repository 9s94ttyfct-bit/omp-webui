import {
	GUIDANCE_MAX,
	GUIDANCE_NAME_MAX,
	GUIDANCE_TEMPLATES_MAX,
	type GuidanceNameProblem,
	type GuidanceTemplate,
	guidanceNameProblem,
	guidanceText,
	type LiveGuidance,
	newGuidanceId,
} from "@shared/model-guidance.ts";
import { Check, Pencil, Sparkles, X } from "lucide-react";
import { type ComponentProps, useEffect, useId, useRef, useState } from "react";
import { type Translate, useT } from "../i18n/index.ts";
import { GuidanceApiError, guidanceApi } from "../lib/guidance-api.ts";
import { templateName } from "../lib/guidance-names.ts";
import { useGuidanceStrings } from "../lib/guidance-strings.ts";
import { useApp } from "../store/app.ts";
import { Button, cx, IconButton, Modal, Select, Spinner } from "./ui.tsx";

/** Why a template's name is refused, in the page's language. */
function nameProblemText(problem: GuidanceNameProblem, t: Translate): string {
	if (problem === "nameEmpty") return t("guidance.nameEmpty");
	if (problem === "nameTooLong") return t("guidance.nameTooLong", { max: GUIDANCE_NAME_MAX });
	return t("guidance.nameRepeated");
}

/** A change the server refused, in the page's language where it says why (a template deleted or renamed meanwhile). */
function refusalText(e: unknown, t: Translate): string {
	if (e instanceof GuidanceApiError) {
		if (e.problem === "gone") return t("guidance.templateGone");
		if (e.problem === "nameEmpty" || e.problem === "nameTooLong" || e.problem === "nameRepeated")
			return nameProblemText(e.problem, t);
	}
	return (e as Error).message;
}

/**
 * A button that says why it cannot be used now (`reason`) instead of being greyed out without a word: it stays focusable
 * and its tooltip (`title`, which is also its accessible description) is the reason, so a keyboard or screen reader finds
 * it as a mouse does. Usable, its tooltip is `hint`.
 */
function ReasonButton({
	reason,
	hint,
	onRun,
	className,
	...rest
}: { reason: string | null; hint: string; onRun: () => void } & Omit<
	ComponentProps<typeof Button>,
	"onClick" | "title" | "disabled"
>) {
	return (
		<Button
			{...rest}
			title={reason ?? hint}
			aria-disabled={reason ? true : undefined}
			className={cx(reason && "cursor-not-allowed opacity-50", className)}
			onClick={() => {
				if (!reason) onRun();
			}}
		/>
	);
}

/**
 * A conversation's *Guidance* tab (#715): what it carries of the model guidance (#641), edited where it is shown. The menu
 * picks a template, none, or text of the conversation's own; the box holds the text it carries now and is edited in place.
 *
 * Three ways of saving, always shown (v0.12.2), so that none changes more than it says:
 * - **Save for this conversation**: the text is this conversation's alone. Text that came from a template becomes its own
 *   (no template is changed).
 * - **Save to template**: the text goes into the template the conversation uses, and the conversation keeps using it. When
 *   other conversations use it too the person is asked first, told how far the change reaches: every conversation that
 *   uses it carries the new text from its next turn (a running one's file is rewritten by the server; one not running
 *   carries it when opened), as does a new chat that picks it. With no template in use it is unavailable, and says to
 *   make one with Create new template.
 * - **Create new template**: a small dialog asks for the name (checked as the store checks it: trimmed, not empty, not
 *   another template's, at most `GUIDANCE_NAME_MAX`), makes a template of the text, and the conversation then uses it.
 * The pencil beside the template menu renames the template in place (Enter saves, Esc cancels), checked the same way.
 *
 * A running conversation is changed in its process, which reads its file at each turn. One with no process (`file` only)
 * has the change kept for when it is opened next. A template changed elsewhere (another page, Settings) reaches a running
 * conversation's live frame, so the box (while not being edited) and the template menu follow it. A page that is not on
 * the computer omp-webui runs on reads only, as the server allows template and guidance changes from this computer only:
 * every control says so.
 */
export function GuidanceEditor({ liveId, file }: { liveId: string | null; file: string | null }) {
	const t = useT();
	const ready = useGuidanceStrings();
	const local = useApp((s) => s.meta?.local !== false);
	// The running conversation's guidance as the live frames keep it; a closed one's is what the server kept.
	const liveGuidance = useApp((s) => (liveId ? s.lives[liveId]?.info.guidance : undefined));
	const [kept, setKept] = useState<LiveGuidance | null>(null);
	const [templates, setTemplates] = useState<GuidanceTemplate[] | null>(null);
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// "Custom" picked while the conversation carries nothing yet: the box is for text of its own, saved with Save.
	const [customMode, setCustomMode] = useState(false);
	// Save to template of a template other conversations use: which, and how many, until the person confirms.
	const [confirming, setConfirming] = useState<{ template: GuidanceTemplate; others: number } | null>(null);
	// Create new template's dialog: the name typed, whether a refusal for an empty one may show, the server's refusal.
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [newTried, setNewTried] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	// The template's name being edited in place (null: not renaming), and the server's refusal of it.
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameError, setRenameError] = useState<string | null>(null);
	const pencilId = useId();
	const refocusPencil = useRef(false);
	const selectId = useId();
	const renameNote = useId();
	const newNote = useId();
	const key = liveId ?? file;
	useEffect(() => {
		if (!key) return;
		let live = true;
		setError(null);
		setTemplates(null);
		const read = liveId ? guidanceApi.ofLive(liveId) : guidanceApi.ofFile(file as string);
		read.then(
			(answer) => {
				if (!live) return;
				setKept(answer.guidance);
				setTemplates(answer.templates.templates);
			},
			(e: unknown) => {
				if (live) setError((e as Error).message);
			},
		);
		return () => {
			live = false;
		};
	}, [key, liveId, file]);
	const value: LiveGuidance | null = liveId ? (liveGuidance ?? null) : kept;
	const carried = value?.text ?? "";
	// The box follows what the conversation carries until the person types something else.
	const [touched, setTouched] = useState(false);
	useEffect(() => {
		if (!touched) setText(carried);
	}, [carried, touched]);
	// The template it uses was changed elsewhere (its text or its name, which the conversation's live frame brings): the
	// menu's names and Save to template's comparison read the templates again. A read that fails keeps the list it has.
	const following = value?.template ? `${value.template}\n${value.templateName}\n${value.text}` : "";
	useEffect(() => {
		if (!following) return;
		let live = true;
		guidanceApi.templates().then(
			(set) => {
				if (live) setTemplates(set.templates);
			},
			() => {},
		);
		return () => {
			live = false;
		};
	}, [following]);
	// Renaming ended (saved or cancelled): the keyboard goes back to the pencil it started from.
	useEffect(() => {
		if (renaming === null && refocusPencil.current) {
			refocusPencil.current = false;
			document.getElementById(pencilId)?.focus();
		}
	}, [renaming, pencilId]);
	if (!ready || !key) return null;
	const template = value?.template ? (templates?.find((x) => x.id === value.template) ?? null) : null;
	const changed = text.trim() !== carried.trim();
	const tooLong = text.length > GUIDANCE_MAX;
	const readOnly = !local || busy;

	const apply = async (next: { template?: string; text?: string } | null) => {
		setBusy(true);
		setError(null);
		try {
			const now = liveId
				? ((await guidanceApi.change(liveId, next)) ?? null)
				: await guidanceApi.changeFile(file as string, next);
			setKept(now);
			setTouched(false);
			setText(now?.text ?? "");
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	/** Write the box into `into` (as the store has it now, so that a rename made elsewhere is kept), then carry it here. */
	const writeTemplate = async (into: GuidanceTemplate) => {
		setConfirming(null);
		setBusy(true);
		setError(null);
		try {
			const set = await guidanceApi.update({ ...into, text });
			setTemplates(set.templates);
		} catch (e) {
			// A template deleted meanwhile is refused, not made again (#715): the conversation keeps what it carried.
			setError(refusalText(e, t));
			setBusy(false);
			return;
		}
		setBusy(false);
		await apply({ template: into.id, text });
	};
	/** Save to template: asks first when other conversations use the template (counted now, not when the tab opened). */
	const saveToTemplate = async () => {
		if (!template) return;
		setBusy(true);
		setError(null);
		let fresh: GuidanceTemplate | null = null;
		let others = 0;
		try {
			const answer = await (liveId ? guidanceApi.ofLive(liveId) : guidanceApi.ofFile(file as string));
			setTemplates(answer.templates.templates);
			fresh = answer.templates.templates.find((x) => x.id === template.id) ?? null;
			others = answer.others[template.id] ?? 0;
			if (!fresh) setError(t("guidance.templateGone"));
		} catch (e) {
			setError((e as Error).message);
		}
		setBusy(false);
		if (!fresh) return;
		if (others > 0) setConfirming({ template: fresh, others });
		else await writeTemplate(fresh);
	};

	const newProblem = templates ? guidanceNameProblem(newName, templates) : null;
	// An empty name is said once Create was tried; one too long or another template's is said as it is typed.
	const newShown = newProblem && (newProblem !== "nameEmpty" || newTried) ? nameProblemText(newProblem, t) : null;
	const openCreate = () => {
		setNewName("");
		setNewTried(false);
		setCreateError(null);
		setCreating(true);
	};
	const create = async () => {
		setNewTried(true);
		if (newProblem || busy) return;
		const id = newGuidanceId();
		setBusy(true);
		setCreateError(null);
		try {
			const set = await guidanceApi.save({ id, name: newName.trim(), text });
			setTemplates(set.templates);
		} catch (e) {
			setCreateError(refusalText(e, t));
			setBusy(false);
			return;
		}
		setBusy(false);
		setCreating(false);
		// The conversation uses the template made of its text, so that Save to template and the pencil reach it.
		await apply({ template: id, text });
	};

	const renameProblem =
		renaming !== null && templates && template ? guidanceNameProblem(renaming, templates, template.id) : null;
	const endRename = () => {
		refocusPencil.current = true;
		setRenameError(null);
		setRenaming(null);
	};
	const rename = async () => {
		if (renaming === null || !template || busy) return;
		if (renaming.trim() === template.name.trim()) return endRename();
		if (renameProblem) return;
		setBusy(true);
		setRenameError(null);
		try {
			// The template as the store has it now: its text edited elsewhere meanwhile is not put back by a rename.
			const now = (await guidanceApi.templates()).templates.find((x) => x.id === template.id);
			if (!now) throw new GuidanceApiError(t("guidance.templateGone"), "gone");
			const set = await guidanceApi.update({ ...now, name: renaming.trim() });
			setTemplates(set.templates);
		} catch (e) {
			setRenameError(refusalText(e, t));
			setBusy(false);
			return;
		}
		setBusy(false);
		endRename();
	};

	const remote = local ? null : t("guidance.readOnlyRemote");
	const waiting = busy ? t("guidance.saving") : null;
	const tooLongText = t("guidance.tooLong", { max: GUIDANCE_MAX });
	const hasText = guidanceText(text) !== "";
	const saveReason = remote ?? waiting ?? (!changed ? t("guidance.nothingToSave") : tooLong ? tooLongText : null);
	const toTemplateReason =
		remote ??
		waiting ??
		(!template
			? t("guidance.toTemplateNone")
			: !hasText
				? t("guidance.textNeeded")
				: tooLong
					? tooLongText
					: guidanceText(text) === guidanceText(template.text)
						? t("guidance.toTemplateSame", { name: templateName(template, t) })
						: null);
	const createReason =
		remote ??
		waiting ??
		(!hasText
			? t("guidance.textNeeded")
			: tooLong
				? tooLongText
				: (templates?.length ?? 0) >= GUIDANCE_TEMPLATES_MAX
					? t("guidance.tooManyTemplates", { max: GUIDANCE_TEMPLATES_MAX })
					: null);
	const shown = value?.template && template ? value.template : value || customMode ? "custom" : "";

	return (
		<div className="space-y-3" data-testid="guidance-editor">
			<p className="flex items-start gap-1.5 text-xs text-muted">
				<Sparkles size={13} className="mt-0.5 shrink-0 text-accent" aria-hidden />
				{t("guidance.changeIntro")}
			</p>
			{!local ? (
				<p className="text-xs text-muted" data-testid="guidance-readonly-remote">
					{t("guidance.readOnlyRemote")}
				</p>
			) : null}
			{error ? (
				<p className="text-xs text-danger" data-testid="guidance-error">
					{t("guidance.saveFailed", { error })}
				</p>
			) : null}
			{!templates ? (
				error ? null : (
					<div className="flex items-center gap-2 py-4 text-xs text-muted">
						<Spinner size={12} />
					</div>
				)
			) : (
				<>
					<div className="text-sm">
						<label htmlFor={selectId} className="mb-1 block text-muted">
							{t("guidance.templateLabel")}
						</label>
						{renaming !== null && template ? (
							<div className="space-y-1">
								<div className="flex min-w-0 items-center gap-1">
									<input
										id={selectId}
										// biome-ignore lint/a11y/noAutofocus: the pencil was just pressed to type here
										autoFocus
										data-testid="guidance-rename-input"
										aria-label={t("guidance.renameLabel")}
										aria-invalid={renameProblem !== null || renameError !== null}
										aria-describedby={renameNote}
										className="h-9 min-w-0 flex-1 rounded-xl border border-border bg-bg-soft px-3 text-sm outline-none focus:border-faint"
										value={renaming}
										disabled={busy}
										onFocus={(e) => e.currentTarget.select()}
										onChange={(e) => {
											setRenaming(e.target.value);
											setRenameError(null);
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												void rename();
											} else if (e.key === "Escape") {
												// Esc cancels the rename only, not whatever holds the panel.
												e.preventDefault();
												e.stopPropagation();
												endRename();
											}
										}}
									/>
									<IconButton
										label={t("guidance.renameSave")}
										data-testid="guidance-rename-save"
										disabled={busy || renameProblem !== null}
										onClick={() => void rename()}
									>
										<Check size={15} />
									</IconButton>
									<IconButton
										label={t("guidance.cancel")}
										data-testid="guidance-rename-cancel"
										disabled={busy}
										onClick={endRename}
									>
										<X size={15} />
									</IconButton>
								</div>
								<p
									id={renameNote}
									data-testid="guidance-rename-note"
									className={cx("text-xs", renameProblem || renameError ? "text-danger" : "text-faint")}
								>
									{renameError ?? (renameProblem ? nameProblemText(renameProblem, t) : t("guidance.renameHint"))}
								</p>
							</div>
						) : (
							<div className="flex min-w-0 items-center gap-1">
								<Select
									id={selectId}
									className="min-w-0 flex-1"
									data-testid="guidance-template"
									value={shown}
									disabled={readOnly}
									onChange={(e) => {
										const id = e.target.value;
										if (id === "custom") {
											// A template's text becomes the conversation's own, so that editing it needs no question;
											// with nothing carried yet, the box waits for text and Save.
											if (carried.trim()) void apply({ text: carried });
											else setCustomMode(true);
											return;
										}
										setCustomMode(false);
										if (!id) return void apply(null);
										const found = templates.find((x) => x.id === id);
										if (found) void apply({ template: found.id, text: found.text });
									}}
								>
									<option value="">{t("guidance.pickNone")}</option>
									{templates.map((x) => (
										<option key={x.id} value={x.id}>
											{templateName(x, t)}
										</option>
									))}
									<option value="custom">{t("guidance.custom")}</option>
								</Select>
								{template ? (
									<IconButton
										id={pencilId}
										label={remote ?? t("guidance.rename")}
										data-testid="guidance-rename"
										aria-disabled={remote || busy ? true : undefined}
										className={cx(remote && "cursor-not-allowed opacity-50")}
										onClick={() => {
											if (remote || busy) return;
											setRenameError(null);
											setRenaming(templateName(template, t));
										}}
									>
										<Pencil size={14} />
									</IconButton>
								) : null}
							</div>
						)}
					</div>
					<label className="block text-sm">
						<span className="mb-1 block text-muted">{t("guidance.textLabel")}</span>
						<textarea
							className="h-56 w-full resize-y rounded-xl border border-border bg-bg-soft p-3 font-mono text-xs outline-none focus:border-faint"
							data-testid="guidance-text"
							value={text}
							placeholder={t("guidance.empty")}
							readOnly={readOnly}
							onChange={(e) => {
								setTouched(true);
								setText(e.target.value);
							}}
						/>
					</label>
					<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
						<span data-testid="guidance-chars">
							{tooLong ? tooLongText : t("guidance.chars", { n: text.length, max: GUIDANCE_MAX })}
						</span>
						{changed && !readOnly ? (
							<Button
								size="sm"
								variant="ghost"
								data-testid="guidance-revert"
								onClick={() => {
									setTouched(false);
									setText(carried);
								}}
							>
								{t("guidance.revert")}
							</Button>
						) : busy ? (
							<Spinner size={12} />
						) : null}
					</div>
					<div className="flex flex-wrap gap-2" data-testid="guidance-actions">
						<ReasonButton
							size="sm"
							variant="primary"
							data-testid="guidance-save"
							reason={saveReason}
							hint={t("guidance.saveHereHint")}
							// This conversation's own text (none when empty); a template it came from is left as it is.
							onRun={() => void apply(guidanceText(text) ? { text } : null)}
						>
							{t("guidance.saveHere")}
						</ReasonButton>
						<ReasonButton
							size="sm"
							data-testid="guidance-to-template"
							reason={toTemplateReason}
							hint={template ? t("guidance.toTemplateHint", { name: templateName(template, t) }) : ""}
							onRun={() => void saveToTemplate()}
						>
							{t("guidance.toTemplate")}
						</ReasonButton>
						<ReasonButton
							size="sm"
							data-testid="guidance-new-template"
							reason={createReason}
							hint={t("guidance.newFromTextHint")}
							onRun={openCreate}
						>
							{t("guidance.newFromText")}
						</ReasonButton>
					</div>
					{value?.skipped ? (
						<p className="text-xs text-warning" data-testid="guidance-skipped">
							{value.skipped === "trustedExtension"
								? t("guidance.skippedTrusted")
								: value.skipped === "inherited"
									? t("guidance.skippedInherited")
									: t("guidance.skippedUnavailable")}
						</p>
					) : liveId && value && !value.live ? (
						<p className="text-xs text-warning" data-testid="guidance-readonly">
							{t("guidance.readOnly")}
						</p>
					) : !liveId ? (
						<p className="text-xs text-faint" data-testid="guidance-applies-next">
							{t("guidance.appliesNext")}
						</p>
					) : null}
				</>
			)}
			{confirming ? (
				<Modal
					open
					onOpenChange={(o) => (o ? undefined : setConfirming(null))}
					title={t("guidance.confirmTitle", { name: templateName(confirming.template, t) })}
					description={t("guidance.confirmShared", { n: confirming.others })}
				>
					<div className="mt-2 flex flex-wrap justify-end gap-2">
						<Button variant="ghost" data-testid="guidance-confirm-cancel" onClick={() => setConfirming(null)}>
							{t("guidance.cancel")}
						</Button>
						<Button
							variant="primary"
							data-testid="guidance-confirm-update"
							onClick={() => void writeTemplate(confirming.template)}
						>
							{t("guidance.confirmUpdate")}
						</Button>
					</div>
				</Modal>
			) : null}
			{creating ? (
				<Modal
					open
					onOpenChange={(o) => (o ? undefined : setCreating(false))}
					title={t("guidance.newFromText")}
					description={t("guidance.createIntro")}
				>
					<form
						className="space-y-2"
						data-testid="guidance-create"
						onSubmit={(e) => {
							e.preventDefault();
							void create();
						}}
					>
						<label className="block text-sm">
							<span className="mb-1 block text-muted">{t("guidance.nameLabel")}</span>
							<input
								// biome-ignore lint/a11y/noAutofocus: the dialog asks for this one field
								autoFocus
								data-testid="guidance-new-name"
								aria-invalid={newShown !== null || createError !== null}
								aria-describedby={newNote}
								className="h-9 w-full rounded-xl border border-border bg-bg-soft px-3 text-sm outline-none focus:border-faint"
								placeholder={t("guidance.namePlaceholder")}
								value={newName}
								onChange={(e) => {
									setNewName(e.target.value);
									setCreateError(null);
								}}
							/>
						</label>
						<p
							id={newNote}
							data-testid="guidance-new-problem"
							className={cx("text-xs", newShown || createError ? "text-danger" : "text-faint")}
						>
							{createError ?? newShown ?? t("guidance.chars", { n: newName.trim().length, max: GUIDANCE_NAME_MAX })}
						</p>
						<div className="flex flex-wrap justify-end gap-2 pt-1">
							<Button variant="ghost" onClick={() => setCreating(false)}>
								{t("guidance.cancel")}
							</Button>
							<Button type="submit" variant="primary" data-testid="guidance-new-create" disabled={busy}>
								{t("guidance.create")}
							</Button>
						</div>
					</form>
				</Modal>
			) : null}
		</div>
	);
}
