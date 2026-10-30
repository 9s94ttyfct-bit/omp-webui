import type { UsageReport } from "../../shared/protocol.ts";
import { QUOTA_TTL_MS } from "../../shared/quota.ts";
import { run } from "./run.ts";

/**
 * Provider usage limits from `omp usage --json` (public CLI). Fetching queries the
 * providers, so results are cached briefly per provider and concurrent callers share
 * one run. A run that does not answer is killed after `RUN_TIMEOUT_MS`: without that, one hung
 * provider call kept every later caller (and the quota pill's countdowns) waiting on it until the
 * server restarted.
 *
 * The cache is a little shorter than the interval the page looks at (`QUOTA_REFRESH_MS`), so a
 * look that is this old is answered from the cache: one `omp usage` per provider per interval,
 * however many conversations and tabs ask (#458).
 */

const TTL_MS = QUOTA_TTL_MS;
/** `omp usage` normally answers in a few seconds; a run past this is stuck on a provider. */
const RUN_TIMEOUT_MS = 20_000;
/** Distinct providers cached at once; omp has a handful, so this only bounds abuse. */
const MAX_CACHED = 32;
const cache = new Map<string, { at: number; reports: UsageReport[] }>();
const inflight = new Map<string, Promise<UsageReport[]>>();

/** A provider id omp could know: never empty-but-set, never flag-shaped. "" means all providers. */
export const isProviderId = (s: string): boolean => s === "" || /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(s);

async function queryReports(bin: string, provider: string, timeoutMs: number): Promise<UsageReport[]> {
	// `--provider=<id>` keeps the value bound to its flag even if validation ever loosens.
	const args = [bin, "usage", "--json", ...(provider ? [`--provider=${provider}`] : [])];
	const { code, stdout, stderr } = await run(args, { timeoutMs });
	if (code !== 0) throw new Error(`omp usage exited ${code}: ${stderr.trim().slice(0, 300)}`);
	const parsed = JSON.parse(stdout) as { reports?: UsageReport[] };
	return parsed.reports ?? [];
}

/**
 * `provider` MUST satisfy {@link isProviderId}; it ends up in omp's argv. `force` starts a run of its own even when
 * one is going: that one began before whatever made the caller ask for fresh numbers, so it may not reflect it.
 * The run it replaces still answers its own callers but no longer fills the cache.
 */
export async function providerUsage(
	bin: string,
	provider: string,
	force = false,
	timeoutMs = RUN_TIMEOUT_MS,
): Promise<UsageReport[]> {
	if (!isProviderId(provider)) throw new Error(`invalid provider id: ${JSON.stringify(provider)}`);
	const hit = cache.get(provider);
	if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.reports;
	const running = inflight.get(provider);
	if (running && !force) return running;
	const p: Promise<UsageReport[]> = queryReports(bin, provider, timeoutMs)
		.then((reports) => {
			if (inflight.get(provider) !== p) return reports;
			cache.delete(provider);
			cache.set(provider, { at: Date.now(), reports });
			// Map iteration is insertion order: drop the least recently refreshed.
			while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
			return reports;
		})
		.finally(() => {
			if (inflight.get(provider) === p) inflight.delete(provider);
		});
	inflight.set(provider, p);
	return p;
}
