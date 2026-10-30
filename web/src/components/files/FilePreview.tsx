import { mentionOf } from "@shared/folder.ts";
import {
	AtSign,
	Check,
	ChevronLeft,
	Code,
	Copy,
	Download,
	Expand,
	ExternalLink,
	Eye,
	FileX,
	FolderSearch,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { insertIntoComposer } from "../../lib/composer-bridge.ts";
import { fmtBytes } from "../../lib/files-rows.ts";
import { type FolderScope, folder } from "../../lib/folder-api.ts";
import { PANEL_SHEET_QUERY, useMediaQuery } from "../../lib/media.ts";
import { useApp } from "../../store/app.ts";
import { openBig } from "../../store/big.ts";
import { keyOf } from "../../store/files.ts";
import { Empty, IconButton, Spinner } from "../ui.tsx";
import { FileBody, FileNotices, useFile } from "./FileBody.tsx";

/**
 * One file, read only: its name and what can be done with it (copy its path, put it in the message as a mention, open it
 * or show it in Finder on this computer, see it large in the main area), and its content as code, rendered Markdown or an
 * SVG (each with its source one click away), an image, or the words that it is a binary file.
 *
 * The body itself is `FileBody`, which the large view (`BigView.tsx`) draws too: one file looks the same in both.
 */
export function FilePreview({
	scope,
	path,
	root,
	reads,
	focusBack,
	onBack,
}: {
	scope: FolderScope;
	path: string;
	/** The conversation's folder, as the server resolved it: a copied path is written under it. */
	root: string | null;
	reads: number;
	/** The file was opened from the keyboard: it arrives on the way back (a click that opens it does not want a tooltip on it). */
	focusBack: boolean;
	onBack: () => void;
}) {
	const t = useT();
	const [loaded] = useFile(scope, path, reads);
	const [source, setSource] = useState(false);
	const [size, setSize] = useState<string | null>(null);
	const section = useRef<HTMLElement>(null);
	const sheet = useMediaQuery(PANEL_SHEET_QUERY);
	// A keyboard user who opened the file from the tree finds themselves at the way back.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per file
	useEffect(() => {
		if (focusBack) section.current?.querySelector<HTMLElement>("[data-back]")?.focus();
		setSource(false);
	}, [path]);
	const slash = path.lastIndexOf("/");
	const name = path.slice(slash + 1);
	const dir = slash < 0 ? "" : path.slice(0, slash);
	const file = loaded.state === "ok" ? loaded.file : null;
	const rendered = file?.kind === "text" && file.view !== "code";
	const toast = useApp((s) => s.toast);
	const run = (reveal: boolean) =>
		folder.open(scope, path, reveal).catch((e: unknown) => {
			toast("error", t("files.openFailed", { error: e instanceof Error ? e.message : String(e) }));
		});
	const transferMode = useApp((s) => s.meta?.fileTransfer);
	/** The transfer code is fetched only when a file is downloaded: nothing of it is in what shows a preview. */
	const download = async () => {
		try {
			const [api, words] = await Promise.all([
				import("../../lib/transfer-api.ts"),
				import("../../lib/transfer-words.ts"),
			]);
			try {
				await api.downloadFile(scope, path);
			} catch (e) {
				if (e instanceof api.TransferError) throw new Error(words.describeFailure(e, name));
				throw e;
			}
		} catch (e) {
			toast("error", t("files.transferDownloadFailed", { reason: e instanceof Error ? e.message : String(e) }));
		}
	};
	const mention = () => {
		const text = mentionOf(path);
		// On a phone the message box is behind the sheet: the mention is put in, but the keyboard is not summoned.
		if (insertIntoComposer(text, !sheet)) toast("success", t("files.mentionInserted", { mention: text }));
		else toast("error", t("files.noComposer"));
	};
	const caption = [dir || null, file ? fmtBytes(file.size) : null, size].filter(Boolean).join(" · ");
	return (
		<section
			ref={section}
			className="flex min-h-0 flex-1 flex-col"
			aria-label={t("files.previewAria", { name })}
			data-testid="file-preview"
			data-path={path}
		>
			<div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
				<IconButton label={t("files.back")} size="sm" data-testid="file-back" data-back="" onClick={onBack}>
					<ChevronLeft size={15} />
				</IconButton>
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-semibold" title={path} data-testid="file-name">
						{name}
					</div>
					{caption ? (
						<div className="truncate text-xs text-faint" title={caption}>
							{caption}
						</div>
					) : null}
				</div>
				{rendered ? (
					<IconButton
						label={source ? t("files.viewRendered") : t("files.viewSource")}
						size="sm"
						data-testid="file-source-toggle"
						active={source}
						aria-pressed={source}
						onClick={() => setSource((s) => !s)}
					>
						{source ? <Eye size={14} /> : <Code size={14} />}
					</IconButton>
				) : null}
				<CopyPath text={root ? `${root.replace(/\/$/, "")}/${path}` : path} />
				<IconButton label={t("files.insertMention")} size="sm" data-testid="file-mention" onClick={mention}>
					<AtSign size={14} />
				</IconButton>
				{file?.local ? (
					<>
						<IconButton
							label={t("files.openDefault")}
							size="sm"
							data-testid="file-open"
							onClick={() => void run(false)}
						>
							<ExternalLink size={14} />
						</IconButton>
						<IconButton
							label={t("files.revealFinder")}
							size="sm"
							data-testid="file-reveal"
							onClick={() => void run(true)}
						>
							<FolderSearch size={14} />
						</IconButton>
					</>
				) : null}
				{transferMode !== undefined && transferMode !== "off" ? (
					<IconButton
						label={t("files.transferDownloadFile")}
						size="sm"
						data-testid="file-download"
						onClick={() => void download()}
					>
						<Download size={14} />
					</IconButton>
				) : null}
				<IconButton
					label={t("files.larger")}
					size="sm"
					data-testid="file-larger"
					onClick={(e) => openBig(keyOf(scope), { kind: "file", path }, e.currentTarget)}
				>
					<Expand size={14} />
				</IconButton>
			</div>
			<FileNotices file={file} source={source} />
			<div className="min-h-0 flex-1 overflow-auto bg-code" data-testid="file-body">
				{loaded.state === "loading" ? (
					<div className="flex justify-center py-10">
						<Spinner />
					</div>
				) : loaded.state === "error" ? (
					<Empty icon={<FileX size={22} />} title={t("files.previewFailedTitle")}>
						{loaded.gone ? t("files.fileGone") : loaded.message}
					</Empty>
				) : (
					<FileBody scope={scope} file={loaded.file} source={source} onSize={setSize} />
				)}
			</div>
		</section>
	);
}

/** Copy `text`, and show that it was copied for a moment. */
function CopyPath({ text }: { text: string }) {
	const t = useT();
	const [done, setDone] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	return (
		<IconButton
			label={done ? t("files.pathCopied") : t("files.copyPath")}
			size="sm"
			data-testid="file-copy-path"
			onClick={() => {
				void navigator.clipboard.writeText(text);
				setDone(true);
				clearTimeout(timer.current);
				timer.current = setTimeout(() => setDone(false), 1200);
			}}
		>
			{done ? <Check size={14} /> : <Copy size={14} />}
		</IconButton>
	);
}
