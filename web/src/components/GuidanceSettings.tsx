import {
	BUILTIN_GUIDANCE,
	GUIDANCE_MAX,
	GUIDANCE_NAME_MAX,
	type GuidanceTemplate,
	type GuidanceTemplates,
	newGuidanceId,
} from "@shared/model-guidance.ts";
import { PREF } from "@shared/prefs.ts";
import { Copy, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import { guidanceApi } from "../lib/guidance-api.ts";
import { templateName, templateSummary } from "../lib/guidance-names.ts";
import { useGuidanceStrings } from "../lib/guidance-strings.ts";
import { onPrefsChanged, setPref } from "../lib/prefs.ts";
import { useApp } from "../store/app.ts";
import { Button, CardHeader, cx, Modal, Spinner } from "./ui.tsx";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const defaultOf = (): string | null => localStorage.getItem(PREF.guidanceDefault);
const checkOf = (): boolean => localStorage.getItem(PREF.guidanceCheck) !== "off";

/** A template being edited: a new one (no id yet) or one that exists. */
interface Draft {
	id?: string;
	name: string;
	text: string;
}

/**
 * Settings › Model guidance (#641; v0.11.18 §6): the templates the person picks for a new conversation, as a list of names
 * with a line that says what each is about, and which one new chats start with (`ompw.guidanceDefault`). A template opens in
 * an editor: its name and text, *Default for new chats*, *Duplicate*, *Delete*, and *Reset* for a shipped one that was
 * changed. Kept in the app's data folder (`model-guidance.json`), so they follow the person to another computer; a
 * conversation that picked one keeps the text it stood for, and a template edited here reaches the conversations that use
 * it at their next turn (a running one's file is rewritten; one not running carries it when opened). Changing them is
 * for the page on this computer (see `isLocalOnlyRoute`): what a template says is put into the system prompt of every
 * conversation that picks it. A chunk of its own, with its strings.
 */
export function GuidanceSettings() {
	const t = useT();
	const ready = useGuidanceStrings();
	const local = useApp((s) => s.meta?.local !== false);
	const [set, setSet] = useState<GuidanceTemplates | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [deleting, setDeleting] = useState<GuidanceTemplate | null>(null);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [defaultId, setDefaultId] = useState(defaultOf);
	const [checkOn, setCheckOn] = useState(checkOf);
	useEffect(
		() =>
			onPrefsChanged((keys) => {
				if (keys.includes(PREF.guidanceDefault)) setDefaultId(defaultOf());
				if (keys.includes(PREF.guidanceCheck)) setCheckOn(checkOf());
			}),
		[],
	);
	useEffect(() => {
		let live = true;
		guidanceApi.templates().then(
			(answer) => {
				if (live) setSet(answer);
			},
			(e: unknown) => {
				if (live) setError(messageOf(e));
			},
		);
		return () => {
			live = false;
		};
	}, []);
	if (!ready) return null;
	const apply = (write: Promise<GuidanceTemplates>, done?: string, after?: () => void) => {
		setBusy(true);
		setError(null);
		write.then(
			(answer) => {
				setBusy(false);
				setSet(answer);
				if (done) setNotice(done);
				after?.();
			},
			(e: unknown) => {
				setBusy(false);
				setError(messageOf(e));
			},
		);
	};
	const makeDefault = (id: string | null) => {
		setPref(PREF.guidanceDefault, id);
		setDefaultId(id);
	};
	const templates = set?.templates ?? [];
	const byDefault = templates.find((x) => x.id === defaultId) ?? null;
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="guidance-settings">
			<CardHeader
				title={t("guidance.title")}
				icon={<Sparkles size={16} className="text-accent" />}
				hint={t("guidance.settingsIntro")}
				action={
					local ? (
						<div className="flex shrink-0 gap-2">
							<Button
								size="sm"
								data-testid="guidance-restore"
								title={t("guidance.restoreHint")}
								disabled={busy}
								onClick={() => apply(guidanceApi.restore(), t("guidance.restoreDone"))}
							>
								<RotateCcw size={13} /> {t("guidance.restore")}
							</Button>
							<Button
								size="sm"
								data-testid="guidance-new"
								disabled={busy}
								onClick={() => setDraft({ name: "", text: "" })}
							>
								<Plus size={13} /> {t("guidance.newTemplate")}
							</Button>
						</div>
					) : null
				}
			/>
			{!local ? (
				<p className="text-xs text-muted" data-testid="guidance-readonly-remote">
					{t("guidance.readOnlyRemote")}
				</p>
			) : null}
			{set ? (
				<p className="mb-2 text-sm" data-testid="guidance-default-line">
					{byDefault ? t("guidance.newChatsGet", { name: templateName(byDefault, t) }) : t("guidance.newChatsNone")}
				</p>
			) : null}
			{/* The conflict check (v0.13.0): on by default; what it costs is said beside the switch. */}
			<label className="mb-3 flex cursor-pointer items-start gap-2 text-sm" data-testid="guidance-check-setting">
				<input
					type="checkbox"
					className="mt-1 accent-[var(--accent)]"
					data-testid="guidance-check-toggle"
					checked={checkOn}
					disabled={!local}
					onChange={(e) => {
						setPref(PREF.guidanceCheck, e.target.checked ? "on" : "off");
						setCheckOn(e.target.checked);
					}}
				/>
				<span>
					{t("guidance.conflictSetting")}
					<span className="block text-xs text-muted">{t("guidance.conflictSettingHint")}</span>
				</span>
			</label>
			{error ? (
				<p className="mb-2 text-xs text-danger" data-testid="guidance-settings-error">
					{t("guidance.loadFailed", { error })}
				</p>
			) : null}
			{notice ? (
				<p className="mb-2 text-xs text-success" data-testid="guidance-notice">
					{notice}
				</p>
			) : null}
			{!set ? (
				<div className="flex items-center gap-2 py-4 text-xs text-muted">
					<Spinner size={12} /> {t("guidance.saving")}
				</div>
			) : templates.length === 0 ? (
				<p className="text-xs text-faint" data-testid="guidance-settings-empty">
					{t("guidance.settingsEmpty")}
				</p>
			) : (
				<ul
					className="-mx-2 divide-y divide-border"
					data-testid="guidance-templates"
					aria-label={t("guidance.listLabel")}
				>
					{templates.map((template) => {
						const body = (
							<>
								<span className="flex items-center gap-1.5 text-sm">
									{/* The spaces keep the name, the badges and the summary apart in the button's name. */}
									<span className="truncate font-medium">{templateName(template, t)}</span>{" "}
									{template.id === defaultId ? (
										<span
											className="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-xs text-accent"
											data-testid="guidance-default-badge"
										>
											{t("guidance.defaultBadge")}
										</span>
									) : null}{" "}
									{template.builtin ? (
										<span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-xs text-muted">
											{t("guidance.builtin")}
										</span>
									) : null}
								</span>{" "}
								<span className="mt-0.5 block truncate text-xs text-muted">{templateSummary(template, t)}</span>
							</>
						);
						return (
							<li key={template.id} data-testid="guidance-template-row">
								{local ? (
									<button
										type="button"
										className="block w-full rounded-lg px-2 py-2 text-left hover:bg-hover focus-visible:bg-hover"
										onClick={() => setDraft({ id: template.id, name: template.name, text: template.text })}
									>
										{body}
									</button>
								) : (
									<div className="px-2 py-2">{body}</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{draft ? (
				<TemplateDialog
					// A duplicate is another template: its editor starts from its own name and text.
					key={draft.id ?? `new:${draft.name}`}
					draft={draft}
					isDefault={draft.id !== undefined && draft.id === defaultId}
					checkOn={checkOn}
					shipped={BUILTIN_GUIDANCE.find((b) => b.id === draft.id) ?? null}
					busy={busy}
					onClose={() => setDraft(null)}
					onSave={(next, asDefault) => {
						const id = next.id ?? newGuidanceId();
						// The default is what was saved: a template the store refused is no default.
						apply(guidanceApi.save({ id, name: next.name, text: next.text }), t("guidance.saved"), () => {
							if (asDefault) makeDefault(id);
							else if (id === defaultId) makeDefault(null);
						});
						setDraft(null);
					}}
					onDuplicate={(from) =>
						setDraft({
							name: t("guidance.copyName", { name: templateName({ id: draft.id ?? "", name: from.name }, t) }),
							text: from.text,
						})
					}
					onDelete={() => {
						const found = templates.find((x) => x.id === draft.id);
						setDraft(null);
						if (found) setDeleting(found);
					}}
				/>
			) : null}
			{deleting ? (
				<Modal
					open
					onOpenChange={(o) => (o ? undefined : setDeleting(null))}
					title={t("guidance.deleteConfirm", { name: templateName(deleting, t) })}
					description={t("guidance.deleteHint")}
				>
					<div className="mt-2 flex justify-end gap-2">
						<Button variant="ghost" onClick={() => setDeleting(null)}>
							{t("guidance.cancel")}
						</Button>
						<Button
							variant="danger"
							data-testid="guidance-delete-confirm"
							disabled={busy}
							onClick={() => {
								apply(guidanceApi.remove(deleting.id));
								// A template that is gone is no default: new chats start without guidance.
								if (deleting.id === defaultId) makeDefault(null);
								setDeleting(null);
							}}
						>
							{t("guidance.delete")}
						</Button>
					</div>
				</Modal>
			) : null}
		</section>
	);
}

/**
 * The template editor: its name and its text, with what the store refuses said before it is sent; whether new chats start
 * with it; and, for one that exists, Duplicate, Delete and (a shipped one that was changed) Reset to what ships.
 */
function TemplateDialog({
	draft,
	isDefault,
	checkOn,
	shipped,
	busy,
	onClose,
	onSave,
	onDuplicate,
	onDelete,
}: {
	draft: Draft;
	isDefault: boolean;
	/** The conflict check is on: the editor says that a template is not checked against a folder, and how one is. */
	checkOn: boolean;
	/** The shipped template of the same id, for Reset. */
	shipped: GuidanceTemplate | null;
	busy: boolean;
	onClose: () => void;
	onSave: (next: Draft, asDefault: boolean) => void;
	onDuplicate: (from: Draft) => void;
	onDelete: () => void;
}) {
	const t = useT();
	const [name, setName] = useState(draft.name);
	const [text, setText] = useState(draft.text);
	const [asDefault, setAsDefault] = useState(isDefault);
	const trimmed = name.trim();
	// An empty field is what a new template starts as, not a mistake: it is said once the person has typed something.
	// Save stays off until both are filled.
	const [touched, setTouched] = useState(false);
	const empty = !trimmed ? t("guidance.nameEmpty") : !text.trim() ? t("guidance.textEmpty") : null;
	const problem =
		trimmed.length > GUIDANCE_NAME_MAX
			? t("guidance.nameTooLong", { max: GUIDANCE_NAME_MAX })
			: text.trim().length > GUIDANCE_MAX
				? t("guidance.tooLong", { max: GUIDANCE_MAX })
				: empty;
	const shownProblem = problem === empty && !touched ? null : problem;
	const changedFromShipped = shipped !== null && (shipped.name !== trimmed || shipped.text.trim() !== text.trim());
	return (
		<Modal
			open
			onOpenChange={(o) => (o ? undefined : onClose())}
			title={draft.id ? templateName({ id: draft.id, name: draft.name }, t) : t("guidance.newTemplate")}
			wide
		>
			<div className="space-y-3" data-testid="guidance-editor">
				<label className="block text-sm">
					<span className="mb-1 block text-muted">{t("guidance.nameLabel")}</span>
					<input
						className="w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-sm"
						data-testid="guidance-name"
						value={name}
						placeholder={t("guidance.namePlaceholder")}
						onChange={(e) => {
							setName(e.target.value);
							setTouched(true);
						}}
					/>
				</label>
				<label className="block text-sm">
					<span className="mb-1 block text-muted">{t("guidance.bodyLabel")}</span>
					<textarea
						className="h-56 w-full resize-y rounded-lg border border-border bg-bg px-2 py-1.5 font-mono text-xs"
						data-testid="guidance-body"
						value={text}
						placeholder={t("guidance.textPlaceholder")}
						onChange={(e) => {
							setText(e.target.value);
							setTouched(true);
						}}
					/>
				</label>
				{checkOn ? (
					<p className="text-xs text-faint" data-testid="guidance-template-check-note">
						{t("guidance.conflictTemplateNote")}
					</p>
				) : null}
				<label className="flex cursor-pointer items-start gap-2 text-sm">
					<input
						type="checkbox"
						className="mt-1 accent-[var(--accent)]"
						data-testid="guidance-make-default"
						checked={asDefault}
						onChange={(e) => setAsDefault(e.target.checked)}
					/>
					<span>
						{t("guidance.makeDefault")}
						<span className="block text-xs text-muted">{t("guidance.makeDefaultHint")}</span>
					</span>
				</label>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex flex-wrap gap-1">
						{draft.id ? (
							<>
								<Button
									size="sm"
									variant="ghost"
									data-testid="guidance-duplicate"
									disabled={busy || problem !== null}
									onClick={() => onDuplicate({ name: trimmed, text })}
								>
									<Copy size={13} /> {t("guidance.duplicate")}
								</Button>
								{changedFromShipped && shipped ? (
									<Button
										size="sm"
										variant="ghost"
										data-testid="guidance-reset"
										title={t("guidance.resetHint")}
										disabled={busy}
										onClick={() => {
											setName(shipped.name);
											setText(shipped.text);
										}}
									>
										<RotateCcw size={13} /> {t("guidance.reset")}
									</Button>
								) : null}
								<Button
									size="sm"
									variant="ghost"
									className="text-danger"
									data-testid="guidance-delete"
									disabled={busy}
									onClick={onDelete}
								>
									<Trash2 size={13} /> {t("guidance.delete")}
								</Button>
							</>
						) : null}
					</div>
					<div className="flex items-center gap-2">
						<span className={cx("text-xs", shownProblem ? "text-danger" : "text-muted")} data-testid="guidance-problem">
							{shownProblem ?? t("guidance.chars", { n: text.trim().length, max: GUIDANCE_MAX })}
						</span>
						<Button variant="ghost" onClick={onClose}>
							{t("guidance.cancel")}
						</Button>
						<Button
							data-testid="guidance-save-template"
							disabled={busy || problem !== null}
							onClick={() => onSave({ ...(draft.id ? { id: draft.id } : {}), name: trimmed, text }, asDefault)}
						>
							{t("guidance.save")}
						</Button>
					</div>
				</div>
			</div>
		</Modal>
	);
}
