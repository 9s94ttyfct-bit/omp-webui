import {
	COMPACT_KEYS,
	type CompactAt,
	type CompactSettings,
	compactSettingsOf,
	modelThresholdOf,
} from "../../shared/compact-at.ts";
import type { Config } from "../config.ts";
import { type ConfigScope, ompConfig, queued, readKeys } from "./model-config.ts";
import { QUICK_MS } from "./run.ts";

/**
 * "Compact at", through omp's own settings: `compaction.thresholdPercent` (a share of the model's window) and
 * `compaction.thresholdTokens` (a count of tokens, which overrides the share) are the point at which omp compacts by
 * itself; `-1` in both is omp's default, the legacy reserve that keeps a part of the window free.
 *
 * A conversation's own point is held by its `--config` overlay, which a running omp reloads about 200 ms after it
 * changes. omp reads the point from its settings at each check — before a turn, during one and after it
 * (`dA(settings, model)` in packages/agent/src/compaction/compaction.ts) — so a change applies from the conversation's
 * next turn, without a restart. The default is omp's own global setting, as `omp config` shows and changes it in the
 * terminal.
 */

/** One `omp config` write of the point, in the scope a conversation reads its configuration in. */
async function configStep(
	cfg: Config,
	scope: ConfigScope,
	verb: "set" | "reset",
	key: string,
	value?: string,
): Promise<void> {
	await ompConfig(cfg.ompBin, cfg.dataDir, value === undefined ? [verb, key] : [verb, key, value], undefined, scope);
}

/**
 * omp's own default for the point becomes `at` (null: omp's default again): the setting that names it is written and the
 * other is reset to `-1`, which omp reads as "not this one" — a leftover count would otherwise override a share, and a
 * leftover share would apply again as soon as the count was cleared. Serialized with the server's other config writes.
 * `scope` is how the conversation's process reads its configuration (`defaultsScope`: its agent directory and
 * `--profile`, without the `--config` files of its own); none for omp's own global configuration.
 */
export function configureCompactAt(cfg: Config, scope: ConfigScope, at: CompactAt | null): Promise<void> {
	return queued(async () => {
		if (at && "percent" in at) {
			await configStep(cfg, scope, "set", COMPACT_KEYS.percent, String(at.percent));
			await configStep(cfg, scope, "reset", COMPACT_KEYS.tokens);
			return;
		}
		if (at && "tokens" in at) {
			await configStep(cfg, scope, "set", COMPACT_KEYS.tokens, String(at.tokens));
			await configStep(cfg, scope, "reset", COMPACT_KEYS.percent);
			return;
		}
		await configStep(cfg, scope, "reset", COMPACT_KEYS.percent);
		await configStep(cfg, scope, "reset", COMPACT_KEYS.tokens);
	});
}

/**
 * omp's own compaction point as its configuration has it, read for the server's agent directory: `-1` in both settings is
 * omp's default (the legacy reserve). Null when omp could not be asked, so that the page says so rather than guessing.
 */
export async function readCompactDefaults(cfg: Config, timeoutMs = QUICK_MS): Promise<CompactSettings | null> {
	try {
		const listed = await readKeys(
			cfg.ompBin,
			cfg.dataDir,
			[COMPACT_KEYS.percent, COMPACT_KEYS.tokens, COMPACT_KEYS.reserve],
			{},
			timeoutMs,
		);
		return compactSettingsOf(listed);
	} catch (e) {
		console.error(`omp-webui: could not read ${COMPACT_KEYS.percent}: ${(e as Error).message}`);
		return null;
	}
}

/**
 * The key of omp's `compaction.modelThresholds` that decides for a conversation's model, if one does: omp applies such an
 * entry over both settings above (and over `reserveTokens`), so where it decides, the conversation uses that rather than
 * what this page writes. Null when the record is off, or nothing in it matches.
 */
export function decidingModelThreshold(
	listed: Readonly<Record<string, unknown>>,
	selector: string | null | undefined,
): string | null {
	if (listed[COMPACT_KEYS.modelThresholdsEnabled] === false) return null;
	return modelThresholdOf(listed[COMPACT_KEYS.modelThresholds], selector)?.key ?? null;
}
