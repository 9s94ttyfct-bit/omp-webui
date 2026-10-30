import { Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { SETTINGS_PAGE_LABEL } from "../lib/settings-page-labels.ts";
import { pageOfElement } from "../lib/settings-pages.ts";
import { flattenSettings, type SettingGroup, type SettingHit, searchSettings } from "../lib/settings-search.ts";
import { cx } from "./ui.tsx";

/** The name of the Settings page a result's card is on, for the line over its group ("Safety › Guard"). */
function pageName(entry: SettingHit["entry"], t: ReturnType<typeof useT>): string | null {
	const el = document.querySelector(entry.target);
	const page = el ? pageOfElement(el) : null;
	return page ? t(SETTINGS_PAGE_LABEL[page]) : null;
}

/**
 * The search at the top of Settings: one field that finds every setting on the page by the name it is shown under, the
 * sentence under it, and the names people use for it (in English and in Chinese, so `dark` finds 深色 and `深色` finds
 * Dark), on every one of Settings' pages. The results are grouped by the card they are on, under the page's name; Enter
 * or a click shows that page, jumps to the setting and marks it, and the keyboard moves through the results with the
 * arrow keys.
 *
 * It is a search and not a filter of the page: the page keeps every card, and a result takes the reader to one of them.
 * `onGo` is the jump; what marking the target looks like is the page's (see `SettingsPage`).
 */
export function SettingsSearch({ onGo }: { onGo: (entry: SettingHit["entry"]) => void }) {
	const t = useT();
	const [query, setQuery] = useState("");
	/**
	 * The result the person chose (arrow keys, a pointer moving over it, a result they went to), by the entry's id; "" is
	 * none, and then the keyboard is on the first result, whatever the first is now. Results change for the same query
	 * when a card that loads by itself (Unattended mode, Sleep, …) arrives, so only a choice is kept across them (#679).
	 */
	const [chosen, setChosen] = useState("");
	const field = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const root = useRef<HTMLDivElement>(null);
	/** Goes up when Settings' cards change while a query is typed: a card that has just loaded is a result now. */
	const [cardsVersion, setCardsVersion] = useState(0);
	const searching = query.trim() !== "";
	useEffect(() => {
		const page = root.current?.closest('[data-testid="settings-page"]');
		if (!searching || !page) return;
		let frame = 0;
		const observer = new MutationObserver(() => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				setCardsVersion((v) => v + 1);
			});
		});
		// A card that loads by itself appears somewhere inside its page's part; watching the parts leaves the search's own
		// list out.
		for (const part of page.querySelectorAll("[data-settings-page]"))
			observer.observe(part, { childList: true, subtree: true });
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [searching]);
	// A card that is not on the page is not a place a result could go: the guard is absent through the tunnel, quitting in
	// a browser, a card that loads by itself until it has loaded.
	const available = useCallback((entry: SettingHit["entry"]) => document.querySelector(entry.target) !== null, []);
	// The catalogue's words change with the language: `t` is the language's, so a search is redone when it changes, and
	// when a card arrives.
	// biome-ignore lint/correctness/useExhaustiveDependencies: cardsVersion is the signal that `available` answers differently now
	const groups = useMemo<SettingGroup[]>(
		() => searchSettings(query, (key) => t(key), { available }),
		[query, t, available, cardsVersion],
	);
	const flat = useMemo(() => flattenSettings(groups), [groups]);
	const count = flat.length;
	const activeHit = (chosen !== "" ? flat.find((hit) => hit.entry.id === chosen) : undefined) ?? flat[0] ?? null;
	const active = activeHit?.entry.id ?? "";
	// Keep the keyboard's result in view (a list of ten fits, a phone's does not).
	useEffect(() => {
		if (active === "") return;
		list.current?.querySelector<HTMLElement>(`[data-entry="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);
	const close = () => {
		setQuery("");
		setChosen("");
		field.current?.focus();
	};
	const go = (hit: SettingHit) => {
		onGo(hit.entry);
		// The search stays where it is, with what was typed: a reader looks at one result and comes back for the next.
		setChosen(hit.entry.id);
	};
	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape" && query !== "") {
			e.preventDefault();
			e.stopPropagation();
			close();
			return;
		}
		if (count === 0) return;
		const at = flat.findIndex((hit) => hit.entry.id === active);
		const move = (to: number) => {
			e.preventDefault();
			const hit = flat[(to + count) % count];
			if (hit) setChosen(hit.entry.id);
		};
		if (e.key === "ArrowDown") return move(at < 0 ? 0 : at + 1);
		if (e.key === "ArrowUp") return move(at < 0 ? count - 1 : at - 1);
		if (e.key === "Home") return move(0);
		if (e.key === "End") return move(count - 1);
		if (e.key === "Enter" && activeHit) {
			e.preventDefault();
			go(activeHit);
		}
	};
	return (
		// `relative`: the results hang under the field, over the cards, and move no card.
		<div ref={root} className="relative" data-testid="settings-search">
			<div className="flex items-center gap-2 rounded-xl border border-border bg-surface pr-2 pl-3 focus-within:border-accent">
				<Search size={15} className="shrink-0 text-faint" aria-hidden />
				<input
					ref={field}
					type="search"
					role="combobox"
					aria-expanded={count > 0}
					aria-controls="settings-search-results"
					aria-autocomplete="list"
					aria-activedescendant={activeHit ? `settings-search-${activeHit.entry.id}` : undefined}
					aria-label={t("pages.settingsSearchLabel")}
					data-testid="settings-search-input"
					placeholder={t("pages.settingsSearchPlaceholder")}
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						// A new query starts on its first result.
						setChosen("");
					}}
					onKeyDown={onKeyDown}
					// The field is what a person comes to Settings' top for; the browser's own search box would find the label,
					// not the setting, so the field is the page's.
					// The field has its own clear button (below): the browser's blue × beside it was a second one.
					className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none [&::-webkit-search-cancel-button]:hidden"
				/>
				{query !== "" ? (
					<button
						type="button"
						onClick={close}
						aria-label={t("pages.settingsSearchClear")}
						data-testid="settings-search-clear"
						className="inline-flex size-6 shrink-0 items-center justify-center rounded text-faint hover:bg-hover hover:text-fg"
					>
						<X size={14} />
					</button>
				) : null}
			</div>
			{searching ? (
				<div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
					{count === 0 ? (
						<p className="px-3 py-3 text-sm text-muted" data-testid="settings-search-empty">
							{t("pages.settingsSearchNoResults", { q: query.trim() })}
						</p>
					) : (
						<>
							<div
								ref={list}
								id="settings-search-results"
								role="listbox"
								aria-label={t("pages.settingsSearchLabel")}
								data-testid="settings-search-results"
								className="max-h-[min(60vh,26rem)] overflow-y-auto p-1"
							>
								{groups.map((group) => (
									<div key={group.group}>
										<div className="px-2 pt-2 pb-1 text-xs font-medium text-faint" aria-hidden>
											{[pageName(group.hits[0].entry, t), group.title].filter(Boolean).join(" › ")}
										</div>
										{group.hits.map((hit) => {
											const on = hit.entry.id === active;
											const label = t(hit.entry.label);
											const hint = hit.entry.hint ? t(hit.entry.hint) : "";
											return (
												<button
													key={hit.entry.id}
													id={`settings-search-${hit.entry.id}`}
													type="button"
													role="option"
													aria-selected={on}
													data-entry={hit.entry.id}
													data-testid="settings-search-result"
													// The keyboard is the field's (the list is its popup): the buttons are not in the Tab order, or
													// every result would stand between the field and the page, and the letters typed next would go
													// nowhere. A pointer that moves over a result moves the field's place, so Enter takes what is under
													// it. Only a move: the list opening under a pointer that rests there is not a choice (#679).
													tabIndex={-1}
													onPointerMove={() => {
														if (!on) setChosen(hit.entry.id);
													}}
													onClick={() => go(hit)}
													className={cx(
														"block w-full cursor-pointer rounded-lg px-2 py-1.5 text-left text-sm",
														on ? "bg-hover text-fg" : "text-muted",
													)}
												>
													<span className="block truncate font-medium">{label}</span>
													{/* The sentence says what the setting does; the group above says which card it is on. */}
													{hint ? <span className="block truncate text-xs text-faint">{hint}</span> : null}
												</button>
											);
										})}
									</div>
								))}
							</div>
							<div className="flex items-center justify-between gap-2 border-t border-border px-3 py-1.5 text-xs text-faint">
								<span data-testid="settings-search-count">{t("pages.settingsSearchCount", { n: count })}</span>
								<span>{t("pages.settingsSearchHint")}</span>
							</div>
						</>
					)}
				</div>
			) : null}
		</div>
	);
}
