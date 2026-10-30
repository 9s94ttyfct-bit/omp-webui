import {
	type ConversationModels,
	currentRoles,
	type DefaultThinkingLevel,
	isDefaultThinkingLevel,
	type ModelConfig,
	type ModelPreset,
	parseSelector,
	presetPatternProblem,
	type SessionModel,
} from "@shared/model-config.ts";
import { type ModeState, runsLocal } from "@shared/offline.ts";
import type { LiveInfo } from "@shared/protocol.ts";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { t } from "../i18n/index.ts";
import { useApp } from "../store/app.ts";
import type { LiveState, ModelInfo } from "../store/live.ts";
import { api } from "./api.ts";
import { modelLabel, type StartConfig, selectedThinking } from "./models.ts";
import { useMode } from "./offline.ts";
import type { SavedSettings } from "./session-settings.ts";
import { socket } from "./ws.ts";

/**
 * Model roles and presets as the web UI holds them: the server's `/api/model-config` (omp's own config, read and
 * written through `omp config`), kept per folder — `""` is the global config, a path adds that project's presets
 * — and refreshed after every write, when omp reports a config change, and whenever a view is shown.
 */

export class ConfigRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export async function request(path: string, body?: unknown): Promise<ModelConfig> {
	const res = await fetch(
		path,
		body === undefined
			? undefined
			: {
					method: "POST",
					headers: { "content-type": "application/json", "x-omp-webui": "1" },
					body: JSON.stringify(body),
				},
	);
	const data = await res.json().catch(() => ({ error: res.statusText }));
	if (!res.ok) throw new ConfigRequestError(data.error ?? res.statusText, res.status);
	return data;
}

interface View {
	config: ModelConfig | null;
	error: string | null;
}

const useViews = create<{ views: Record<string, View> }>(() => ({ views: {} }));
/** Folders some mounted component shows, with how many; they are refetched after a write. */
const mounted = new Map<string, number>();
/** The newest request per folder: an older answer arriving later must not replace a newer one. */
const newest = new Map<string, number>();

function setView(folder: string, view: View): void {
	useViews.setState((s) => ({ views: { ...s.views, [folder]: view } }));
}

export function refreshModelConfig(folder = ""): Promise<void> {
	const seq = (newest.get(folder) ?? 0) + 1;
	newest.set(folder, seq);
	return request(folder ? `/api/model-config?cwd=${encodeURIComponent(folder)}` : "/api/model-config").then(
		(config) => {
			if (newest.get(folder) === seq) setView(folder, { config, error: null });
		},
		(e: Error) => {
			if (newest.get(folder) === seq)
				setView(folder, { config: useViews.getState().views[folder]?.config ?? null, error: e.message });
		},
	);
}

/** Refetch every view a component is showing: omp's config changed, or the tab is back in front. */
export function refreshModelConfigs(): void {
	for (const folder of mounted.keys()) void refreshModelConfig(folder);
}

let listening = false;
/**
 * Once, when the first view is shown. omp saves a config change in the background a moment after making it,
 * so the server watches omp's config.yml and says when it was written (`model_config_changed`); that is when a
 * read sees the change. A conversation's `config_update` frame and the tab coming back to the front refetch too
 * (a project's config is not watched).
 */
function listen(): void {
	if (listening) return;
	listening = true;
	socket.on((m) => {
		if (m.t === "model_config_changed" || (m.t === "frame" && m.frame.type === "config_update")) refreshModelConfigs();
	});
	window.addEventListener("focus", refreshModelConfigs);
}

/** A write answered with the new global configuration: show it, and refetch the project views it may have changed. */
export function wrote(config: ModelConfig): ModelConfig {
	newest.set("", (newest.get("") ?? 0) + 1);
	setView("", { config, error: null });
	for (const folder of mounted.keys()) if (folder !== "") void refreshModelConfig(folder);
	return config;
}

/** The configuration of `folder` (a conversation's working folder, or `""` for the global config), kept current. */
export function useModelConfig(folder = ""): { config: ModelConfig | null; error: string | null } {
	const view = useViews((s) => s.views[folder]);
	useEffect(() => {
		listen();
		mounted.set(folder, (mounted.get(folder) ?? 0) + 1);
		void refreshModelConfig(folder);
		return () => {
			const left = (mounted.get(folder) ?? 1) - 1;
			if (left > 0) mounted.set(folder, left);
			else mounted.delete(folder);
		};
	}, [folder]);
	return { config: view?.config ?? null, error: view?.error ?? null };
}

