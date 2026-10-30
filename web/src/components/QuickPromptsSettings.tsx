import {
	QUICK_PROMPT_NAME_MAX,
	QUICK_PROMPT_TEXT_MAX,
	QUICK_PROMPTS_MAX,
	type QuickPrompt,
	restoredQuickPrompts,
	SOFT_STOP_ID,
} from "@shared/quick-prompts.ts";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { registerStrings, useT } from "../i18n/index.ts";
import { en } from "../i18n/quick-prompts.ts";
import { promptName, QuickPromptsTooLarge, saveQuickPrompts, useQuickPrompts } from "../lib/quick-prompts.ts";
import { useApp } from "../store/app.ts";
import { Button, CardHeader, cx, IconButton, Select } from "./ui.tsx";

// This chunk carries its own English strings: the first page does not (see `registerStrings`).
registerStrings("quickPrompts", en);

const field =
	"w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent aria-[invalid=true]:border-danger";

/** What is wrong with a prompt as written, or null. */
function problemOf(p: QuickPrompt): "needsName" | "needsText" | "nameLong" | "textLong" | null {
	if (!p.name.trim()) return "needsName";
	if (!p.text.trim()) return "needsText";
	if (p.name.length > QUICK_PROMPT_NAME_MAX) return "nameLong";
	if (p.text.length > QUICK_PROMPT_TEXT_MAX) return "textLong";
	return null;
}

