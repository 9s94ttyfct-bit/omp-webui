import * as Popover from "@radix-ui/react-popover";
import { Funnel } from "lucide-react";
import { Suspense, useState } from "react";
import { useT } from "../i18n/index.ts";
import { lazyChunk } from "../lib/lazy-chunk.ts";
import { useStable } from "../lib/stable.ts";
import { useApp } from "../store/app.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { cx } from "./ui.tsx";

/**
 * The sidebar's project button (#636): a funnel that filters the list by project, and the projects themselves, with the
 * groups the person made.
 *
 * It replaced the native `<select>` #415 put here. That select gave the list, the keyboard and a phone's picker for free, but
 * a select cannot carry a group, a disclosure button or a context menu: the funnel opens this popover instead, which is the
 * platform's list still (`role="listbox"` is not it — see `ProjectList`), and the trigger keeps the accessible name `Project`
 * and its tooltip.
 *
 * Everything but the trigger is a chunk of its own (`ProjectList`): a page that never opens it does not carry the list, the
 * menus or the strings. A chunk that cannot be fetched is a toast and a filter that still says all projects.
 */
const {
	Chunk: List,
	preload: preloadList,
	retry: retryList,
} = lazyChunk(() => import("./ProjectList.tsx").then((m) => ({ default: m.ProjectList })));

/** The list while its chunk loads: a spinner line, the height of a row. */
const Loading = () => (
	<div className="flex h-8 items-center px-2.5" data-testid="project-list-loading" aria-hidden>
		<div className="h-3 w-24 animate-pulse rounded bg-hover" />
	</div>
);

export function ProjectFilter({
	value,
	onChange,
	total,
	projects,
	home,
}: {
	/** The chosen project's folder, or `"all"`. */
	value: string;
	onChange: (cwd: string) => void;
	/** Every conversation: the count for "All projects". */
	total: number;
	/** Each project (its folder) with its number of conversations. */
	projects: [string, number][];
	home: string | undefined;
}) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const groups = useApp((s) => s.projectGroups);
	const [open, setOpen] = useState(false);
	const filtered = value !== "all";
	const nameOf = useStable((cwd: string) => (home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd) || "/");
	const chosen = filtered ? nameOf(value) : t("shell.sidebarAllProjects", { n: total });
	// The rows and their groups are the lazy list's to build (`ProjectList`): this first-page half carries the funnel, the
	// choice it shows and the click, and nothing of how the list is laid out.
	const failed = () => {
		retryList();
		toast("error", t("shell.errorProjectListLoad"));
	};

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button
					type="button"
					// The name #415's select carried, kept: the tooltip that says what is filtered by is unchanged too.
					aria-label={t("shell.sidebarProjectLabel")}
					title={`${t("shell.sidebarProjectLabel")}: ${chosen}`}
					data-testid="project-filter"
					data-filtered={filtered ? "true" : undefined}
					onPointerEnter={preloadList}
					onFocus={preloadList}
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
					data-testid="project-popover"
				>
					<ErrorBoundary fallback={() => null} resetKey={open} onError={failed}>
						<Suspense fallback={<Loading />}>
							<List
								project={filtered ? value : null}
								total={total}
								projects={projects}
								groups={groups}
								home={home}
								onChoose={(cwd) => {
									onChange(cwd ?? "all");
									setOpen(false);
								}}
								onClose={() => setOpen(false)}
							/>
						</Suspense>
					</ErrorBoundary>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
