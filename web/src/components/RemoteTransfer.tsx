import {
	parseRemoteAccessFile,
	REMOTE_ACCESS_FILE_MAX_BYTES,
	REMOTE_ACCESS_FILE_NAME,
	type RemoteAccessFileProblem,
	remoteAccessFileText,
	type SharedRemoteAccess,
} from "@shared/remote-transfer.ts";
import { CircleAlert, Download, Share2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { Button } from "./ui.tsx";

const PROBLEMS: Record<Exclude<RemoteAccessFileProblem, "invalid">, MessageKey> = {
	"too-large": "remote.transferTooLarge",
	"not-json": "remote.transferNotJson",
	"not-ours": "remote.transferNotOurs",
	version: "remote.transferVersion",
	empty: "remote.transferEmpty",
	"too-many": "remote.transferTooMany",
};

/**
 * Settings › Remote access: hand the team, the AUD tag and the allowed e-mail addresses to another Mac (#628). One Cloudflare
 * Access application with a wildcard domain serves every Mac under it, so the second one needs only its own hostname. The
 * file is made in the page from the settings the server has saved and read back in the page: an import fills the card's form
 * (the person checks it and presses Save, which is the one way the settings change), so it adds no route and no way to change
 * the tunnel that the card does not have already.
 */
export function RemoteTransfer({
	saved,
	onImport,
	onExported,
}: {
	/** What the server has saved: the file is made from this, not from a form that may hold half an edit. */
	saved: SharedRemoteAccess;
	/** The settings of a file that was read and checked: the card puts them in its form. */
	onImport: (settings: SharedRemoteAccess) => void;
	onExported: (name: string) => void;
}) {
	const t = useT();
	const input = useRef<HTMLInputElement>(null);
	const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
	const empty = saved.team === "" && saved.aud === "" && saved.emails.length === 0;

	const exportFile = () => {
		const blob = new Blob([remoteAccessFileText(saved)], { type: "application/json" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = REMOTE_ACCESS_FILE_NAME;
		a.click();
		URL.revokeObjectURL(a.href);
		setNote(null);
		onExported(REMOTE_ACCESS_FILE_NAME);
	};

	const importFile = async (file: File) => {
		// The same file chosen again must be read again: the input is emptied once this file is taken.
		if (input.current) input.current.value = "";
		if (file.size > REMOTE_ACCESS_FILE_MAX_BYTES) return setNote({ error: true, text: t(PROBLEMS["too-large"]) });
		let text: string;
		try {
			text = await file.text();
		} catch (e) {
			return setNote({ error: true, text: t("remote.transferReadFailed", { error: (e as Error).message }) });
		}
		const result = parseRemoteAccessFile(text);
		if (!result.ok) {
			const words =
				result.problem === "invalid"
					? t("remote.transferInvalid", { error: result.message ?? "" })
					: t(PROBLEMS[result.problem]);
			return setNote({ error: true, text: words });
		}
		onImport(result.settings);
		setNote({ error: false, text: t("remote.transferImported") });
	};

	return (
		<div className="mt-3 rounded-xl border border-border bg-bg-soft p-3" data-testid="remote-transfer">
			<div className="flex items-center gap-3">
				<Share2 size={15} className="shrink-0 text-accent" aria-hidden />
				<span className="min-w-0 flex-1 text-sm font-medium">{t("remote.transferTitle")}</span>
			</div>
			<p className="mt-1.5 text-xs text-muted">{t("remote.transferHint")}</p>
			<div className="mt-2.5 flex flex-wrap items-center gap-2">
				<Button size="sm" data-testid="remote-export" disabled={empty} onClick={exportFile}>
					<Download size={13} /> {t("remote.transferExport")}
				</Button>
				<Button size="sm" data-testid="remote-import" onClick={() => input.current?.click()}>
					<Upload size={13} /> {t("remote.transferImport")}
				</Button>
				<input
					ref={input}
					type="file"
					accept="application/json,.json"
					className="sr-only"
					tabIndex={-1}
					aria-hidden
					data-testid="remote-import-file"
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) void importFile(file);
					}}
				/>
			</div>
			{note ? (
				<p
					className={`mt-2 flex items-start gap-1.5 text-xs ${note.error ? "text-danger" : "text-muted"}`}
					role={note.error ? "alert" : "status"}
					data-testid="remote-transfer-note"
					data-error={note.error}
				>
					{note.error ? <CircleAlert size={14} className="mt-px shrink-0" /> : null}
					{note.text}
				</p>
			) : null}
		</div>
	);
}
