import * as Popover from "@radix-ui/react-popover";
import { Lock, X, Zap } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { useImeGuard } from "../lib/ime.ts";
import { Button, cx, Tip } from "./ui.tsx";

export type QueueKind = "steering" | "followUp";

interface Props {
	kind: QueueKind;
	text: string;
	/** How many messages are queued after this one in its queue: saving an edit puts it behind them. */
	after: number;
	/** omp already sent it into the running response: it can no longer withdraw it, so it can't be edited or removed. */
	locked: boolean;
	onPromote?: () => void;
	onRemove?: () => void;
	/** Queue the edited text in its place; resolves once that is done (the editor closes then). */
	onEdit?: (text: string) => Promise<void>;
	/**
	 * What the open editor holds while it differs from the message (null when nothing would be lost by closing it).
	 * The queue can drop this chip, with its editor, at any moment (omp took the message): the parent keeps this to
	 * give the text back.
	 */
	onEditing?: (text: string | null) => void;
}

/** One message waiting in omp's queue: its kind, a click opens an editor, and the buttons that send it now or drop it. */
export function QueueChip({ kind, text, after, locked, onPromote, onRemove, onEdit, onEditing }: Props) {
	const t = useT();
	const ime = useImeGuard();
	const [open, setOpen] = useState(false);
	const [value, setValue] = useState(text);
	const [saving, setSaving] = useState(false);
	const report = useRef(onEditing);
	report.current = onEditing;
	// Saving takes the text over (and tells by itself if omp was too late), so only an unsaved edit is reported.
	const unsaved = open && !saving && value !== text && value.trim() ? value : null;
	useEffect(() => report.current?.(unsaved), [unsaved]);

	const label = (
		<span className={cx("font-medium", kind === "steering" ? "text-accent" : "text-muted")}>
			{kind === "steering" ? t("chat.composerChipSteer") : t("chat.composerChipQueued")}
		</span>
	);
	const chip =
		"inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface py-0.5 pr-1 pl-2.5 text-xs";

	if (locked)
		return (
			<span className={chip} data-testid="queue-chip" data-locked="true" title={t("chat.queueEditLocked")}>
				{label}
				<span className="max-w-64 truncate">{text}</span>
				<Lock size={11} className="mr-1.5 text-muted" aria-hidden />
				<span className="sr-only">{t("chat.queueEditLocked")}</span>
			</span>
		);

	const save = async () => {
		if (saving) return;
		if (value === text || !value.trim()) {
			setOpen(false);
			return;
		}
		setSaving(true);
		try {
			await onEdit?.(value);
		} finally {
			setSaving(false);
			setOpen(false);
		}
	};
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		// Enter that confirms an IME composition must not save a half-typed word (WebKit delivers it after compositionend).
		if (e.key !== "Enter" || e.shiftKey || ime.imeKey(e)) return;
		e.preventDefault();
		void save();
	};

	return (
		<span className={chip} data-testid="queue-chip" data-kind={kind}>
			{label}
			{onEdit ? (
				<Popover.Root
					open={open}
					onOpenChange={(o) => {
						if (saving) return;
						if (o) setValue(text);
						setOpen(o);
					}}
				>
					<Tip label={t("chat.composerEditQueued")}>
						<Popover.Trigger asChild>
							<button
								type="button"
								aria-label={`${t("chat.composerEditQueued")}: ${text}`}
								className="max-w-64 truncate rounded text-left hover:underline"
								data-testid="queue-edit-open"
							>
								{text}
							</button>
						</Popover.Trigger>
					</Tip>
					<Popover.Portal>
						<Popover.Content
							side="top"
							align="start"
							sideOffset={8}
							collisionPadding={8}
							aria-label={kind === "steering" ? t("chat.queueEditSteer") : t("chat.queueEditFollowUp")}
							className="z-50 w-96 max-w-[calc(100vw-1rem)] rounded-2xl border border-border bg-surface p-3 shadow-2xl outline-none"
							data-testid="queue-edit"
							data-kind={kind}
						>
							<div className={cx("mb-2 text-xs font-medium", kind === "steering" ? "text-accent" : "text-muted")}>
								{kind === "steering" ? t("chat.queueEditSteer") : t("chat.queueEditFollowUp")}
							</div>
							<textarea
								// biome-ignore lint/a11y/noAutofocus: the editor opened because the user asked to type here
								autoFocus
								aria-label={t("chat.queueEditLabel")}
								rows={5}
								value={value}
								readOnly={saving}
								onChange={(e) => setValue(e.target.value)}
								onKeyDown={onKeyDown}
								onCompositionEnd={ime.onCompositionEnd}
								onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
								className="max-h-72 min-h-24 w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-sm leading-relaxed outline-none focus:border-accent"
								data-testid="queue-edit-text"
							/>
							{after > 0 ? (
								<p className="mt-2 text-xs text-muted" data-testid="queue-edit-end">
									{after === 1 ? t("chat.queueEditEndOne") : t("chat.queueEditEndMany", { n: after })}
								</p>
							) : null}
							<div className="mt-2 flex items-center justify-between gap-2">
								<span className="text-xs text-muted">{t("chat.queueEditHint")}</span>
								<div className="flex shrink-0 gap-1.5">
									<Button size="sm" variant="ghost" onClick={() => setOpen(false)} data-testid="queue-edit-cancel">
										{t("common.cancel")}
									</Button>
									<Button
										size="sm"
										variant="primary"
										disabled={saving || !value.trim()}
										onClick={() => void save()}
										data-testid="queue-edit-save"
									>
										{t("common.save")}
									</Button>
								</div>
							</div>
						</Popover.Content>
					</Popover.Portal>
				</Popover.Root>
			) : (
				<span className="max-w-64 truncate">{text}</span>
			)}
			{kind === "followUp" && onPromote ? (
				<Tip label={t("chat.composerSendNowSteer")}>
					<button
						type="button"
						aria-label={t("chat.composerSteerNow")}
						className="rounded-full p-0.5 text-muted hover:bg-hover hover:text-fg"
						onClick={onPromote}
					>
						<Zap size={12} />
					</button>
				</Tip>
			) : null}
			{onRemove ? (
				<button
					type="button"
					aria-label={t("chat.composerRemoveQueued")}
					className="rounded-full p-0.5 text-muted hover:bg-hover hover:text-fg"
					onClick={onRemove}
				>
					<X size={12} />
				</button>
			) : null}
		</span>
	);
}
