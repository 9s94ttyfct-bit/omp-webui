import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, FolderOpen, FolderPlus, History } from "lucide-react";
import { useT } from "../i18n/index.ts";
import { shortPath } from "../lib/format.ts";

/** A folder's own name: the last part of its path (the path itself when it has none, `/`). */
function folderName(path: string): string {
	return path.split("/").filter(Boolean).pop() || path;
}

/**
 * New chat's one folder control, above the composer: it says where the conversation starts (a new project, or the name of
 * the existing folder, its whole path in the tooltip), and its menu holds the other choices: a new project, an existing
 * folder from the folder browser, and up to four folders used recently. The projects folder a new project is made in is
 * changed from the note under the name field, not from here.
 */
export function NewChatFolderMenu({
	existing,
	recent,
	home,
	onNew,
	onWarm,
	onChooseExisting,
	onPick,
}: {
	/** The existing folder the conversation starts in; null: a new project. */
	existing: string | null;
	/** Folders of recent conversations, newest first; the one already chosen is left out here. */
	recent: string[];
	home?: string;
	/** The pointer is on the button: the folder browser's chunk can be fetched now. */
	onWarm?: () => void;
	onNew: () => void;
	onChooseExisting: () => void;
	onPick: (folder: string) => void;
}) {
	const t = useT();
	const others = recent.filter((r) => r !== existing).slice(0, 4);
	const item =
		"flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-hover";
	return (
		<Menu.Root>
			<Menu.Trigger asChild>
				<button
					type="button"
					data-testid="folder-menu"
					data-mode={existing === null ? "new" : "existing"}
					title={existing ?? undefined}
					className="inline-flex min-w-0 max-w-64 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs hover:bg-hover"
					onPointerEnter={onWarm}
				>
					{existing === null ? (
						<FolderPlus size={14} className="shrink-0 text-accent" aria-hidden />
					) : (
						<FolderOpen size={14} className="shrink-0 text-accent" aria-hidden />
					)}
					<span className="truncate">{existing === null ? t("pages.newFolderNew") : folderName(existing)}</span>
					<ChevronDown size={12} className="shrink-0" aria-hidden />
				</button>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Content
					align="start"
					sideOffset={6}
					collisionPadding={8}
					className="z-50 w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-surface p-1 shadow-2xl"
				>
					<Menu.Item data-testid="folder-menu-new" className={item} onSelect={onNew}>
						<FolderPlus size={15} className="shrink-0" aria-hidden />
						{t("pages.newFolderNew")}
					</Menu.Item>
					<Menu.Item data-testid="folder-menu-existing" className={item} onSelect={onChooseExisting}>
						<FolderOpen size={15} className="shrink-0" aria-hidden />
						{t("pages.newFolderExisting")}
					</Menu.Item>
					{others.length ? (
						<>
							<Menu.Separator className="my-1 h-px bg-border" />
							<Menu.Label className="px-2 pt-1 pb-0.5 text-xs font-medium text-faint">
								{t("pages.newFolderRecent")}
							</Menu.Label>
							{others.map((folder) => (
								<Menu.Item
									key={folder}
									data-testid="folder-menu-recent"
									title={folder}
									className={item}
									onSelect={() => onPick(folder)}
								>
									<History size={15} className="shrink-0 text-muted" aria-hidden />
									<span className="min-w-0 flex-1">
										<span className="block truncate">{folderName(folder)}</span>
										<span className="block truncate text-xs text-muted">{shortPath(folder, home)}</span>
									</span>
								</Menu.Item>
							))}
						</>
					) : null}
				</Menu.Content>
			</Menu.Portal>
		</Menu.Root>
	);
}
