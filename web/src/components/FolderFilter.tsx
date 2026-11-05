import * as Popover from "@radix-ui/react-popover";
import { Funnel } from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "../i18n/index.ts";
import { folderLabels, shortPath } from "../lib/format.ts";
import { Button, cx } from "./ui.tsx";

const ROW =
	"flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent max-md:min-h-11";

/**
 * The search bar's folder filter: a funnel that keeps the conversations of one folder (a conversation's working folder,
 * its `cwd`), and the folders themselves, each with how many conversations it has, in one flat list. It is not the
 * sidebar's projects (a project is a named group of conversations, whatever their folders, above the list).
 *
 * The rows are buttons, not options of a listbox: Tab walks the list and Enter chooses, as the native `<select>` this
 * replaced (#415) was reached by Tab once.
 */
export function FolderFilter({
	value,
	onChange,
	total,
	folders,
	home,
}: {
	/** The chosen folder, or `"all"`. */
	value: string;
	onChange: (cwd: string) => void;
	/** Every conversation: the count for "All folders". */
	total: number;
	/** Each folder with its number of conversations, the busiest first. */
	folders: [string, number][];
	home: string | undefined;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const filtered = value !== "all";
	const nameOf = (cwd: string) => shortPath(cwd, home) || "/";
	/** A row says the folder's name (with as much of its parent as tells it from another of that name), its tooltip the whole path. */
	const labels = useMemo(
		() =>
			folderLabels(
				folders.map(([cwd]) => cwd),
				home,
			),
		[folders, home],
	);
	const chosen = filtered ? nameOf(value) : t("shell.sidebarAllFolders", { n: total });
	const choose = (cwd: string) => {
		onChange(cwd);
		setOpen(false);
	};

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button
					type="button"
					aria-label={t("shell.sidebarFolderLabel")}
					title={`${t("shell.sidebarFolderLabel")}: ${chosen}`}
					data-testid="folder-filter"
					data-filtered={filtered ? "true" : undefined}
					className={cx(
						"relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border hover:bg-hover",
						"aria-expanded:bg-hover",
						filtered ? "border-accent/50 bg-accent-soft text-fg" : "border-border bg-surface text-muted hover:text-fg",
					)}
				>
					<Funnel size={14} aria-hidden />
					{filtered ? (
						<span aria-hidden className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-accent ring-2 ring-bg-soft" />
					) : null}
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={6}
					className="z-50 w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-surface p-1 shadow-2xl fade-in"
					data-testid="folder-popover"
				>
					<div className="flex max-h-[min(70vh,32rem)] flex-col">
						<p className="px-2.5 pt-1 pb-1 text-xs font-medium text-faint">{t("shell.sidebarFoldersTitle")}</p>
						<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="folder-scroll">
							<button
								type="button"
								className={cx(ROW, !filtered && "bg-hover font-medium")}
								aria-current={filtered ? undefined : "true"}
								data-testid="folder-all"
								onClick={() => choose("all")}
							>
								<span className="min-w-0 flex-1 truncate">{t("shell.sidebarFoldersAll")}</span>
								<span className="shrink-0 text-xs tabular-nums text-faint">{total}</span>
							</button>
							<ul className="mt-1 space-y-0.5">
								{folders.map(([cwd, count]) => (
									<li key={cwd}>
										<button
											type="button"
											className={cx(ROW, value === cwd && "bg-hover font-medium")}
											title={nameOf(cwd)}
											aria-current={value === cwd ? "true" : undefined}
											data-testid="folder-row"
											data-cwd={cwd}
											onClick={() => choose(cwd)}
										>
											<span className="min-w-0 flex-1 truncate">{labels.get(cwd)}</span>
											<span className="shrink-0 text-xs tabular-nums text-faint">{count}</span>
										</button>
									</li>
								))}
							</ul>
						</div>
						<div className="mt-1 flex justify-end border-t border-border px-1 pt-1">
							<Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
								{t("shell.sidebarFoldersClose")}
							</Button>
						</div>
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
