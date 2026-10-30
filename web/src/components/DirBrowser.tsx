import type { DirListing } from "@shared/dirs.ts";
import { CornerLeftUp, Folder } from "lucide-react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import { errorText } from "../lib/error-text.ts";
import { lazyChunk } from "../lib/lazy-chunk.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { Button, Modal, Spinner } from "./ui.tsx";

// "New project folder" (and the strings it says it with) is a chunk of its own, fetched when the picker first shows it.
const { Chunk: NewProjectFolder, retry: retryNewProject } = lazyChunk(() => import("./NewProjectFolder.tsx"));

/**
 * The folder picker: a path field and the folders under it. A module of its own, because the first page does not need
 * it: it opens a few times in a person's life (a new chat's folder, the projects folder, the folder of a conversation
 * that lost its own), and `NewChat.tsx` loads it when it is first opened.
 */
export function DirBrowser({
	open,
	onOpenChange,
	start,
	onPick,
	title,
	description,
	creatable,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	start: string;
	onPick: (p: string) => void;
	/** What the dialog says it is for, where that is not choosing a folder for a new chat. */
	title?: string;
	description?: string;
	/** Offers "New project folder": a name made into a folder in the projects folder, which is then picked. */
	creatable?: boolean;
}) {
	const t = useT();
	const [listing, setListing] = useState<DirListing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [manual, setManual] = useState("");
	/** The newest listing asked for: a slower answer to an older one is not shown. */
	const latest = useRef(0);
	/** "New project folder"'s form is open: its own Create is the way on, and the dialog's "Use this folder" steps aside (C4). */
	const [creating, setCreating] = useState(false);
	const pathField = useRef<HTMLInputElement>(null);
	// A long path shows its end, the folder that is open (C3): not "/private/var/folders/…" with the name out of sight. After
	// every listing, focused or not: the field has the focus when the dialog opens, and a listing sets its text anew (so
	// anything typed in it is replaced and the caret is at the end, as the scroll is).
	useEffect(() => {
		const field = pathField.current;
		if (field && listing) field.scrollLeft = field.scrollWidth;
	}, [listing]);
	/** List `p`; the listing now shown, or null when it could not be listed (or a newer listing was asked for meanwhile). */
	const go = useCallback(async (p: string): Promise<DirListing | null> => {
		const mine = ++latest.current;
		try {
			const l = await api.dirs(p);
			if (mine !== latest.current) return null;
			setListing(l);
			setManual(l.path);
			setError(null);
			return l;
		} catch (e) {
			if (mine === latest.current) setError(errorText(e));
			return null;
		}
	}, []);
	// What is chosen is the path in the field, listed with Go or not: a pasted path and one click is the natural way.
	const choose = async () => {
		const typed = manual.trim();
		const folder = listing && typed === listing.path ? listing : await go(typed);
		if (!folder) return;
		onPick(folder.path);
		onOpenChange(false);
	};
	useEffect(() => {
		if (!open) return;
		setCreating(false);
		void go(start);
	}, [open, start, go]);
	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			title={title ?? t("pages.newDirTitle")}
			description={description ?? t("pages.newDirDesc")}
		>
			<form
				className="mb-2 flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void go(manual);
				}}
			>
				<input
					ref={pathField}
					aria-label={t("pages.newPathAria")}
					value={manual}
					onChange={(e) => setManual(e.target.value)}
					className="min-w-0 flex-1 rounded-lg border border-border bg-bg-soft px-2.5 py-1.5 font-mono text-xs outline-none focus:border-faint"
				/>
				<Button size="sm" type="submit">
					{t("pages.newGo")}
				</Button>
			</form>
			{error ? <div className="mb-2 text-xs text-danger">{error}</div> : null}
			<div className="max-h-80 overflow-y-auto rounded-lg border border-border">
				{listing ? (
					<>
						<button
							type="button"
							data-testid="dir-up"
							className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted hover:bg-hover"
							onClick={() => void go(listing.parent)}
						>
							<CornerLeftUp size={14} aria-hidden />
							<span className="min-w-0 truncate">{t("pages.newDirUp", { name: folderName(listing.parent) })}</span>
						</button>
						{listing.dirs.map((d) => (
							<button
								type="button"
								key={d}
								className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-hover"
								onClick={() => void go(`${listing.path}/${d}`)}
							>
								<Folder size={14} className="text-accent" /> {d}
							</button>
						))}
					</>
				) : error ? null : (
					<div className="flex justify-center p-6">
						<Spinner />
					</div>
				)}
			</div>
			{listing && listing.omitted > 0 ? (
				<div className="mt-1 text-xs text-muted" data-testid="dir-omitted">
					{t("pages.newDirOmitted", { shown: listing.dirs.length, n: listing.omitted })}
				</div>
			) : null}
			{creatable ? (
				<ErrorBoundary fallback={() => null} onError={retryNewProject}>
					<Suspense fallback={null}>
						<NewProjectFolder
							onFormOpen={setCreating}
							onCreated={(path) => {
								onPick(path);
								onOpenChange(false);
							}}
						/>
					</Suspense>
				</ErrorBoundary>
			) : null}
			{creating ? null : (
				<div className="mt-3 flex justify-end gap-2">
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						{t("common.cancel")}
					</Button>
					<Button variant="primary" disabled={!manual.trim()} onClick={() => void choose()}>
						{t("pages.newUseFolder")}
					</Button>
				</div>
			)}
		</Modal>
	);
}

/** The last name of a path ("/" for the root): what "Up to …" names. */
function folderName(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.at(-1) ?? path;
}
