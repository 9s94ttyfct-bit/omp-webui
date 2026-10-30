import { existsSync } from "node:fs";
import { type CompactSettings, compactSettingsOf } from "../../shared/compact-at.ts";
import {
	CLAUDE_SLOW_KEY,
	type ClaudeSlowMode,
	type ConfigValue,
	SESSION_DEFAULT_KEYS,
} from "../../shared/session-defaults.ts";
import type { Config } from "../config.ts";
import type { Live } from "../live.ts";
import { decidingModelThreshold } from "./compact-at.ts";
import { ompConfig, queued } from "./model-config.ts";
import { QUICK_MS } from "./run.ts";
import { defaultsScope, listPanelKeys, MODEL_KEYS } from "./session-settings.ts";

/**
 * What omp's configuration says that the session controls show next to what omp's `get_state` reports, read in one
 * `omp config list --json` (shared with the controls omp cannot report, see `listPanelKeys`) the way the conversation's
 * process was started.
 */

/** The strings among the values of `value` (a role's selector, a preset's roles, a chain's selectors), at any depth; never a key. */
function* stringsOf(value: unknown): Generator<string> {
	if (typeof value === "string") yield value;
	else if (Array.isArray(value)) for (const item of value) yield* stringsOf(item);
	else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) yield* stringsOf(item);
}

/**
 * Whether `config` (the model settings as omp lists them: see `MODEL_KEYS`) selects a model of Anthropic's own: a selector
 * is `provider/model`, so `anthropic/…` is direct (OpenRouter, Bedrock or a proxy route a Claude model under another
 * provider, which is not the lane `providers.anthropic.slowMode` is for). Only selectors count: not a preset's name, a
 * role's name, nor a setting that merely mentions Claude.
 */
export function namesClaude(config: Record<string, unknown>): boolean {
	for (const key of MODEL_KEYS)
		for (const text of stringsOf(config[key]))
			if (text.split(",").some((selector) => /^anthropic\//i.test(selector.trim()))) return true;
	return false;
}

/** A setting's value where it is the scalar a default writes. */
const scalar = (value: unknown): ConfigValue | undefined =>
	typeof value === "string" || typeof value === "boolean" ? value : undefined;

export interface PanelConfig {
	/**
	 * Where omp compacts for a conversation with the settings its configuration has, and what of its own can decide over
	 * them: the per-model threshold that applies to the conversation's model, if one does (its settings would not be what
	 * the conversation uses). Null `compact` when it could not be read.
	 */
	compact: CompactPanel | null;
	/**
	 * Claude's slow mode (`providers.anthropic.slowMode`: `auto` or `off`) as omp's configuration has it, for a conversation
	 * whose active model may be of another provider (so `get_state`, which speaks of the active model only, cannot say).
	 * `null` where there is nothing to show: no Claude model among the roles and presets, or a setting omp gave no known value.
	 */
	claudeSlow: ClaudeSlowMode | null;
	/**
	 * What a new conversation in the folder starts with, for each setting a star writes: omp's configuration resolved for
	 * the folder, the agent directory and the profile, without this process's own `--config` files or what it was told over
	 * RPC (its overlay). `null` where it could not be read, and for a Light conversation (its omp reads an agent
	 * directory of its own, which is no default of omp's).
	 */
	defaults: Record<string, ConfigValue> | null;
}

/** Where omp compacts as a conversation's configuration has it, and what omp's per-model record says over it. */
export interface CompactPanel {
	settings: CompactSettings;
	/** The `compaction.modelThresholds` key that decides for the conversation's model, if one does (see `decidingModelThreshold`). */
	modelThreshold: string | null;
}

/** What the panel shows from omp's configuration for `live`'s process (see `PanelConfig`). */
export async function readPanelConfig(cfg: Config, live: Live, timeoutMs = QUICK_MS): Promise<PanelConfig> {
	if (live.info.mode === "light") return { claudeSlow: null, defaults: null, compact: null };
	const cwd = existsSync(live.info.cwd) ? live.info.cwd : cfg.dataDir;
	try {
		const listed = await listPanelKeys(cfg, cwd, defaultsScope(live), timeoutMs);
		const slow = listed[CLAUDE_SLOW_KEY];
		const defaults: Record<string, ConfigValue> = {};
		for (const key of Object.keys(SESSION_DEFAULT_KEYS)) {
			const value = scalar(listed[key]);
			if (value !== undefined) defaults[key] = value;
		}
		return {
			claudeSlow: namesClaude(listed) ? (slow === "auto" ? "on" : slow === "off" ? "off" : null) : null,
			defaults,
			compact: {
				settings: compactSettingsOf(listed),
				modelThreshold: decidingModelThreshold(listed, live.currentModel()),
			},
		};
	} catch (e) {
		console.error(`omp-webui: could not read the panel's settings for ${live.info.liveId}: ${(e as Error).message}`);
		return { claudeSlow: null, defaults: null, compact: null };
	}
}

/** Make Claude's slow mode on (`auto`) or off in omp's global configuration, as `omp config set` does in the terminal. */
export function setClaudeSlowMode(cfg: Config, live: Live, enabled: boolean): Promise<void> {
	return queued(async () => {
		// In the scope the panel reads it in (`readPanelConfig`): a conversation under a `--profile` has its own agent directory.
		await ompConfig(
			cfg.ompBin,
			cfg.dataDir,
			["set", CLAUDE_SLOW_KEY, enabled ? "auto" : "off"],
			undefined,
			defaultsScope(live),
		);
	});
}
