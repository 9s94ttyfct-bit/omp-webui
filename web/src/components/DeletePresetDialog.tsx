import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { Button, Modal, Spinner } from "./ui.tsx";

/**
 * Confirms deleting a preset; the config is shared with the terminal UI, so it is not undoable from here. Its own module,
 * apart from `PresetNameDialog` (which the composer's menu uses): only Settings deletes presets, so this stays off the
 * first page.
 */
export function DeletePresetDialog({
	name,
	onClose,
	onConfirm,
	returnFocusTo,
}: {
	/** The preset to delete; null while the dialog is closed. */
	name: string | null;
	onClose: () => void;
	onConfirm: (name: string) => Promise<void>;
	returnFocusTo?: HTMLElement | null;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	// Keeps what the dialog names while it fades out.
	const [shown, setShown] = useState(name ?? "");
	useEffect(() => {
		if (name !== null) setShown(name);
	}, [name]);
	return (
		<Modal
			open={name !== null}
			onOpenChange={(o) => !o && !busy && onClose()}
			title={t("presets.deleteTitle", { name: shown })}
			description={t("presets.deleteBody")}
			returnFocusTo={returnFocusTo}
		>
			<div className="flex justify-end gap-2">
				<Button variant="ghost" disabled={busy} onClick={onClose}>
					{t("common.cancel")}
				</Button>
				<Button
					variant="danger"
					data-testid="confirm-delete-preset"
					disabled={busy}
					onClick={() => {
						if (name === null) return;
						setBusy(true);
						void onConfirm(name).finally(() => {
							setBusy(false);
							onClose();
						});
					}}
				>
					{busy ? <Spinner size={14} /> : <Trash2 size={13} />} {t("common.delete")}
				</Button>
			</div>
		</Modal>
	);
}