export const modelConfig = {
	save: (input: {
		name: string;
		roles?: Record<string, string>;
		defaultThinkingLevel?: string;
		agentModelOverrides?: Record<string, string>;
		overwrite?: boolean;
	}) => request("/api/model-config/preset/save", input).then(wrote),
	setRoles: (
		roles: Record<string, string>,
		defaultThinkingLevel?: string,
		agentModelOverrides?: Record<string, string>,
	) => request("/api/model-config/roles", { roles, defaultThinkingLevel, agentModelOverrides }).then(wrote),
	/** The roles and presets as they are in omp's config now. */
	read: () => request("/api/model-config"),
};

// ------------------------------------------------------------------ model names

/**
 * Which list of models a component names models from. `omp`: omp's own list (the roles and presets edited in Settings are
 * omp's, and so are the models of Full and of Light with the person's own models). `local`: the models the local server of
 * Light's models serves, which a conversation that runs on one picks from.
 */
export type CatalogScope = "omp" | "local";

/** Names the list a scope gives now: the lists of two scopes (or two backends, or two addresses of one) are never mixed up. */
function catalogKey(scope: CatalogScope, mode: ModeState | null): string {
	if (scope === "omp" || !mode) return "omp";
	const { backend } = mode.offline;
	return `local:${backend}:${mode.backends[backend].baseUrl ?? ""}`;
}

/** What was loaded, per list, and when: a list is kept for a minute (the server keeps its own for as long). */
const catalogs = new Map<string, { at: number; models: ModelInfo[] }>();
const loading = new Map<string, Promise<ModelInfo[]>>();

/** The models of `scope` (`/api/models`), shared by every component that names one. */
export function loadModelCatalog(scope: CatalogScope = "omp"): Promise<ModelInfo[]> {
	const key = catalogKey(scope, useMode.getState().state);
	const kept = catalogs.get(key);
	if (kept && Date.now() - kept.at < 60_000) return Promise.resolve(kept.models);
	let pending = loading.get(key);
	if (!pending) {
		pending = api
			.models(scope === "local")
			.then((models) => {
				catalogs.set(key, { at: Date.now(), models });
				return models;
			})
			.finally(() => {
				loading.delete(key);
			});
		loading.set(key, pending);
	}
	return pending;
}

/**
 * The model catalog once it has loaded; null until then, while `enabled` is false, or when omp cannot list models.
 * Listing starts a short-lived omp, so a component that only needs names when something opens waits to ask. A list
 * loaded for another scope (or another local server) is not returned: the list is asked for again when it changes.
 */
export function useModelCatalog(enabled = true, scope: CatalogScope = "omp"): ModelInfo[] | null {
	const key = useMode((s) => catalogKey(scope, s.state));
	const [loaded, setLoaded] = useState<{ key: string; models: ModelInfo[] } | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let alive = true;
		loadModelCatalog(scope)
			.then((models) => alive && setLoaded({ key, models }))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [enabled, key, scope]);
	return loaded?.key === key ? loaded.models : (catalogs.get(key)?.models ?? null);
}

/**
 * What a conversation runs now: its model and thinking level (`auto` while it is set to that, not the level it resolved
 * to: a preset saved from it keeps `auto`). Until omp reports them (none runs yet, or its first `get_state` has not
 * arrived) they are what the transcript leaves (`saved`), which is what omp resumes with.
 */
export function sessionOf(
	live: LiveState | undefined,
	saved?: SavedSettings,
	config?: StartConfig | null,
): SessionModel {
	const model = live?.state?.model ?? saved?.model;
	return {
		model: model ? `${model.provider}/${model.id}` : undefined,
		thinking: selectedThinking(live, saved?.thinking, config).selected,
	};
}

/** A selector as a person reads it: the model's name (its id until the catalog is known) and thinking level. */
export function describeSelector(selector: string, models: ModelInfo[] | null): string {
	const parsed = parseSelector(selector);
	if (!parsed) return selector;
	const model = models?.find((m) => m.provider === parsed.provider && m.id === parsed.id);
	const name = model ? modelLabel(model) : parsed.id;
	return parsed.level ? `${name} · ${parsed.level}` : name;
}

/** One line for a preset: its default model and thinking level, and how many other roles it sets. */
export function describePreset(p: ModelPreset, models: ModelInfo[] | null): string {
	const others = Object.keys(p.roles).filter((role) => role !== "default").length;
	const selector = p.roles.default;
	let main = t("presets.summaryNoDefault");
	if (selector) {
		main = describeSelector(selector, models);
		if (p.defaultThinkingLevel && parseSelector(selector)?.level === undefined) main += ` · ${p.defaultThinkingLevel}`;
	}
	return others > 0 ? `${main} · ${t("presets.summaryMore", { n: others })}` : main;
}

