import { CONCURRENCY_KEY, ompConcurrencyOf } from "../../shared/subagent-concurrency.ts";
import type { Config } from "../config.ts";
import { ompConfig, queued, readKeys } from "./model-config.ts";
import { QUICK_MS } from "./run.ts";

/**
 * "Parallel subagents" in omp's own global configuration (`task.maxConcurrency`, see `shared/subagent-concurrency.ts`): what
 * `omp config set` writes in the terminal, so the page and the terminal always agree. A conversation's own value is its
 * overlay's (`ProcessOverlay.concurrency`), over this one.
 */

/**
 * omp's own value becomes `limit` (`0`: no limit), or omp's default again (null: the setting is reset, and omp runs with its
 * own default). Serialized with the server's other config writes.
 */
export function configureConcurrency(cfg: Config, limit: number | null): Promise<void> {
	return queued(async () => {
		await ompConfig(
			cfg.ompBin,
			cfg.dataDir,
			limit === null ? ["reset", CONCURRENCY_KEY] : ["set", CONCURRENCY_KEY, String(limit)],
		);
	});
}

/**
 * omp's value as its global configuration resolves it (its default where nothing sets it), read for the server's agent
 * directory. Null when omp could not be asked, so that the page says so rather than guessing.
 */
export async function readConcurrencyDefault(cfg: Config, timeoutMs = QUICK_MS): Promise<number | null> {
	try {
		const listed = await readKeys(cfg.ompBin, cfg.dataDir, [CONCURRENCY_KEY], {}, timeoutMs);
		return ompConcurrencyOf(listed[CONCURRENCY_KEY]);
	} catch (e) {
		console.error(`omp-webui: could not read ${CONCURRENCY_KEY}: ${(e as Error).message}`);
		return null;
	}
}
