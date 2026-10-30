import { type ModelPreset, PRESET_NAME_MAX, presetNameProblem } from "@shared/model-config.ts";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useT } from "../i18n/index.ts";
import { Button, Modal, Spinner } from "./ui.tsx";

/**
 * Asks for a preset's name, with omp's rules (a letter, then letters, digits, - or _) checked as you type.
 * A save may take the name of a preset of the global config — that replaces it, and says so on the button;
 * a rename or copy never takes a name that is in use, and no preset can take a name a project defines.
 */
export function PresetNameDialog({
	open,
	onOpenChange,
	title,
	description,
	initial,
	submitLabel,
	existing,
	allowReplace = false,
	returnFocusTo,
	onSubmit,
	extra,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: string;
	initial: string;
	submitLabel: string;
	existing: ModelPreset[];
	allowReplace?: boolean;
	returnFocusTo?: HTMLElement | null;
	/** Shown under the name's message: what else the preset saves (its subagent models). */
	extra?: ReactNode;
	/** Resolves when done (the dialog closes); a rejection's message is shown in the dialog. */
	onSubmit: (name: string, replace: boolean) => Promise<void>;
}) {
	const t = useT();
	const [name, setName] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const messageId = useId();
	useEffect(() => {
		if (!open) return;
		setName(initial);
		setError(null);
	}, [open, initial]);

	const trimmed = name.trim();
	const problem = presetNameProblem(trimmed);
	// A name a project defines is refused even when the global config has one of it too: the project's is what applies there.
	const clash =
		existing.find((p) => p.name === trimmed && p.source === "project") ?? existing.find((p) => p.name === trimmed);
	const replace = allowReplace && clash?.source === "global";
	const message =
		problem === "invalid"
			? t("presets.nameInvalid")
			: problem === "tooLong"
				? t("presets.nameTooLong", { max: PRESET_NAME_MAX })
				: clash && clash.source !== "global"
					? t("presets.nameProject")
					: clash && !replace
						? t("presets.nameExists")
						: null;
	const blocked = busy || problem !== null || message !== null;
	const note = replace ? t("presets.replaceNote", { name: trimmed }) : t("presets.nameHint");

	const submit = async () => {
		if (blocked) return;
		setBusy(true);
		setError(null);
		try {
			await onSubmit(trimmed, replace);
			onOpenChange(false);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const shownError = error ?? (trimmed === "" ? null : message);

	return (
		<Modal
			open={open}
			onOpenChange={(o) => !busy && onOpenChange(o)}
			title={title}
			description={description}
			returnFocusTo={returnFocusTo}
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<label className="mb-1 block text-xs font-medium text-muted" htmlFor={`${messageId}-name`}>
					{t("presets.nameLabel")}
				</label>
				<input
					id={`${messageId}-name`}
					data-testid="preset-name"
					value={name}
					placeholder={t("presets.namePlaceholder")}
					autoComplete="off"
					autoCapitalize="off"
					spellCheck={false}
					aria-invalid={shownError !== null}
					aria-describedby={messageId}
					onChange={(e) => {
						setName(e.target.value);
						setError(null);
					}}
					onFocus={(e) => e.currentTarget.select()}
					className="w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint aria-invalid:border-danger"
					// biome-ignore lint/a11y/noAutofocus: the dialog's one field
					autoFocus
				/>
				<p
					id={messageId}
					role={shownError ? "alert" : undefined}
					data-testid="preset-name-message"
					className={shownError ? "mt-1.5 text-xs text-danger" : "mt-1.5 text-xs text-muted"}
				>
					{shownError ?? note}
				</p>
				{extra}
				<div className="mt-4 flex justify-end gap-2">
					<Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
						{t("common.cancel")}
					</Button>
					<Button variant="primary" type="submit" disabled={blocked || trimmed === ""} data-testid="preset-name-submit">
						{busy ? <Spinner size={14} /> : null} {replace ? t("presets.replace") : submitLabel}
					</Button>
				</div>
			</form>
		</Modal>
	);
}