// ------------------------------------------------------------------ switching a conversation

/** What a conversation's preset menu works from: the roles, subagent models and thinking level it runs on, and the presets it can pick. */
export type ConversationConfig = Pick<
	ModelConfig,
	"roles" | "agentModelOverrides" | "defaultThinkingLevel" | "presets"
>;

/**
 * The roles of one conversation. A preset switch applies to that conversation only, so once it has `models` (its
 * running omp's, else the ones remembered for its file) those are its roles, and its thinking level when they carry
 * one; everything else (a conversation never switched, and the preset list) is the config as it is.
 */
export function conversationConfig(
	config: ModelConfig,
	models: ConversationModels | null | undefined,
): ConversationConfig {
	if (!models) return config;
	return {
		roles: models.roles,
		agentModelOverrides: models.agentModelOverrides ?? config.agentModelOverrides,
		defaultThinkingLevel: models.defaultThinkingLevel ?? config.defaultThinkingLevel,
		presets: config.presets,
	};
}

/**
 * The configuration a conversation's process started with (its own roles when it was switched to a preset, else the
 * global config of its folder), which says whether it started on `auto` (see `startedOnAuto`); null until it is read, and
 * without a process.
 */
export function useStartConfig(live: LiveState | undefined): ConversationConfig | null {
	const { config } = useModelConfig(live?.info.cwd ?? "");
	return live && config ? conversationConfig(config, live.info.models) : null;
}

/** `useStartConfig` for code that is not a component: the config of the process's folder as it is now, read afresh. */
export async function loadStartConfig(live: LiveState): Promise<ConversationConfig | null> {
	await refreshModelConfig(live.info.cwd);
	const config = useViews.getState().views[live.info.cwd]?.config;
	return config ? conversationConfig(config, live.info.models) : null;
}

/**
 * What "Save current as…" and "Set as default" store for a conversation: its own roles, with the default role following the
 * model it runs now (see `currentRoles`) — never the global config's roles — its thinking level and its subagent models.
 */
export function conversationSnapshot(
	mine: ConversationConfig,
	session?: SessionModel,
): {
	roles: Record<string, string>;
	defaultThinkingLevel?: DefaultThinkingLevel;
	agentModelOverrides: Record<string, string>;
} {
	return {
		roles: currentRoles(mine, session),
		defaultThinkingLevel: isDefaultThinkingLevel(mine.defaultThinkingLevel) ? mine.defaultThinkingLevel : undefined,
		agentModelOverrides: mine.agentModelOverrides,
	};
}

/**
 * Switch one conversation to a preset: the server puts the preset's roles in that conversation's omp only (and its
 * subagents'), changes its model at once, and remembers the choice; the global config is not touched. It answers
 * with the process's info, which carries the preset (`models`); a refusal comes back as an error in the server's words.
 */
export async function switchPreset(liveId: string, name: string): Promise<void> {
	// A process on a local server runs on its own agent directory, which has no presets.
	if (runsLocal(useApp.getState().lives[liveId]?.info)) throw new Error(t("presets.localNote"));
	// Only names omp itself accepts (its pattern; it has no length cap).
	if (presetPatternProblem(name)) throw new Error(t("presets.switchFailed", { name, error: t("presets.nameInvalid") }));
	const info = await socket.request<LiveInfo>({ t: "model_preset", liveId, name });
	useApp.setState((s) => {
		const live = s.lives[liveId];
		if (!live) return {};
		// The process runs the preset's model now, and that is what the menu compares the preset with. omp's own state
		// says so only once it is read again (a frame asks for it, and a slow connection delivers it late): until then
		// it names the model the conversation had, so no preset reads as the one in use and the menu says Custom.
		const selector = info.models?.roles.default ? parseSelector(info.models.roles.default) : null;
		const model = live.state?.model;
		const state =
			live.state && selector && !(model?.provider === selector.provider && model.id === selector.id)
				? { ...live.state, model: modelNamed(selector.provider, selector.id) }
				: live.state;
		return { lives: { ...s.lives, [liveId]: { ...live, info, state } } };
	});
}

/** The model `provider`/`id` as the page knows it: the catalog's entry, else what its name says. */
function modelNamed(provider: string, id: string): ModelInfo {
	for (const { models } of catalogs.values()) {
		const known = models.find((m) => m.provider === provider && m.id === id);
		if (known) return known;
	}
	return { provider, id };
}
