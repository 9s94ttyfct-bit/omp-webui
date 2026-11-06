import * as Popover from "@radix-ui/react-popover";
import type { BrowserDownload, DownloadState } from "@shared/browser-protocol.ts";
import { Download } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { formatBytes } from "../lib/app-update.ts";
import { useApp } from "../store/app.ts";
import { sendScreen, useScreen } from "../store/browser-screen.ts";
import { Button, cx } from "./ui.tsx";

const NONE: BrowserDownload[] = [];
/** A size as the list shows it: bytes below a kilobyte (a small file is not "0 KB"). */
const sizeOf = (bytes: number) => (bytes < 1024 ? `${bytes} B` : formatBytes(bytes));

/**
 * The downloads of a conversation's pages (docs/agents/browser.md, "Downloads"): a button in the Browser tab's toolbar,
 * once there is one, with how many are running, and a list of them. A running one can be cancelled; a finished one is
 * shown in Finder from a page on the Mac it was saved on, and fetched to the device from any other page. A download that
 * starts, finishes or fails while the tab is shown says so in a toast.
 */
export function BrowserDownloads({ owner }: { owner: string }) {
	const t = useT();
	const received = useScreen((s) => s.downloads.owner === owner);
	const list = useScreen((s) => (s.downloads.owner === owner ? s.downloads.list : NONE));
	const local = useScreen((s) => s.downloads.local);
	const [open, setOpen] = useState(false);
	const titleId = useId();
	useToasts(owner, received, list);

	if (list.length === 0) return null;
	const running = list.filter((d) => d.state === "progress").length;
	const label = running ? t("browser.downloadsRunning", { n: running }) : t("browser.downloads");
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button
					type="button"
					aria-label={label}
					title={label}
					data-testid="browser-downloads"
					className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg aria-expanded:bg-hover"
				>
					<Download size={15} aria-hidden />
					{running ? (
						<span
							aria-hidden
							className="absolute -top-1 -right-1 min-w-4 rounded-full bg-accent px-1 text-center text-xs leading-4 text-accent-fg tabular-nums"
						>
							{running}
						</span>
					) : null}
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={6}
					aria-labelledby={titleId}
					className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-surface p-1 shadow-2xl fade-in"
					data-testid="browser-downloads-list"
				>
					<div className="flex max-h-[min(70vh,28rem)] flex-col">
						<p id={titleId} className="px-2.5 pt-1 pb-1 text-xs font-medium text-faint">
							{t("browser.downloadsTitle")}
						</p>
						<ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain">
							{list.map((d) => (
								<Row key={d.id} d={d} local={local} />
							))}
						</ul>
						<div className="mt-1 flex justify-end border-t border-border px-1 pt-1">
							<Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
								{t("browser.downloadsClose")}
							</Button>
						</div>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

function Row({ d, local }: { d: BrowserDownload; local: boolean }) {
	const t = useT();
	// A page that is not on this Mac fetches a file only when File transfer lets it, as the Files tab's downloads.
	const fetchable = useApp((s) => s.meta?.fileTransfer !== undefined && s.meta.fileTransfer !== "off");
	const percent = d.total ? Math.min(100, Math.floor((d.received / d.total) * 100)) : null;
	const status =
		d.state === "progress"
			? d.total
				? `${sizeOf(d.received)} / ${sizeOf(d.total)}`
				: sizeOf(d.received)
			: d.state === "done"
				? t("browser.downloadSaved", { size: sizeOf(d.total ?? d.received) })
				: d.state === "cancelled"
					? t("browser.downloadCancelled")
					: t("browser.downloadFailed", { error: d.error ?? "" });
	return (
		<li className="rounded-md px-2 py-1.5 hover:bg-hover" data-testid="browser-download" data-state={d.state}>
			<div className="flex min-h-7 items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-sm" title={d.name}>
					{d.name}
				</span>
				{d.state === "progress" ? (
					<Button
						size="sm"
						variant="ghost"
						aria-label={t("browser.downloadCancelOne", { name: d.name })}
						onClick={() => sendScreen({ t: "download_cancel", id: d.id })}
						data-testid="browser-download-cancel"
					>
						{t("browser.downloadCancel")}
					</Button>
				) : null}
				{d.state === "done" && local ? (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => sendScreen({ t: "download_reveal", id: d.id })}
						data-testid="browser-download-reveal"
					>
						{t("browser.downloadReveal")}
					</Button>
				) : null}
				{d.state === "done" && !local && fetchable ? (
					<a
						href={`/api/browser/downloads/${encodeURIComponent(d.id)}/file`}
						download={d.name}
						className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs text-accent hover:bg-hover hover:underline"
						data-testid="browser-download-fetch"
					>
						{t("browser.downloadFetch")}
					</a>
				) : null}
			</div>
			{d.state === "progress" ? (
				<div
					role="progressbar"
					aria-label={d.name}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent ?? undefined}
					className="mt-1 h-1 overflow-hidden rounded-full bg-hover"
				>
					<div
						className={cx("h-full rounded-full bg-accent", percent === null && "w-1/3 animate-pulse")}
						style={percent === null ? undefined : { width: `${percent}%` }}
					/>
				</div>
			) : null}
			<p className={cx("mt-0.5 text-xs tabular-nums", d.state === "failed" ? "text-danger" : "text-faint")}>{status}</p>
		</li>
	);
}

/**
 * A toast when one of the conversation's downloads starts, finishes or fails. The list the tab is first given (on
 * opening it, or after the connection came back) says nothing new: only what changes after it is told.
 */
function useToasts(owner: string, received: boolean, list: BrowserDownload[]): void {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const seen = useRef<{ owner: string; states: Map<string, DownloadState> } | null>(null);
	useEffect(() => {
		if (!received) {
			seen.current = null;
			return;
		}
		const before = seen.current?.owner === owner ? seen.current.states : null;
		seen.current = { owner, states: new Map(list.map((d) => [d.id, d.state])) };
		if (!before) return;
		for (const d of list) {
			const was = before.get(d.id);
			if (was === d.state) continue;
			if (d.state === "progress") {
				if (!was) toast("info", t("browser.downloadStarted", { name: d.name }));
			} else if (d.state === "done") toast("success", t("browser.downloadFinished", { name: d.name }));
			else if (d.state === "failed") toast("error", t("browser.downloadFailedToast", { name: d.name }));
		}
	}, [owner, received, list, toast, t]);
}