const newId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Settings › Quick prompts (#659): add, edit, reorder and remove the prompts of the message box's ⚡ menu, each with how it
 * is sent while the agent works and whether the session stops after. The built-ins (Soft stop, #658, and the presets) are
 * among them; Restore brings them back as shipped and keeps the person's own prompts. Edits are a draft until Save.
 */
export function QuickPromptsSettings() {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const saved = useQuickPrompts();
	const [draft, setDraft] = useState<QuickPrompt[]>(saved);
	const [tried, setTried] = useState(false);
	// What is saved from elsewhere (another tab, Restore) replaces a draft that has no edits of its own.
	const [base, setBase] = useState(saved);
	if (saved !== base) {
		setBase(saved);
		if (JSON.stringify(draft) === JSON.stringify(base)) setDraft(saved);
	}

	const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
	const update = (i: number, change: Partial<QuickPrompt>) =>
		setDraft((list) => list.map((p, j) => (j === i ? { ...p, ...change } : p)));
	const move = (i: number, by: -1 | 1) =>
		setDraft((list) => {
			const next = [...list];
			const [p] = next.splice(i, 1);
			next.splice(i + by, 0, p as QuickPrompt);
			return next;
		});
	const save = () => {
		setTried(true);
		if (draft.some((p) => problemOf(p) !== null)) return;
		try {
			saveQuickPrompts(draft);
			setTried(false);
			toast("success", t("quickPrompts.saved"));
		} catch (e) {
			toast("error", e instanceof QuickPromptsTooLarge ? t("quickPrompts.tooLarge") : String(e));
		}
	};
	const restore = () => {
		const list = restoredQuickPrompts(saved);
		saveQuickPrompts(list);
		setDraft(list);
		setTried(false);
		toast("success", t("quickPrompts.cardRestoreDone"));
	};

	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="quick-prompts-settings">
			<CardHeader title={t("quickPrompts.cardTitle")} hint={t("quickPrompts.cardIntro")} />
			<p className="mt-1 text-xs text-muted">{t("quickPrompts.fieldTextNote")}</p>
			{draft.length === 0 ? <p className="mt-3 text-sm text-muted">{t("quickPrompts.cardEmpty")}</p> : null}
			<ol className="mt-3 flex flex-col gap-3">
				{draft.map((p, i) => {
					const problem = tried ? problemOf(p) : null;
					const label = promptName(p, t);
					return (
						<li
							key={p.id}
							className="rounded-xl border border-border p-3"
							data-testid="quick-prompt-row"
							data-id={p.id}
						>
							<div className="flex items-center gap-2">
								<label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted">
									{t("quickPrompts.fieldName")}
									<input
										className={field}
										value={p.name}
										maxLength={QUICK_PROMPT_NAME_MAX}
										aria-invalid={problem === "needsName" || problem === "nameLong"}
										data-testid="quick-prompt-name"
										onChange={(e) => update(i, { name: e.target.value })}
									/>
								</label>
								<div className="flex shrink-0 items-center self-end">
									<IconButton
										label={`${t("quickPrompts.moveUp")}: ${label}`}
										size="sm"
										disabled={i === 0}
										onClick={() => move(i, -1)}
									>
										<ArrowUp size={14} />
									</IconButton>
									<IconButton
										label={`${t("quickPrompts.moveDown")}: ${label}`}
										size="sm"
										disabled={i === draft.length - 1}
										onClick={() => move(i, 1)}
									>
										<ArrowDown size={14} />
									</IconButton>
									<IconButton
										label={`${t("quickPrompts.remove")}: ${label}`}
										size="sm"
										data-testid="quick-prompt-remove"
										onClick={() => setDraft((list) => list.filter((_, j) => j !== i))}
									>
										<Trash2 size={14} />
									</IconButton>
								</div>
							</div>
							<label className="mt-2 flex flex-col gap-1 text-xs text-muted">
								{t("quickPrompts.fieldText")}
								<textarea
									className={cx(field, "min-h-20 resize-y font-mono text-xs")}
									value={p.text}
									maxLength={QUICK_PROMPT_TEXT_MAX}
									rows={p.id === SOFT_STOP_ID ? 6 : 3}
									aria-invalid={problem === "needsText" || problem === "textLong"}
									data-testid="quick-prompt-text"
									onChange={(e) => update(i, { text: e.target.value })}
								/>
							</label>
							{problem ? (
								<p className="mt-1 text-xs text-danger" role="alert">
									{problem === "needsName"
										? t("quickPrompts.needsName")
										: problem === "needsText"
											? t("quickPrompts.needsText")
											: t("quickPrompts.tooLong", {
													n: problem === "nameLong" ? QUICK_PROMPT_NAME_MAX : QUICK_PROMPT_TEXT_MAX,
												})}
								</p>
							) : null}
							<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
								{/* Wraps: on a phone the select drops under its label and takes the row, so its text is not cut. */}
								<label className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
									{t("quickPrompts.fieldMode")}
									<Select
										tone="compact"
										className="min-w-0 flex-1 basis-64 sm:flex-none sm:basis-auto"
										value={p.mode}
										data-testid="quick-prompt-mode"
										onChange={(e) => update(i, { mode: e.target.value === "followUp" ? "followUp" : "steer" })}
									>
										<option value="steer">{t("quickPrompts.fieldModeSteer")}</option>
										<option value="followUp">{t("quickPrompts.fieldModeFollowUp")}</option>
									</Select>
								</label>
								<label
									className="flex items-center gap-2 text-xs text-muted"
									title={t("quickPrompts.fieldStopAfterHint")}
								>
									<input
										type="checkbox"
										checked={p.stopAfter}
										data-testid="quick-prompt-stop-after"
										onChange={(e) => update(i, { stopAfter: e.target.checked })}
									/>
									{t("quickPrompts.fieldStopAfter")}
								</label>
							</div>
							{p.id === SOFT_STOP_ID ? (
								<p className="mt-2 text-xs text-muted">{t("quickPrompts.softStopNote")}</p>
							) : null}
						</li>
					);
				})}
			</ol>
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<Button
					size="sm"
					data-testid="quick-prompt-add"
					disabled={draft.length >= QUICK_PROMPTS_MAX}
					onClick={() =>
						setDraft((list) => [
							...list,
							{ id: newId(), name: t("quickPrompts.newName"), text: "", mode: "followUp", stopAfter: false },
						])
					}
				>
					<Plus size={13} />
					{t("quickPrompts.cardAdd")}
				</Button>
				<Button size="sm" variant="ghost" data-testid="quick-prompts-restore" onClick={restore}>
					<RotateCcw size={13} />
					{t("quickPrompts.cardRestore")}
				</Button>
				<span className="flex-1" />
				<Button size="sm" variant="primary" data-testid="quick-prompts-save" disabled={!dirty} onClick={save}>
					{t("quickPrompts.save")}
				</Button>
			</div>
		</section>
	);
}
