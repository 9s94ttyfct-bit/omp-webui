import { Command } from "cmdk";
import { Brain, Check, Heart } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { rankModels } from "../lib/model-rank.ts";
import { modelLabel, sharedLabels } from "../lib/models.ts";
import { matches, useShortcutLabel } from "../lib/shortcuts.ts";
import type { ModelInfo } from "../store/live.ts";
import { Mark } from "./Mark.tsx";
import { cx, Kbd } from "./ui.tsx";

/** A model's name; when other models share it, its id too, so they can be told apart. */
export function ModelName({
	model,
	shared,
	positions,
}: {
	model: ModelInfo;
	shared: boolean;
	/** Where the query matched the name: marked, so the row says why it is listed. */
	positions?: readonly number[];
}) {
	return (
		<span className="flex min-w-0 flex-1 flex-col">
			<span className="truncate">
				<Mark text={modelLabel(model)} positions={positions ?? []} />
			</span>
			{shared ? <span className="truncate text-xs text-faint">{model.id}</span> : null}
		</span>
	);
}

/**
 * One row of the list. A listbox option may hold no control, so the heart that loves a model sits beside its option, not
 * in it: `children` gets the row's element to render the heart into (a portal, so the heart appears and goes with its
 * option when the search hides it) and the heart still answers, in React, to the pointer, the keys and the clicks of the
 * option it sits next to.
 */
function ModelRow({ children }: { children: (slot: HTMLElement | null) => ReactNode }) {
	const [slot, setSlot] = useState<HTMLElement | null>(null);
	return (
		<div ref={setSlot} className="group/row relative" data-testid="model-row">
			{children(slot)}
		</div>
	);
}

/**
 * The list of models, searchable: what the model switcher shows once it is opened. It is a chunk of its own, because
 * only the switcher's button is on the page until someone opens it — and the search list (cmdk) is the heavy part.
 *
 * With nothing typed it is the models by group: the loved ones, the ones used recently, then each provider's. With a
 * query it is one list, best match first: the query is matched by `lib/model-rank.ts` against the name, the provider,
 * the id and the names people call the model, and the characters it matched are marked in the name.
 */
