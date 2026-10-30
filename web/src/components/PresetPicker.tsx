import * as Menu from "@radix-ui/react-dropdown-menu";
import { activeFirst, activePreset, nextPreset } from "@shared/model-config.ts";
import { runsLocal } from "@shared/offline.ts";
import { BookmarkPlus, Bot, Check, ChevronDown, CircleAlert, Layers, Lock, Settings2, Star } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { agentFullOpen } from "../lib/agent-full.ts";
import {
	conversationConfig,
	conversationSnapshot,
	describePreset,
	describeSelector,
	modelConfig,
	refreshModelConfig,
	sessionOf,
	switchPreset,
	useModelCatalog,
	useModelConfig,
} from "../lib/model-config.ts";
import { agentsLine } from "../lib/preset-agents.ts";
import { useSavedModels } from "../lib/saved-models.ts";
import type { SavedSettings } from "../lib/session-settings.ts";
import { showSettingsCard } from "../lib/shortcut-view.ts";
import { matches, useShortcutLabel } from "../lib/shortcuts.ts";
import type { StartLive } from "../lib/start-live.ts";
import { useApp } from "../store/app.ts";
import { PresetNameDialog } from "./PresetDialogs.tsx";
import { Badge, cx, Kbd, Spinner } from "./ui.tsx";

// Only a save dialog that is open needs it: the note names the subagent models the preset will be saved with.
const AgentsNote = lazy(() => import("./PresetAgentsNote.tsx"));

const itemCls =
	"flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50";

/**
 * The composer's preset menu: which model preset this conversation is on (or Custom), one click to switch the
 * whole set, saving the current models as a new preset, making them the default for new conversations, and the way
 * to Settings. A switch applies to this conversation (and the subagents it starts) only: the server gives its omp
 * the preset's roles and remembers them for its file, and the global config is left alone — "Set as default" and
 * Settings are what write it. The label and checkmark follow the conversation's own roles: its running omp's, else
 * the ones remembered for a saved conversation (`file`), else the global config.
 * Also owns the shortcut that cycles through the presets while it is on screen. Without a running omp (`liveId`
 * null: a saved conversation) the menu opens all the same, on the model and level the transcript leaves (`saved`),
 * and choosing a preset starts omp (`start`) and switches it.
 */
