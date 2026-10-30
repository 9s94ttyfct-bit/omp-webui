import { checkNewMac, MAC_LIMIT, MAC_NAME_LIMIT, type SavedMac } from "@shared/macs.ts";
import { CircleAlert, Loader2 } from "lucide-react";
import { useState } from "react";
import { useT } from "../i18n/index.ts";
import { addSavedMac, MacsError, macProblemWords } from "../lib/macs.ts";
import { useApp } from "../store/app.ts";
import { Button, Modal } from "./ui.tsx";

const field = "h-9 w-full rounded-xl border border-border bg-bg-soft px-3 text-sm outline-none focus:border-faint";

/**
 * "Add Mac…" in a browser (the macOS app has a sheet of its own): a name and the address of the other Mac's omp-webui. The page
 * checks them with the rules the server checks them by (`checkNewMac`), says what is wrong in its own words, and asks the server,
 * which checks again and writes the list. A Mac is added here only from this computer (the server refuses any other page).
 */
export function MacAddDialog({
	macs,
	onClose,
	returnFocusTo,
}: {
	macs: readonly SavedMac[];
	onClose: () => void;
	returnFocusTo: HTMLElement | null;
}) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const [name, setName] = useState("");
	const [address, setAddress] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async () => {
		if (busy) return;
		const checked = checkNewMac(macs, { name, address });
		if (!checked.ok) {
			const words = macProblemWords(checked.problem, { macs: MAC_LIMIT, name: MAC_NAME_LIMIT });
			return setError(t(words.key, words.vars));
		}
		setError(null);
		setBusy(true);
		try {
			await addSavedMac({ name: checked.name, address: checked.host });
			toast("success", t("macs.added", { name: checked.name }));
			onClose();
		} catch (e) {
			const problem = e instanceof MacsError ? e.problem : null;
			if (problem) {
				const words = macProblemWords(problem, { macs: MAC_LIMIT, name: MAC_NAME_LIMIT });
				setError(t(words.key, words.vars));
			} else setError(t("macs.addFailed", { error: (e as Error).message }));
			setBusy(false);
		}
	};

	return (
		<Modal
			open
			onOpenChange={(open) => {
				if (!open && !busy) onClose();
			}}
			title={t("macs.addTitle")}
			description={t("macs.addDetail")}
			returnFocusTo={returnFocusTo}
		>
			<form
				className="space-y-3"
				data-testid="mac-add-form"
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<label className="block text-sm font-medium">
					{t("macs.nameLabel")}
					<input
						className={`${field} mt-1 font-normal`}
						data-testid="mac-add-name"
						value={name}
						placeholder={t("macs.namePlaceholder")}
						autoComplete="off"
						spellCheck={false}
						onChange={(e) => setName(e.target.value)}
					/>
				</label>
				<label className="block text-sm font-medium">
					{t("macs.addressLabel")}
					<input
						className={`${field} mt-1 font-normal`}
						data-testid="mac-add-address"
						value={address}
						placeholder={t("macs.addressPlaceholder")}
						inputMode="url"
						autoComplete="off"
						autoCapitalize="off"
						spellCheck={false}
						onChange={(e) => setAddress(e.target.value)}
					/>
				</label>
				{error ? (
					<p className="flex items-start gap-1.5 text-xs text-danger" role="alert" data-testid="mac-add-error">
						<CircleAlert size={14} className="mt-px shrink-0" />
						{error}
					</p>
				) : null}
				<div className="flex justify-end gap-2">
					<Button disabled={busy} onClick={onClose}>
						{t("common.cancel")}
					</Button>
					<Button type="submit" variant="primary" data-testid="mac-add-submit" disabled={busy}>
						{busy ? <Loader2 size={13} className="animate-spin" /> : null}{" "}
						{busy ? t("macs.adding") : t("macs.addSubmit")}
					</Button>
				</div>
			</form>
		</Modal>
	);
}
