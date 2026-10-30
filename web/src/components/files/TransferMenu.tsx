import * as Popover from "@radix-ui/react-popover";
import { ArrowDownUp } from "lucide-react";
import { type DragEvent, lazy, Suspense, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "../../i18n/index.ts";
import type { FolderScope } from "../../lib/folder-api.ts";
import { carriesFiles, takeTransfer } from "../../lib/transfer-take.ts";
import { IconButton, Spinner } from "../ui.tsx";

/**
 * The Files tab's way into moving files (#614): the Transfer button with its panel, and the drop of files and folders on
 * the tab. Only this file and `lib/transfer-take.ts` are in the tab's own chunk; the panel, the conversation's uploads and
 * the client library are one more chunk (`TransferPanel.tsx`), fetched when the button is used or a drag that carries
 * files first comes over the tab.
 */
const loadTransfer = () => import("./TransferPanel.tsx");

/** Set once the chunk is here, and who is waiting to know (`useTransferLoaded`). */
let ready = false;
const listeners = new Set<() => void>();

/** Fetch the transfer chunk (once; the same promise answers every later call). */
export function ensureTransfer() {
	return loadTransfer().then((m) => {
		if (!ready) {
			ready = true;
			for (const listener of listeners) listener();
		}
		return m;
	});
}

/** Whether the transfer chunk has been fetched: what only it can show (the question about files that are there) is not asked for before. */
export function useTransferLoaded(): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => ready,
	);
}

const TransferPanel = lazy(() => loadTransfer());
export const TransferDialogs = lazy(() => loadTransfer().then((m) => ({ default: m.TransferConflict })));

/** The button, and the panel it opens. `target` is the folder uploads go to and a ZIP is made of. */
export function TransferMenu({
	scope,
	target,
	canUpload,
	open,
	onOpenChange,
}: {
	scope: FolderScope;
	target: string;
	canUpload: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useT();
	// The popover stays inside the panel it was opened from (a phone's sheet is narrower than the popover is wide): the
	// panel names itself as the boundary. Content is only drawn while open, after this ref is set.
	const anchor = useRef<HTMLSpanElement>(null);
	return (
		<Popover.Root open={open} onOpenChange={onOpenChange}>
			<span ref={anchor} className="contents">
				<Popover.Trigger asChild>
					<IconButton
						label={t("files.transferButton")}
						size="sm"
						active={open}
						data-testid="files-transfer"
						onPointerEnter={() => void ensureTransfer()}
						onFocus={() => void ensureTransfer()}
					>
						<ArrowDownUp size={14} />
					</IconButton>
				</Popover.Trigger>
			</span>
			<Popover.Portal>
				<Popover.Content
					side="bottom"
					align="end"
					sideOffset={6}
					collisionBoundary={anchor.current?.closest("[data-popover-boundary]") ?? undefined}
					collisionPadding={8}
					aria-label={t("files.transferTitle")}
					data-testid="transfer-panel"
					// The question about files that are there opens over the panel; the list of uploads stays under it.
					onInteractOutside={(e) => {
						const target = e.target instanceof Element ? e.target : null;
						if (target?.closest('[role="dialog"]')?.querySelector('[data-testid="transfer-conflict"]'))
							e.preventDefault();
					}}
					className="z-50 max-h-[min(34rem,calc(100vh-4rem))] w-[22rem] max-w-(--radix-popover-content-available-width) overflow-y-auto rounded-2xl border border-border bg-surface p-3 shadow-2xl outline-none"
				>
					<Suspense
						fallback={
							<div className="flex justify-center py-6">
								<Spinner />
							</div>
						}
					>
						<TransferPanel scope={scope} target={target} canUpload={canUpload} />
					</Suspense>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/** Where a drag is over the tab: the folder a drop would go to, and the row it is over when that row is a folder. */
export interface DropOver {
	dest: string;
	row: string | null;
}

/** The folder a row stands for when files are dropped on it: a folder itself, the folder around a file. */
function rowDir(target: EventTarget | null): string | null {
	const row = target instanceof Element ? target.closest<HTMLElement>('[role="treeitem"][data-path]') : null;
	const path = row?.dataset.path;
	if (path === undefined) return null;
	if (row?.dataset.kind === "dir") return path;
	return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

/**
 * Files dragged over the tab: it takes them when uploads are on for this page (`enabled`). A drop on a folder row goes into
 * that folder, a drop anywhere else into `target`. The handlers are for the element that holds the tab; a drag that carries
 * no files is left alone (text is not for the upload). A handled drop is stopped here, so the window's guard
 * (`lib/drop-guard.ts`) does not refuse it.
 */
export function useTransferDrop({
	scope,
	enabled,
	target,
	onTaken,
}: {
	scope: FolderScope;
	enabled: boolean;
	target: string;
	/** A drop was taken: the panel is shown, with the uploads in it. */
	onTaken: () => void;
}) {
	const [over, setOver] = useState<DropOver | null>(null);
	const depth = useRef(0);
	const accepts = (e: DragEvent) => enabled && carriesFiles(e.dataTransfer);
	const where = (e: DragEvent): DropOver => {
		const dir = rowDir(e.target);
		const row =
			e.target instanceof Element ? e.target.closest<HTMLElement>('[role="treeitem"][data-kind="dir"]') : null;
		return { dest: dir ?? target, row: row?.dataset.path ?? null };
	};
	const handlers = {
		onDragEnter(e: DragEvent) {
			if (!accepts(e)) return;
			e.preventDefault();
			depth.current++;
			void ensureTransfer();
		},
		onDragOver(e: DragEvent) {
			if (!accepts(e)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			const next = where(e);
			setOver((prev) => (prev && prev.dest === next.dest && prev.row === next.row ? prev : next));
		},
		onDragLeave(e: DragEvent) {
			if (!accepts(e)) return;
			depth.current = Math.max(0, depth.current - 1);
			if (depth.current === 0) setOver(null);
		},
		onDrop(e: DragEvent) {
			if (!accepts(e)) return;
			e.preventDefault();
			e.stopPropagation();
			depth.current = 0;
			const dest = where(e).dest;
			setOver(null);
			// The entries are taken now: the data of the event is cleared when this handler returns.
			const taken = takeTransfer(e.dataTransfer);
			onTaken();
			void ensureTransfer().then((m) => m.dropUpload(scope, dest, taken));
		},
	};
	return { over: enabled ? over : null, handlers };
}
