import * as Popover from "@radix-ui/react-popover";
import { runsLocal } from "@shared/offline.ts";
import { Brain, ChevronDown, Cpu } from "lucide-react";
import { type ReactNode, Suspense, use, useCallback, useEffect, useRef, useState } from "react";
import { type MessageKey, t as translate, useT, type Vars } from "../i18n/index.ts";
import { sessionActions } from "../lib/api.ts";
import { lazyChunk } from "../lib/lazy-chunk.ts";
import { useModelCatalog } from "../lib/model-config.ts";
import { noteRecentModel, onRecentModels, recentModels } from "../lib/model-recent.ts";
import { levelsFor, modelLabel, withAuto } from "../lib/models.ts";
import type { PickedModel } from "../lib/new-chat-picks.ts";
import { type StartLive, useOpenAfterStart } from "../lib/start-live.ts";
import { ReplyError, socket } from "../lib/ws.ts";
import { noteThinking, useApp } from "../store/app.ts";
import type { ModelInfo } from "../store/live.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { ModelSearch } from "./ModelSearch.tsx";
import { Select } from "./Select.tsx";
import { Spinner } from "./ui.tsx";

const modelCache = new Map<string, ModelInfo[]>();

// The list of models is a chunk of its own: only the switcher's button is on the page until someone opens it, and the
// search list is the heavy part. The button fetches it ahead (`preloadModelList`), when the pointer is on it and when
// it takes the focus, so that it is usually there by the time the button is pressed; what is typed before it comes is
// kept (see `ModelSearch`).
const {
	Chunk: ModelList,
	preload: preloadModelList,
	retry: retryModelList,
} = lazyChunk(() => import("./ModelList.tsx").then((m) => ({ default: m.ModelList })));

/**
 * Puts off what is in it while `hold` is set. It suspends, so that the field standing in for the list stays where it is.
 */
function HeldBy({ hold, children }: { hold: Promise<void> | null; children: ReactNode }) {
	if (hold) use(hold);
	return children;
}

/**
 * The composer's model switcher. `liveId` is null while the conversation has no running omp (a saved one): the list
 * comes from omp, so the first click starts it (`start`) and the list opens once it runs. `current` is then the
 * model the transcript leaves, which is the one omp restores.
 */
