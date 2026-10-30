import { type CSSProperties, useEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import type { IndexEntry } from "../lib/section-index.ts";
import { SETTINGS_PAGE_LABEL } from "../lib/settings-page-labels.ts";
import { SETTINGS_PAGES, type SettingsPageId } from "../lib/settings-pages.ts";
import { ScrollRow } from "./ScrollRow.tsx";
import { cx } from "./ui.tsx";

/**
 * The list of Settings' pages (v0.11.18 §10), with the cards of the page shown under its name. Where the page is wide
 * enough to leave a margin beside its column, it hangs in that margin and stays in view while the page scrolls; it is
 * never taller than the page's box and scrolls by itself. Below that it is two rows under the title, which stay at the
 * top of the page: the pages' names, then the shown page's cards as chips. Which one shows is decided by the room the
 * page's own box has (a container query, not the window: the sidebar takes room too).
 */
export function SettingsIndex({
	page,
	onPage,
	entries,
	current,
	onGo,
	scroller,
}: {
	page: SettingsPageId;
	onPage: (page: SettingsPageId) => void;
	/** The cards of the page shown. */
	entries: IndexEntry[];
	current: HTMLElement | null;
	onGo: (entry: IndexEntry) => void;
	/** The page's scroller: the list in the margin is kept within its height. */
	scroller: HTMLElement | null;
}) {
	const t = useT();
	const list = useRef<HTMLUListElement>(null);
	// The list hangs 2rem under the top of the page and keeps 1rem clear of its bottom.
	const [room, setRoom] = useState<number | undefined>(undefined);
	useEffect(() => {
		if (!scroller) return;
		const measure = () => setRoom(Math.max(160, scroller.clientHeight - 48));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(scroller);
		return () => observer.disconnect();
	}, [scroller]);
	// Keep the shown page's name and the current card's entry in their lists' view, without moving the page
	// (scrollIntoView would): sideways in the rows of a narrow page, up and down in the margin's list.
	const cardRow = useRef<HTMLUListElement>(null);
	useEffect(() => {
		const sideways = (row: HTMLElement | null, chip: HTMLElement | null | undefined) => {
			if (!row || !chip || row.scrollWidth <= row.clientWidth) return;
			const left = chip.offsetLeft;
			if (left < row.scrollLeft || left + chip.offsetWidth > row.scrollLeft + row.clientWidth)
				row.scrollTo({ left: left - 16, behavior: "smooth" });
		};
		const pages = list.current;
		sideways(pages, pages?.querySelector<HTMLElement>(`[data-page="${page}"]`));
		sideways(cardRow.current, cardRow.current?.querySelector<HTMLElement>('[aria-current="true"]'));
		if (pages && pages.scrollHeight > pages.clientHeight) {
			const entry = current ? pages.querySelector<HTMLElement>('[aria-current="true"]') : null;
			if (!entry) return;
			const top = entry.offsetTop;
			if (top < pages.scrollTop || top + entry.offsetHeight > pages.scrollTop + pages.clientHeight)
				pages.scrollTo({ top: top - pages.clientHeight / 2, behavior: "smooth" });
		}
	}, [current, page]);
	return (
		<nav
			aria-label={t("pages.settingsSections")}
			data-testid="settings-index"
			className="sticky top-0 z-10 -mx-6 border-b border-border bg-bg px-6 @min-[65rem]:top-8 @min-[65rem]:-order-3 @min-[65rem]:-mb-6 @min-[65rem]:mx-0 @min-[65rem]:h-0 @min-[65rem]:border-0 @min-[65rem]:bg-transparent @min-[65rem]:px-0"
		>
			<ScrollRow
				ref={list}
				style={{ "--index-room": room === undefined ? undefined : `${room}px` } as CSSProperties}
				wrapperClassName="@min-[65rem]:static"
				className="relative flex gap-1 overflow-x-auto py-2 [scrollbar-width:none] @min-[65rem]:absolute @min-[65rem]:top-0 @min-[65rem]:right-full @min-[65rem]:mr-6 @min-[65rem]:max-h-(--index-room) @min-[65rem]:w-44 @min-[65rem]:flex-col @min-[65rem]:gap-0.5 @min-[65rem]:overflow-x-hidden @min-[65rem]:overflow-y-auto @min-[65rem]:overscroll-contain @min-[65rem]:py-0 @min-[65rem]:[scrollbar-width:thin]"
			>
				{SETTINGS_PAGES.map((p) => {
					const here = p === page;
					return (
						<li key={p} className="shrink-0 @min-[65rem]:shrink">
							<button
								type="button"
								data-testid="settings-page-tab"
								data-page={p}
								aria-current={here ? "page" : undefined}
								onClick={() => onPage(p)}
								className={cx(
									"inline-flex h-8 items-center rounded-lg px-2.5 text-xs whitespace-nowrap hover:bg-hover @min-[65rem]:w-full @min-[65rem]:justify-start @min-[65rem]:text-sm",
									here ? "bg-hover font-semibold text-fg" : "text-muted hover:text-fg",
								)}
							>
								<span className="truncate">{t(SETTINGS_PAGE_LABEL[p])}</span>
							</button>
							{here && entries.length ? (
								// The page's cards, under its name: only where there is a margin for them.
								<ul className="ml-3 hidden border-l border-border py-1 pl-2 @min-[65rem]:block">
									{entries.map((entry) => (
										<li key={entry.key}>
											<button
												type="button"
												data-testid="settings-index-entry"
												aria-current={entry.el === current ? "true" : undefined}
												title={entry.title}
												onClick={() => onGo(entry)}
												className={cx(
													"flex h-7 w-full items-center rounded-md px-2 text-left text-xs hover:bg-hover",
													entry.el === current ? "font-medium text-fg" : "text-muted hover:text-fg",
												)}
											>
												<span className="truncate">{entry.title}</span>
											</button>
										</li>
									))}
								</ul>
							) : null}
						</li>
					);
				})}
			</ScrollRow>
			{/* A narrow page has no margin: its cards are a row of chips under the row of pages. */}
			{entries.length ? (
				<ScrollRow ref={cardRow} className="flex gap-1 overflow-x-auto pb-2 [scrollbar-width:none] @min-[65rem]:hidden">
					{entries.map((entry) => (
						<li key={entry.key} className="shrink-0">
							<button
								type="button"
								data-testid="settings-index-chip"
								aria-current={entry.el === current ? "true" : undefined}
								onClick={() => onGo(entry)}
								className={cx(
									"inline-flex h-8 items-center rounded-full border px-3 text-xs whitespace-nowrap",
									entry.el === current
										? "border-accent bg-accent-soft text-fg"
										: "border-border text-muted hover:bg-hover hover:text-fg",
								)}
							>
								{entry.title}
							</button>
						</li>
					))}
				</ScrollRow>
			) : null}
		</nav>
	);
}
