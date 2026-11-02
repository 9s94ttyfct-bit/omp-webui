import { ADVISOR_KEY } from "../../shared/advisor.ts";
import type { Config } from "../config.ts";
import { readKeys } from "./model-config.ts";
import { QUICK_MS } from "./run.ts";

/**
 * Whether omp's own configuration runs the advisor (`advisor.enabled`, see `shared/advisor.ts`), read for the server's
 * agent directory: what New chat's switch starts at, where the person has not flipped it. omp's own default (off) where
 * nothing sets it; null when omp could not be asked, so that the page says nothing rather than guess.
 */
export async function readAdvisorDefault(cfg: Config, timeoutMs = QUICK_MS): Promise<boolean | null> {
	try {
		const listed = await readKeys(cfg.ompBin, cfg.dataDir, [ADVISOR_KEY], {}, timeoutMs);
		const value = listed[ADVISOR_KEY];
		return typeof value === "boolean" ? value : null;
	} catch (e) {
		console.error(`omp-webui: could not read ${ADVISOR_KEY}: ${(e as Error).message}`);
		return null;
	}
}
