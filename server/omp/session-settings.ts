import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { COMPACT_KEYS } from "../../shared/compact-at.ts";
import {
	CLAUDE_SLOW_KEY,
	choiceOf,
	configKey,
	SESSION_DEFAULT_KEYS,
	type SessionSettings,
	UNREPORTED,
} from "../../shared/session-defaults.ts";
import type { Config } from "../config.ts";
import type { Live } from "../live.ts";
import { type ConfigScope, queued, readKeys } from "./model-config.ts";
import { QUICK_MS } from "./run.ts";

/**
 * What a conversation's omp uses of the controls it cannot report (auto-retry, cache warming: see `UNREPORTED`).
 *
 * omp's RPC sets them (`set_auto_retry`, `set_cache_warming`) and never says what a process has. The value a process
 * uses is, from the top: what it was told over RPC (the server keeps that: `Live.noteSessionSetting`), then the files
 * it loaded: the server's overlay (a later file over an earlier one), its own `--config` files, the folder's project
 * config, the agent directory's `config.yml`, and omp's default. The overlay's values are the server's own: it holds
 * them in memory (`ProcessOverlay.settings`), so a temp file taken away from a running process does not take them with
 * it. The rest is what `omp config list` answers, when it is run the way the process was started: in its folder, with
 * its agent directory (Light has one of its own), and given the same `--config` files and `--profile`. omp
 * resolves them with the same code in both, so nothing here repeats its precedence.
 */

/**
 * The settings that hold model selectors, which say whether a Claude model is one the user has set up: the roles, the
 * presets (a name over its roles), the fallback chains (a role or model over the selectors to fall back to) and the
 * models chosen for subagents.
 */
export const MODEL_KEYS = ["modelRoles", "modelPresets", "retry.fallbackChains", "task.agentModelOverrides"] as const;

/**
 * Every setting the panel reads from omp's configuration: what omp cannot report of a process (`UNREPORTED`), what each
 * star would write (`SESSION_DEFAULT_KEYS`, to tell which rows are already the default), and Claude's slow mode with the
 * models that say whether it is one to show (see `readPanelConfig`). One `omp config list --json` has all of them.
 */
const PANEL_KEYS: readonly string[] = [
	...new Set([
		...UNREPORTED.map(configKey),
		...Object.keys(SESSION_DEFAULT_KEYS),
		CLAUDE_SLOW_KEY,
		...MODEL_KEYS,
		// The compaction point ("Compact at") and what can decide over it (see `shared/compact-at.ts`).
		COMPACT_KEYS.percent,
		COMPACT_KEYS.tokens,
		COMPACT_KEYS.reserve,
		COMPACT_KEYS.modelThresholds,
		COMPACT_KEYS.modelThresholdsEnabled,
		// Whether omp goes on with a turn after a compaction (a compact between two steps needs it: see `Live.compactStepUnavailable`).
		COMPACT_KEYS.autoContinue,
	]),
];

/**
 * The panel's settings as omp's configuration has them (`PANEL_KEYS`), by key, for the folder and the way `scope` reads.
 * A read waits behind the writes still waiting, so that what it reads is what was written; a read that has not started
 * is joined by the one that comes for the same view (the panel asks for its settings, and for what its stars say, at once),
 * never one already reading, which may have read the configuration before a change the caller was told about.
 */
const waiting = new Map<string, Promise<Record<string, unknown>>>();
export function listPanelKeys(
	cfg: Config,
	cwd: string,
	scope: ConfigScope,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	const view = `${cwd}\0${JSON.stringify(scope)}`;
	const joined = waiting.get(view);
	if (joined) return joined;
	const read = queued(() => {
		waiting.delete(view);
		return readKeys(cfg.ompBin, cwd, PANEL_KEYS, scope, timeoutMs);
	});
	waiting.set(view, read);
	return read;
}

/**
 * How `omp config` reads and writes the configuration a new conversation of `live`'s process starts with: its agent
 * directory and `--profile`, without the `--config` files the process was given. A write made in any other scope is one
 * the reads never see.
 */
export const defaultsScope = (live: Live): ConfigScope => scopeOf(withoutConfigFiles(live.ownArgs), live.env);

/** `args` without the `--config` files the user gave the process: the configuration a new conversation starts with has none of them. */
export function withoutConfigFiles(args: readonly string[]): string[] {
	const kept: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--") {
			kept.push(...args.slice(i));
			break;
		}
		if (args[i] === "--config") i++;
		else if (!args[i].startsWith("--config=")) kept.push(args[i]);
	}
	return kept;
}

/** The values of the flag `name` (`--name value` or `--name=value`) in `args`, in order. */
export function flagValues(args: readonly string[], name: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		if (arg === name) {
			if (i + 1 < args.length) values.push(args[++i]);
		} else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
	}
	return values;
}

/**
 * How `omp config` is made to read what a process started with `ownArgs` (the flags the user chose, without the
 * server's own) and `env` reads. Its `--config` files go in `PI_CONFIG_FILES` after the ones the environment names, which
 * is the order omp takes them in. The server's overlay is not one of them: it is the last `--config` of the process's
 * command line (`RpcClient`), over every file of the user's, and what it holds is the server's to say (see
 * `configuredSettings`); a file that is not there is an error for omp, which would blank everything. A `--profile` is
 * given as it was to the process, and picks the profile's agent directory.
 */
export function scopeOf(ownArgs: readonly string[], env: Readonly<Record<string, string>>): ConfigScope {
	const files = [
		...(env.PI_CONFIG_FILES ?? process.env.PI_CONFIG_FILES ?? "").split(delimiter).filter(Boolean),
		...flagValues(ownArgs, "--config"),
	];
	// The last one wins, as it does for omp.
	const profile = flagValues(ownArgs, "--profile").at(-1);
	return {
		env: { ...env, ...(files.length > 0 ? { PI_CONFIG_FILES: files.join(delimiter) } : {}) },
		...(profile ? { flags: ["--profile", profile] } : {}),
	};
}

/**
 * What omp's configuration says of the `UNREPORTED` controls for `live`'s process: the settings its overlay holds it at,
 * which it uses over the files it loaded, and for the rest the files it loaded, which it uses wherever it was not told
 * otherwise. omp is asked once, for both controls, in one start (`omp config list --json`), and only for what the
 * overlay does not hold. A control omp could not be asked about (its command failed or took longer than `timeoutMs`) is
 * left out.
 */
export async function configuredSettings(cfg: Config, live: Live, timeoutMs = QUICK_MS): Promise<SessionSettings> {
	const keys = UNREPORTED.map(configKey);
	const cwd = existsSync(live.info.cwd) ? live.info.cwd : cfg.dataDir;
	let listed: Record<string, unknown> = {};
	if (keys.some((key) => !Object.hasOwn(live.overlaySettings, key))) {
		try {
			listed = await listPanelKeys(cfg, cwd, scopeOf(live.ownArgs, live.env), timeoutMs);
		} catch (e) {
			console.error(`omp-webui: could not read ${keys.join(", ")} for ${live.info.liveId}: ${(e as Error).message}`);
		}
	}
	// Looked at after the wait: a default made meanwhile holds this process at what it had, over what omp says now.
	const held = live.overlaySettings;
	const settings: SessionSettings = {};
	for (const setting of UNREPORTED) {
		const key = configKey(setting);
		const choice = choiceOf(setting, Object.hasOwn(held, key) ? held[key] : listed[key]);
		if (choice !== undefined) settings[setting] = choice;
	}
	return settings;
}
