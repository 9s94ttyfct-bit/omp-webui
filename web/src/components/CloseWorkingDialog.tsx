import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { Button, Modal } from "./ui.tsx";

/**
 * Asks before Settings › Running sessions closes a conversation that works (#388): omp aborts its turn when its stdin is
 * closed (the reply and a running tool are cut, nothing finishes), so the Close of an idle conversation is no question, and
 * the Close of a working one is.
 */
export function CloseWorkingDialog({
	name,
	onClose,
	onConfirm,
}: {
	/** The conversation to close; null while the dialog is closed. */
	name: string | null;
	onClose: () => void;
	onConfirm: () => void;
}) {
	const t = useT();
	// Keeps what the dialog names while it fades out.
	const [shown, setShown] = useState(name ?? "");
	useEffect(() => {
		if (name !== null) setShown(name);
	}, [name]);
	return (
		<Modal
			open={name !== null}
			onOpenChange={(o) => !o && onClose()}
			title={t("pages.settingsCloseWorkingTitle", { name: shown })}
			description={t("pages.settingsCloseWorkingBody")}
		>
			<div className="flex justify-end gap-2">
				<Button variant="ghost" onClick={onClose}>
					{t("common.cancel")}
				</Button>
				<Button
					variant="danger"
					data-testid="confirm-close-working"
					onClick={() => {
						onConfirm();
						onClose();
					}}
				>
					{t("common.close")}
				</Button>
			</div>
		</Modal>
	);
}
