import * as Popover from "@radix-ui/react-popover";
import type { GuidanceTemplate, LiveGuidance } from "@shared/model-guidance.ts";
import { PREF } from "@shared/prefs.ts";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import { useT } from "../i18n/index.ts";
import { guidanceApi } from "../lib/guidance-api.ts";
import { templateName, templateSummary } from "../lib/guidance-names.ts";
import { useGuidanceStrings } from "../lib/guidance-strings.ts";
import { GuidanceChoice } from "./GuidanceChoice.tsx";
import { cx, Modal, Spinner } from "./ui.tsx";

type Pick = { template: string; text: string } | { text: string } | null;

/**
 * New chat's *Guidance* chip (#641; v0.11.18 §6): what the main agent of the conversation about to start is told of how to use
 * models for subagents. "Guidance: <name>", or "off". It opens a short list, as the model picker does: None, each template with
 * its one-line summary (the one Settings makes the default for new chats is marked), and "Write your own…"; the template under
 * the pointer or the focus shows its full text below the list. A pick is kept by the New chat page and sent with the new
 * conversation (`OpenTarget.guidance`), which carries it from its first turn and keeps it with its file; the picker names the
 * template by id, so an edit of the template reaches the conversation later.
 *
 * A chunk of its own, fetched when the pointer reaches it or it is opened (`NewChat`): New chat is part of the first page
 * load, and this is for a few people some of the time.
 */
export function GuidancePicker({
	value,
	liveId,
	onPick,
	disabled,
}: {
	/** What the conversation's process carries now. */
	value: LiveGuidance | null;
	/** The process the pick is applied to (none: it is kept for the process still starting). */
	liveId?: string | null;
	/** A template was picked (its id, and the text it stands for now), or text was written; null turns it off. */
	onPick: (pick: Pick) => void;
	disabled?: boolean;
}) {
	const t = useT();
	const ready = useGuidanceStrings();
	const [open, setOpen] = useState(false);
	const [writing, setWriting] = useState(false);
	const [templates, setTemplates] = useState<GuidanceTemplate[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [shown, setShown] = useState<GuidanceTemplate | null>(null);
	// Read when the pointer reaches the control (the list is a moment away) and again when it opens: a template edited in
	// Settings meanwhile is what the person picks.
	const read = useCallback(() => {
		setError(null);
		guidanceApi.templates().then(
			(answer) => setTemplates(answer.templates),
			(e: unknown) => setError((e as Error).message),
		);
	}, []);
	if (!ready) return null;
	/**
	 * A pick reaches the conversation it is about at once when its process runs (the picker's own chunk does the request),
	 * and is kept by New chat for a process started afterwards.
	 */
	const pick = (next: Pick) => {
		onPick(next);
		setOpen(false);
		setWriting(false);
		if (liveId) void guidanceApi.change(liveId, next).catch((e: unknown) => setError((e as Error).message));
	};
	const name = value?.templateName ?? (value?.text ? t("guidance.custom") : null);
	const label = name ? t("guidance.chip", { name }) : t("guidance.chipOff");
	const chosen = value?.template ?? (value?.text ? "custom" : "");
	const defaultId = localStorage.getItem(PREF.guidanceDefault);
	const row = (active: boolean) =>
		cx(
			"flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none",
			"hover:bg-hover focus-visible:bg-hover",
			active && "text-accent",
		);
	return (
		<>
			<Popover.Root
				open={open}
				onOpenChange={(o) => {
					setOpen(o);
					if (o) {
						setShown(null);
						read();
					}
				}}
			>
				<Popover.Trigger asChild>
					<button
						type="button"
						aria-pressed={value !== null}
						data-testid="guidance-picker"
						title={t("guidance.pickTemplateHint")}
						disabled={disabled}
						className={cx(
							"inline-flex h-8 max-w-56 items-center gap-1 rounded-lg px-2 text-xs",
							value ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg",
						)}
						onPointerEnter={read}
					>
						<Sparkles size={14} className="shrink-0" /> <span className="truncate">{label}</span>
						<ChevronDown size={12} className="shrink-0" />
					</button>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						align="start"
						sideOffset={6}
						aria-label={t("guidance.listLabel")}
						className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-surface p-1 shadow-2xl"
						data-testid="guidance-list"
					>
						<p className="px-2 pt-1 pb-1.5 text-xs text-muted">{t("guidance.intro")}</p>
						{error ? (
							<p className="px-2 pb-1 text-xs text-danger" data-testid="guidance-error">
								{t("guidance.loadFailed", { error })}
							</p>
						) : null}
						<ul className="max-h-72 overflow-y-auto">
							<li>
								<button
									type="button"
									className={row(chosen === "")}
									data-testid="guidance-option-none"
									onPointerEnter={() => setShown(null)}
									onFocus={() => setShown(null)}
									onClick={() => pick(null)}
								>
									<Check size={14} className={cx("mt-0.5 shrink-0", chosen !== "" && "invisible")} />
									<span>{t("guidance.pickNone")}</span>
								</button>
							</li>
							{!templates ? (
								<li className="flex items-center gap-2 px-2 py-2 text-xs text-muted">
									<Spinner size={12} /> {t("guidance.saving")}
								</li>
							) : (
								templates.map((template) => (
									<li key={template.id}>
										<button
											type="button"
											className={row(chosen === template.id)}
											data-testid="guidance-option"
											onPointerEnter={() => setShown(template)}
											onFocus={() => setShown(template)}
											onClick={() => pick({ template: template.id, text: template.text })}
										>
											<Check size={14} className={cx("mt-0.5 shrink-0", chosen !== template.id && "invisible")} />
											<span className="min-w-0 flex-1">
												<span className="flex items-center gap-1.5">
													<span className="truncate font-medium">{templateName(template, t)}</span>
													{template.id === defaultId ? (
														<span className="shrink-0 rounded bg-hover px-1.5 text-xs text-muted">
															{t("guidance.defaultBadge")}
														</span>
													) : null}
												</span>
												{/* Two lines, and the whole of it on hover: cut at half a sentence it said nothing (C6). */}
												<span className="line-clamp-2 block text-xs text-muted" title={templateSummary(template, t)}>
													{templateSummary(template, t)}
												</span>
											</span>
										</button>
									</li>
								))
							)}
							<li>
								<button
									type="button"
									className={row(chosen === "custom")}
									data-testid="guidance-option-custom"
									onPointerEnter={() => setShown(null)}
									onFocus={() => setShown(null)}
									onClick={() => {
										setOpen(false);
										setWriting(true);
									}}
								>
									<Check size={14} className={cx("mt-0.5 shrink-0", chosen !== "custom" && "invisible")} />
									<span>{t("guidance.writeOwn")}</span>
								</button>
							</li>
						</ul>
						{shown ? (
							<pre
								className="mx-1 mt-1 mb-0.5 max-h-40 overflow-auto rounded-lg border border-border bg-bg-soft p-2 font-mono text-xs whitespace-pre-wrap"
								data-testid="guidance-preview"
							>
								{shown.text}
							</pre>
						) : null}
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
			{writing ? (
				<Modal open onOpenChange={(o) => (o ? undefined : setWriting(false))} title={t("guidance.title")} wide>
					<GuidanceChoice
						value={value}
						templates={templates ?? []}
						startWriting
						onPick={(template) => pick({ template: template.id, text: template.text })}
						onText={(text) => pick(text ? { text } : null)}
					/>
				</Modal>
			) : null}
		</>
	);
}