export function ModelList({
	models,
	lovedKeys,
	recentKeys,
	current,
	favorites,
	highlight,
	onHighlightChange,
	search,
	onSearchChange,
	onPick,
	onLove,
	onClose,
	listRef,
}: {
	/** Every model omp offers, or null while they are being asked for. */
	models: ModelInfo[] | null;
	/** The models the user loves, by key, newest first. */
	lovedKeys: readonly string[];
	/** The models picked from this browser recently, by key, newest first. */
	recentKeys: readonly string[];
	/** The model the conversation runs on now. */
	current?: ModelInfo;
	/** The models the user loves, by key. */
	favorites: Set<string>;
	/** The row the list points at (cmdk `value`). */
	highlight: string;
	onHighlightChange: (value: string) => void;
	/**
	 * What has been typed in the search field. The field is on the page before the list is: this is what was typed
	 * in the meantime, and the list is searched by it.
	 */
	search: string;
	onSearchChange: (value: string) => void;
	/** Told the model that was chosen. */
	onPick: (model: ModelInfo) => void;
	/** Told the model whose heart was pressed (the heart does not choose the model), and by what. */
	onLove: (model: ModelInfo, by: "key" | "pointer") => void;
	/** The list closes (the model was chosen). */
	onClose: () => void;
	/** The list, so that the caller can bring the highlighted row into view. */
	listRef: RefObject<HTMLDivElement | null>;
}) {
	const t = useT();
	const loveHint = useShortcutLabel("modelLove");
	const key = useCallback((m: ModelInfo) => `${m.provider}/${m.id}`, []);
	const isCurrent = (m: ModelInfo) => current?.id === m.id && current?.provider === m.provider;
	const shared = sharedLabels(models ?? []);
	const query = search.trim();
	/** The ranked rows: with no query, loved, then recent, then the catalog as omp listed it. */
	const ranked = useMemo(
		() => rankModels(models ?? [], query, { loved: lovedKeys, recent: recentKeys }),
		[models, query, lovedKeys, recentKeys],
	);
	/**
	 * What the list shows. Loved models come first, then (with no query) the ones used recently and each provider's under
	 * its name; with a query the rest are one list, best match first, because a date range of groups would cut a ranking
	 * into pieces.
	 */
	const groups = useMemo<[string, ModelInfo[], boolean][]>(() => {
		const out: [string, ModelInfo[], boolean][] = [];
		const loved = ranked.filter((r) => lovedKeys.includes(key(r.model)));
		const lovedSet = new Set(loved.map((r) => r.model));
		const rest = ranked.filter((r) => !lovedSet.has(r.model));
		if (loved.length) out.push([t("panel.modelFavorites"), loved.map((r) => r.model), true]);
		if (query !== "") {
			out.push(["", rest.map((r) => r.model), false]);
			return out;
		}
		const recent = rest.filter((r) => recentKeys.includes(key(r.model)));
		const recentSet = new Set(recent.map((r) => r.model));
		const byProvider = new Map<string, ModelInfo[]>();
		for (const r of rest) {
			if (recentSet.has(r.model)) continue;
			byProvider.set(r.model.provider, [...(byProvider.get(r.model.provider) ?? []), r.model]);
		}
		if (recent.length) out.push([t("panel.modelRecent"), recent.map((r) => r.model), false]);
		for (const [provider, list] of byProvider) out.push([provider, list, false]);
		return out;
	}, [query, ranked, lovedKeys, recentKeys, t, key]);
	/** The mark to draw on a row: only a search that matched the name itself has places to mark. */
	const positionsOf = (m: ModelInfo) => ranked.find((r) => r.model === m)?.positions.label ?? [];

	// A search that hides the highlighted row points the list at its first result: the keyboard must always have a row
	// to take Enter on, and cmdk keeps no selection for a value it cannot find.
	const first = ranked[0]?.model;
	const present = ranked.some((r) => key(r.model) === highlight);
	useEffect(() => {
		if (query === "" || present || !first) return;
		onHighlightChange(key(first));
	}, [query, present, first, onHighlightChange, key]);

	return (
		<Command
			label={t("panel.modelChoose")}
			className="flex max-h-96 flex-col"
			// The ranking is this list's: cmdk's own filter would find a row by its value alone and hide the rest.
			shouldFilter={false}
			value={highlight}
			onValueChange={onHighlightChange}
			onKeyDown={(e) => {
				if (!matches("modelLove", e)) return;
				e.preventDefault();
				const m = (models ?? []).find((x) => key(x) === highlight);
				if (m) onLove(m, "key");
			}}
		>
			<Command.Input
				// The list arrives after the popover has opened, and the popover has already given its focus to its own
				// content: the search field takes it back, or the keyboard would type nowhere.
				autoFocus
				data-testid="model-search"
				// The text is the caller's: what was typed before the list came is in it, and what is typed now goes
				// there too, so the list and the field never disagree.
				value={search}
				onValueChange={onSearchChange}
				placeholder={t("panel.modelSearch")}
				className="mb-1 w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint"
			/>
			<Command.List ref={listRef} label={t("panel.modelChoose")} className="overflow-y-auto">
				{groups.map(([group, list, isLoved]) => (
					<Command.Group
						key={group || "results"}
						heading={group || undefined}
						data-testid={isLoved ? "model-favorites" : undefined}
						className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-faint"
					>
						{list.map((m) => (
							<ModelRow key={key(m)}>
								{(slot) => (
									<Command.Item
										value={key(m)}
										keywords={m.name ? [m.name] : []}
										className="flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-9 pl-2 text-sm data-[selected=true]:bg-hover"
										onSelect={() => {
											onClose();
											// Choosing the model already in use changes nothing (and would only add a model-change note).
											if (isCurrent(m)) return;
											onPick(m);
										}}
									>
										<Check size={14} className={cx(isCurrent(m) ? "opacity-100" : "opacity-0")} />
										<ModelName model={m} shared={shared.has(modelLabel(m))} positions={positionsOf(m)} />
										{m.reasoning ? (
											<Brain size={12} className="text-faint" aria-label={t("panel.modelReasoning")} />
										) : null}
										{slot
											? createPortal(
													<button
														type="button"
														// A pointer's shortcut to what the keyboard and assistive tech do with the key under the list
														// (the hint there), so it is out of the Tab order, or dozens of hearts stand between the search
														// field and the page, and out of the listbox's tree, which may hold only options.
														tabIndex={-1}
														aria-hidden="true"
														aria-pressed={favorites.has(key(m))}
														aria-label={t(favorites.has(key(m)) ? "panel.modelUnlove" : "panel.modelLove", {
															name: modelLabel(m),
														})}
														data-testid="model-love"
														className={cx(
															"absolute top-1/2 right-1.5 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded hover:text-accent",
															favorites.has(key(m))
																? "text-accent"
																: "text-faint opacity-0 group-hover/row:opacity-100 pointer-coarse:opacity-100 group-has-[[data-selected=true]]/row:opacity-100 focus:opacity-100",
														)}
														// Toggle without choosing the model (cmdk selects on click of the option), and without
														// taking focus from the search field, where Enter still chooses the highlighted row.
														onPointerDown={(e) => e.stopPropagation()}
														onMouseDown={(e) => e.preventDefault()}
														// cmdk reads an Enter that reaches its root as "choose the highlighted row".
														onKeyDown={(e) => {
															if (e.key === "Enter") e.stopPropagation();
														}}
														onClick={(e) => {
															e.stopPropagation();
															onLove(m, "pointer");
														}}
													>
														<Heart size={13} fill={favorites.has(key(m)) ? "currentColor" : "none"} />
													</button>,
													slot,
												)
											: null}
									</Command.Item>
								)}
							</ModelRow>
						))}
					</Command.Group>
				))}
			</Command.List>
			{/* Outside the list: a listbox with no option in it (loading, nothing found) may hold only options. */}
			<Command.Empty className="p-3 text-sm text-muted">
				{models ? t("panel.modelNone") : t("common.loading")}
			</Command.Empty>
			{loveHint ? (
				<div
					className="mt-1 flex items-center justify-between gap-2 border-t border-border px-2 pt-1.5 pb-1 text-xs text-faint"
					data-testid="model-love-hint"
				>
					{t("panel.modelLoveHint")}
					<Kbd>{loveHint}</Kbd>
				</div>
			) : null}
		</Command>
	);
}