export function PresetPicker({
	liveId,
	folder: savedFolder,
	file,
	saved,
	start,
	onPick,
}: {
	liveId: string | null;
	/** Where the conversation runs, when no omp tells. */
	folder?: string;
	/** The conversation's session file, which remembers its preset while no omp runs. */
	file?: string | null;
	saved?: SavedSettings;
	start?: StartLive;
	/** Told which preset the conversation was switched to, once it has been: New chat keeps the choice for the processes it starts later. */
	onPick?: (preset: string) => void;
}) {
	const t = useT();
	const cycleHint = useShortcutLabel("presetCycle");
	const toast = useApp((s) => s.toast);
	const live = useApp((s) => (liveId ? s.lives[liveId] : undefined));
	const folder = live?.info.cwd ?? savedFolder ?? "";
	const { config, error } = useModelConfig(folder);
	const savedModels = useSavedModels(file ?? null, !liveId);
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	// Names are only worth a model listing once the menu has been opened. Presets are omp's own, made of the person's own models.
	const models = useModelCatalog(open || saving, "omp");
	const trigger = useRef<HTMLButtonElement>(null);
	const switching = useRef(false);

	// What the conversation was switched to (its running omp's, else the ones remembered for its file); none when never switched.
	const own = liveId ? live?.info.models : savedModels;
	const mine = config ? conversationConfig(config, own) : null;
	const session = sessionOf(live, saved, mine);
	// Presets that differ only in their subagent models match the same roles: the one this conversation was switched to is shown.
	const active = mine ? activePreset(mine, session, own?.preset) : null;
	const label = !mine || mine.presets.length === 0 ? t("presets.trigger") : (active ?? t("presets.custom"));
	// The models' settings could not be read: the chip says so (C8), not only the menu behind it. Its menu has Retry.
	const failed = !config && error ? t("presets.loadFailed", { error }) : null;

	const choose = async (name: string) => {
		if (switching.current) return;
		switching.current = true;
		try {
			const id = liveId ?? (await start?.());
			if (!id) return;
			await switchPreset(id, name);
			onPick?.(name);
			toast("success", t("presets.switched", { name }));
		} catch (e) {
			toast("error", t("presets.switchFailed", { name, error: (e as Error).message }));
		} finally {
			switching.current = false;
		}
	};

	// The only write of the global default from a conversation: what this one runs on becomes what new ones start with.
	// `mine` is read from the conversation's folder, so for a conversation never switched its roles are the global
	// config's with the project's overrides on top; what is written starts from the global config itself, so the
	// project's roles and thinking level stay in the project.
	const setDefault = async () => {
		if (!mine) return;
		try {
			const { roles, defaultThinkingLevel } = conversationSnapshot(
				conversationConfig(await modelConfig.read(), own),
				session,
			);
			// The subagent models a switched conversation brought along become the default's too; one never switched has none.
			const next = await modelConfig.setRoles(roles, defaultThinkingLevel, own?.agentModelOverrides);
			const main = next.roles.default;
			toast(
				"success",
				main ? t("presets.defaultSet", { name: describeSelector(main, models) }) : t("presets.defaultSetPlain"),
			);
		} catch (e) {
			toast("error", t("presets.defaultFailed", { error: (e as Error).message }));
		}
	};

	const local = runsLocal(live?.info);

	// The shortcut acts on what is on screen now; its listener is bound once and reads this.
	const latest = useRef({ config, active, choose, local, none: "" });
	latest.current = { config, active, choose, local, none: t("presets.cycleNone") };
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const now = latest.current;
			if (now.local || e.repeat || e.isComposing || agentFullOpen() || !matches("presetCycle", e)) return;
			e.preventDefault();
			// The shortcut walks the presets in their own order, not the menu's active-first one: that one is re-sorted by each
			// switch, so walking it would go back and forth between the first two presets.
			const next = nextPreset(now.config?.presets ?? [], now.active);
			if (next) void now.choose(next.name);
			else useApp.getState().toast("info", now.none);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// A process on a local server has its own agent directory without presets, and a preset saved from here would hold a
	// local model in the shared config.
	if (local) {
		return (
			<button
				type="button"
				disabled
				data-testid="preset-picker"
				title={t("presets.localNote")}
				aria-label={`${t("presets.menuTitle")}: ${t("presets.localNote")}`}
				className="inline-flex h-8 max-w-44 items-center gap-1.5 rounded-lg px-2 text-xs text-muted opacity-50 composer-narrow:w-8 composer-narrow:justify-center composer-narrow:px-0"
			>
				<Layers size={14} className="shrink-0" />
				<span className="truncate composer-narrow:sr-only" data-testid="preset-label">
					{t("presets.trigger")}
				</span>
			</button>
		);
	}

	return (
		<>
			<Menu.Root
				open={open}
				onOpenChange={(o) => {
					setOpen(o);
					if (o) void refreshModelConfig(folder);
				}}
			>
				<Menu.Trigger asChild>
					<button
						ref={trigger}
						type="button"
						data-testid="preset-picker"
						data-failed={failed ? "" : undefined}
						aria-label={`${t("presets.menuTitle")}: ${failed ?? label}`}
						title={`${t("presets.menuTitle")}: ${failed ?? label}`}
						className={cx(
							"inline-flex h-8 max-w-44 items-center gap-1.5 rounded-lg px-2 text-xs hover:bg-hover hover:text-fg composer-narrow:w-8 composer-narrow:justify-center composer-narrow:px-0",
							failed ? "text-danger" : "text-muted",
						)}
					>
						{failed ? (
							<CircleAlert size={14} className="shrink-0" aria-hidden />
						) : (
							<Layers size={14} className="shrink-0" />
						)}
						<span className="truncate composer-narrow:sr-only" data-testid="preset-label">
							{label}
						</span>
						<ChevronDown size={12} className="shrink-0 composer-narrow:hidden" />
					</button>
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Content
						align="start"
						sideOffset={6}
						collisionPadding={12}
						data-testid="preset-menu"
						className="z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-surface p-1 shadow-2xl"
					>
						<div className="flex items-center justify-between gap-2 px-2 py-1">
							<Menu.Label className="text-xs uppercase text-faint">{t("presets.menuTitle")}</Menu.Label>
							{cycleHint ? (
								<span title={t("shell.shortcutPresetCycle")}>
									<Kbd>{cycleHint}</Kbd>
								</span>
							) : null}
						</div>
						{!config && error ? (
							<>
								<p className="px-2 py-2 text-sm text-danger">{t("presets.loadFailed", { error })}</p>
								<Menu.Item
									className={itemCls}
									onSelect={(e) => {
										e.preventDefault();
										void refreshModelConfig(folder);
									}}
								>
									{t("common.retry")}
								</Menu.Item>
							</>
						) : !config ? (
							<div className="flex justify-center px-2 py-3">
								<Spinner />
							</div>
						) : (
							<>
								{config.presets.length === 0 ? (
									<p className="px-2 py-2 text-sm text-muted">{t("presets.empty")}</p>
								) : null}
								<Menu.RadioGroup value={active ?? ""} className="max-h-80 overflow-y-auto">
									{activeFirst(config.presets, active).map((p) => (
										<Menu.RadioItem
											key={p.name}
											value={p.name}
											disabled={Boolean(p.problem)}
											data-testid="preset-item"
											data-preset={p.name}
											onSelect={() => void choose(p.name)}
											className={itemCls}
										>
											<span className="flex w-4 shrink-0 justify-center">
												<Menu.ItemIndicator>
													<Check size={14} />
												</Menu.ItemIndicator>
											</span>
											<span className="min-w-0 flex-1">
												<span className="flex items-center gap-1.5">
													<span className="truncate font-medium">{p.name}</span>
													{p.name === active ? (
														<span data-testid="preset-active-mark" className="shrink-0">
															<Badge tone="accent">{t("presets.active")}</Badge>
														</span>
													) : null}
													{p.agentModelOverrides && Object.keys(p.agentModelOverrides).length > 0 ? (
														// One mark, the models in its tooltip: a preset that carries them replaces the subagents' on whatever it
														// is applied to, which is worth knowing before the click rather than after it. This menu is its own
														// chunk (the pickers'), so the mark costs the first page nothing. The words are in the item as well,
														// out of sight: a `title` is not announced, and the item's own name is read before the click.
														<span
															className="inline-flex shrink-0 items-center gap-1 text-faint"
															title={t("presets.carriesAgents", { models: agentsLine(p.agentModelOverrides, models) })}
															data-testid="preset-carries-agents"
														>
															<Bot size={11} aria-hidden />
															<span className="sr-only">{t("presets.carriesAgentsShort")}</span>
														</span>
													) : null}
													{p.source === "project" ? (
														<span title={t("presets.projectHint")}>
															<Badge>
																<Lock size={10} /> {t("presets.project")}
															</Badge>
														</span>
													) : null}
												</span>
												<span className={cx("block truncate text-xs", p.problem ? "text-danger" : "text-muted")}>
													{p.problem ? t("presets.unusable", { problem: p.problem }) : describePreset(p, models)}
												</span>
											</span>
										</Menu.RadioItem>
									))}
								</Menu.RadioGroup>
							</>
						)}
						<Menu.Separator className="my-1 h-px bg-border" />
						<Menu.Item
							className={itemCls}
							data-testid="preset-save-current"
							disabled={!config}
							onSelect={() => setSaving(true)}
						>
							<BookmarkPlus size={14} /> {t("presets.saveCurrent")}
						</Menu.Item>
						<Menu.Item
							className={cx(itemCls, "items-start")}
							data-testid="preset-set-default"
							disabled={!mine}
							onSelect={() => void setDefault()}
						>
							<Star size={14} className="mt-0.5 shrink-0" />
							<span className="min-w-0 flex-1">
								<span className="block">{t("presets.setDefault")}</span>
								<span className="block text-xs text-muted">{t("presets.setDefaultHint")}</span>
							</span>
						</Menu.Item>
						<Menu.Item
							className={itemCls}
							data-testid="preset-manage"
							onSelect={() => showSettingsCard('[data-testid="model-presets"]')}
						>
							<Settings2 size={14} /> {t("presets.manage")}
						</Menu.Item>
					</Menu.Content>
				</Menu.Portal>
			</Menu.Root>
			<PresetNameDialog
				open={saving}
				onOpenChange={setSaving}
				title={t("presets.saveTitle")}
				description={t("presets.saveDescription")}
				initial=""
				submitLabel={t("common.save")}
				existing={config?.presets ?? []}
				allowReplace
				returnFocusTo={trigger.current}
				// Rendered, so loaded, only once the dialog is open.
				extra={
					mine && (
						<Suspense>
							<AgentsNote agents={mine.agentModelOverrides} models={models} />
						</Suspense>
					)
				}
				onSubmit={async (name, replace) => {
					if (!mine) throw new Error(t("presets.loadFailed", { error: error ?? "" }));
					// What the conversation runs, not only what the config says: the pickers change the conversation.
					await modelConfig.save({ name, ...conversationSnapshot(mine, session), overwrite: replace });
					toast("success", t("presets.saved", { name }));
				}}
			/>
		</>
	);
}