export function ModelPicker({
	liveId,
	current,
	start,
	onPick,
}: {
	liveId: string | null;
	current?: ModelInfo;
	start?: StartLive;
	/** Told which model was set, once omp has taken it: New chat keeps the choice for the processes it starts later. */
	onPick?: (model: PickedModel) => void;
}) {
	const { open, starting, request } = useOpenAfterStart(liveId, start);
	const [models, setModels] = useState<ModelInfo[] | null>((liveId ? modelCache.get(liveId) : undefined) ?? null);
	/** The row the list points at (cmdk `value`). It opens on the current model, not the first row. */
	const [highlight, setHighlight] = useState("");
	/**
	 * What has been typed in the search field. The field is here, not in the list's chunk: the list is fetched when
	 * the button is pressed, and what is typed in the meantime must not be lost. The list is given this text.
	 */
	const [search, setSearch] = useState("");
	/**
	 * Set while a composition (an input method building one character from several keys) goes on in the field that
	 * stands in for the list. The list is not put in its place until it is over: a composition cannot move from one
	 * field to another, and the half-built text it leaves behind would stay in the search.
	 */
	const [hold, setHold] = useState<Promise<void> | null>(null);
	const release = useRef<(() => void) | null>(null);
	const settling = useRef<number | undefined>(undefined);
	const endHold = useCallback(() => {
		window.clearTimeout(settling.current);
		release.current?.();
		release.current = null;
		setHold(null);
	}, []);
	const onComposition = useCallback(
		(composing: boolean) => {
			if (composing) {
				// One that begins right after another is the same hold.
				window.clearTimeout(settling.current);
				if (release.current) return;
				const { promise, resolve } = Promise.withResolvers<void>();
				release.current = resolve;
				setHold(promise);
			} else {
				// Safari ends a composition before the last input event of it: that one lands in the field first.
				settling.current = window.setTimeout(endHold, 0);
			}
		},
		[endHold],
	);
	// A composition does not outlive the popover it was in (its end may never be reported).
	useEffect(() => {
		if (!open) endHold();
	}, [open, endHold]);
	const listRef = useRef<HTMLDivElement>(null);
	const toast = useApp((s) => s.toast);
	const t = useT();
	// A list with models in it is kept for the process. An empty one is not: it is what omp answers while it cannot
	// offer any (#208), which says nothing of the next time, so the picker asks again each time it opens.
	const listed = Boolean(models?.length);
	useEffect(() => {
		if (!open || listed || !liveId) return;
		setModels(null);
		// Opening the list is the user's doing: a paused conversation answers it (and stays paused).
		socket
			.act<{ models: ModelInfo[] }>(liveId, { type: "get_available_models" })
			.then((r) => {
				if (r.models.length) modelCache.set(liveId, r.models);
				setModels(r.models);
			})
			.catch((e) => toast("error", translate("panel.modelListFailed", { error: e.message })));
	}, [open, listed, liveId, toast]);
	// cmdk scrolls only when the highlight moves: bring the highlighted row into view as the list opens, and
	// again when loving it from the keyboard has moved it to the top.
	const centerHighlighted = useCallback(() => {
		const list = listRef.current;
		const row = list?.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]');
		if (list && row) {
			list.scrollTop +=
				row.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - row.offsetHeight) / 2;
		}
	}, []);
	useEffect(() => {
		if (!open || !models) return;
		const frame = requestAnimationFrame(centerHighlighted);
		return () => cancelAnimationFrame(frame);
	}, [open, models, centerHighlighted]);
	const favorites = useApp((s) => s.favoriteModels);
	const label = current ? modelLabel(current) : t("panel.modelFallbackLabel");
	const key = (m: ModelInfo) => `${m.provider}/${m.id}`;
	const fav = new Set(favorites);
	// What this browser used last, read as the list opens (the models are in `models` once omp has answered).
	const [recentKeys, setRecentKeys] = useState<string[]>(recentModels);
	useEffect(() => {
		if (!open) return;
		setRecentKeys(recentModels());
		return onRecentModels((keys) => setRecentKeys([...keys]));
	}, [open]);
	const toggleFavorite = (m: ModelInfo) =>
		sessionActions
			.setFavoriteModel(key(m), !fav.has(key(m)))
			.then((favoriteModels) => useApp.setState({ favoriteModels }))
			.catch((e) => toast("error", e.message));
	return (
		<Popover.Root
			open={open}
			onOpenChange={(o) => {
				request(o);
				if (o) {
					setHighlight(current ? key(current) : "");
					// A new search for a new list: what was typed for the last one is not wanted now.
					setSearch("");
				}
			}}
		>
			<Popover.Trigger asChild>
				<button
					type="button"
					data-testid="model-picker"
					aria-busy={starting}
					title={label}
					// The list's chunk is fetched while the pointer is on the button and when it takes the focus, so
					// that it is usually there by the time the button is pressed.
					onPointerEnter={preloadModelList}
					onFocus={preloadModelList}
					onPointerDown={preloadModelList}
					className="inline-flex h-8 max-w-56 items-center gap-1.5 rounded-lg px-2 text-xs text-muted hover:bg-hover hover:text-fg composer-narrow:w-8 composer-narrow:justify-center composer-narrow:px-0"
				>
					{starting ? <Spinner size={14} className="shrink-0" /> : <Cpu size={14} className="shrink-0" />}
					<span className="truncate composer-narrow:sr-only">{label}</span>
					<ChevronDown size={12} className="shrink-0 composer-narrow:hidden" />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={6}
					aria-label={t("panel.modelChoose")}
					className="z-50 w-80 rounded-xl border border-border bg-surface p-1 shadow-2xl"
				>
					{/*
						A chunk that is gone is a toast, not the Reload screen: the rest of the app stays, the empty popover goes,
						and the next opening asks for the chunk again.
					*/}
					<ErrorBoundary
						fallback={() => null}
						onError={() => {
							retryModelList();
							request(false);
							useApp.getState().toast("error", t("shell.errorModelListLoad"));
						}}
					>
						<Suspense fallback={<ModelSearch value={search} onChange={setSearch} onComposition={onComposition} />}>
							<HeldBy hold={hold}>
								<ModelList
									models={models}
									lovedKeys={favorites}
									recentKeys={recentKeys}
									current={current}
									favorites={fav}
									highlight={highlight}
									search={search}
									onSearchChange={setSearch}
									onHighlightChange={setHighlight}
									onPick={(m) => {
										// Remembered before omp takes it: the list is next opened for a browser that has picked it.
										noteRecentModel(key(m));
										if (!liveId) return;
										socket.act(liveId, { type: "set_model", provider: m.provider, modelId: m.id }).then(
											() => onPick?.({ provider: m.provider, modelId: m.id }),
											(e) => toast("error", e.message),
										);
									}}
									onLove={(m, by) =>
										// The key path moves the loved model to the top, so the list is brought back to the
										// row it points at. A click does not move it, and the list stays where it was.
										void toggleFavorite(m).then(() => {
											if (by === "key") requestAnimationFrame(centerHighlighted);
										})
									}
									onClose={() => request(false)}
									listRef={listRef}
								/>
							</HeldBy>
						</Suspense>
					</ErrorBoundary>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/** omp's thinking levels (`omp --thinking`); one omp does not name here is shown as it reports it. */
export const LEVEL_LABELS: Record<string, MessageKey> = {
	off: "panel.thinkingOff",
	minimal: "panel.thinkingMinimal",
	low: "panel.thinkingLow",
	medium: "panel.thinkingMedium",
	high: "panel.thinkingHigh",
	xhigh: "panel.thinkingXhigh",
	max: "panel.thinkingMax",
	auto: "panel.thinkingAuto",
};

/** A thinking level as a person reads it; `auto` with the level omp resolved it to, when that is given. */
export function levelText(t: (key: MessageKey, vars?: Vars) => string, level: string, resolved?: string): string {
	const name = (l: string) => (Object.hasOwn(LEVEL_LABELS, l) ? t(LEVEL_LABELS[l]) : l);
	return level === "auto" && resolved && resolved !== "auto"
		? t("panel.thinkingAutoResolved", { level: name(resolved) })
		: name(level);
}

/**
 * The composer's thinking-level switcher. `level` is what the conversation is set to (`auto` stays `auto`: see
 * `selectedThinking`) and `resolved` the level omp resolved `auto` to, shown beside it. Without a running omp (`liveId`
 * null: a saved conversation) `level` and `current` are what the transcript leaves, the levels offered are the model's
 * from the catalog when it is at hand (else the usual ones; omp holds a level the model lacks to the nearest it has),
 * and choosing one starts omp (`start`) and sets it: the first click does what it says. omp never lists `auto` among
 * its levels, so it is added (`withAuto`). A paused conversation is not asked for its levels (that would run it for
 * nothing): it offers the same.
 */
export function ThinkingPicker({
	liveId,
	level,
	resolved,
	current,
	start,
	onPick,
}: {
	liveId: string | null;
	level?: string;
	resolved?: string;
	current?: ModelInfo;
	start?: StartLive;
	/** Told which level was set, once omp has taken it: New chat keeps the choice for the processes it starts later. */
	onPick?: (level: string) => void;
}) {
	const [levels, setLevels] = useState<string[] | null>(null);
	/** The level chosen and not confirmed yet: the control shows it at once, also while omp is starting. */
	const [asked, setAsked] = useState<string | null>(null);
	const toast = useApp((s) => s.toast);
	const paused = useApp((s) => Boolean(liveId && s.lives[liveId]?.info.pausedAt));
	// A conversation on a local server picks from that server's models; any other from omp's own list.
	const local = useApp((s) => runsLocal(liveId ? s.lives[liveId]?.info : undefined));
	const catalog = useModelCatalog(false, local ? "local" : "omp");
	const t = useT();
	// Which levels exist depends on the model, so they are asked for when the picker appears and again each time the model changes.
	const model = current ? `${current.provider}/${current.id}` : "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: `model` only triggers the request; it is not one of its inputs.
	useEffect(() => {
		setLevels(null);
		if (!liveId) return;
		let live = true;
		socket
			.rpc<{ levels: string[] }>(liveId, { type: "get_available_thinking_levels" })
			.then((r) => live && setLevels(r.levels))
			// A paused omp is not asked, so it has nothing to say: that is not "no level but off".
			.catch((e) => live && !(e instanceof ReplyError && e.code === "paused") && setLevels(["off"]));
		return () => {
			live = false;
		};
	}, [liveId, model]);
	const offered = withAuto(levels ?? (!liveId || paused ? levelsFor(current, catalog) : []), current);
	const shown = asked ?? level ?? "off";
	const shownLabel = Object.hasOwn(LEVEL_LABELS, shown) ? t(LEVEL_LABELS[shown]) : shown;
	return (
		<label
			title={`${t("panel.thinkingLevel")}: ${shownLabel}`}
			className="relative inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted hover:bg-hover hover:text-fg has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent composer-narrow:w-8 composer-narrow:justify-center composer-narrow:px-0"
		>
			<Brain size={14} />
			<span className="sr-only composer-more:hidden">{t("panel.thinkingLevel")}</span>
			{/* In the "⋯" panel the control says which setting it is, not only its value: "Thinking: Low". */}
			<span aria-hidden className="hidden shrink-0 composer-more:inline">
				{t("panel.thinkingPrefix")}
			</span>
			<Select
				tone="chip"
				fit={levelText(t, shown, shown === "auto" ? resolved : undefined)}
				aria-label={t("panel.thinkingLevel")}
				data-testid="thinking-picker"
				className="cursor-pointer bg-transparent outline-none composer-narrow:absolute composer-narrow:inset-0 composer-narrow:w-full composer-narrow:opacity-0"
				value={shown}
				onValueChange={(next) => {
					setAsked(next);
					void (async () => {
						try {
							const id = liveId ?? (await start?.());
							if (id) {
								await socket.act(id, { type: "set_thinking_level", level: next });
								// Only `auto` is taken as it is: omp holds another level to the nearest the model has, and says which.
								if (next === "auto") noteThinking(id, next);
								onPick?.(next);
							}
						} catch (err) {
							toast("error", (err as Error).message);
						} finally {
							setAsked(null);
						}
					})();
				}}
			>
				{[...new Set([shown, ...offered])].map((l) => (
					<option key={l} value={l} className="bg-surface text-fg">
						{levelText(t, l, l === shown ? resolved : undefined)}
					</option>
				))}
			</Select>
		</label>
	);
}
