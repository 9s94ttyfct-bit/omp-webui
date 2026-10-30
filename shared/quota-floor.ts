/**
 * The quota floor (#652), as the pages see it: the share of a provider's usage window that may be left before work is
 * held, and what a conversation says while it is held.
 *
 * Only what the page needs is here, and on purpose: the first page load carries every byte of this module. The decisions
 * (which windows count, when a hold ends, what warming the cache is worth) are the server's and the extension's
 * (`server/omp/quota-floor/`, `shared/quota-hold.ts`).
 */

/** The lowest and the highest floor, in percent of a window that is left: 0 would hold nothing until the limit, 100 everything. */
export const FLOOR_MIN = 1;
export const FLOOR_MAX = 99;

/** A floor the settings can hold: a whole percent from `FLOOR_MIN` to `FLOOR_MAX`; null for anything else. */
export function floorOf(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= FLOOR_MIN && value <= FLOOR_MAX
		? value
		: null;
}

/** A provider id omp could know (`isProviderId` of `server/omp/usage.ts` without the empty "all providers"). */
export const isFloorProvider = (s: unknown): s is string =>
	typeof s === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(s);

/** What `GET /api/quota-floor` answers, and every change of it: the floor of each provider that has one (percent left). */
export interface QuotaFloorSettings {
	floors: Record<string, number>;
}

/**
 * Where a conversation is in a hold. `armed`: the floor is reached and the request in flight finishes, then the next one
 * waits. `held`: omp is stopped before its next model request (it is not frozen: its own timers, the prompt cache's
 * warming among them, run). `overridden`: the person chose "Continue anyway", and the conversation ignores the floor until
 * the provider is above it again. `unavailable`: the floor is reached but this conversation cannot be held (`reason`).
 */
export type QuotaHoldState = "armed" | "held" | "overridden" | "unavailable";

/** Why a conversation cannot be held: its omp was started with extensions of the person's own, or the server's extension did not start in it. */
export type QuotaHoldReason = "trustedExtension" | "notLoaded";

/**
 * What happens to the prompt cache while a conversation is held. `on`: omp keeps refreshing it until the reset (`pings`
 * refreshes, `warmCost` in dollars, against `rebuildCost` for rebuilding it once). `lapse`: it is let go, because
 * (`why`) refreshing until the reset costs more than rebuilding (`cost`), omp's own limit on refreshing cannot reach the reset
 * (`limit`), the reset time is not known (`reset`), the cache is too small to be worth refreshing (`small`), or omp's own rule
 * stopped it (`omp`). `none`: the cache outlives the hold, nothing is spent. `off`: warming is off for the conversation.
 * `unknown`: omp has not decided yet (it decides before each refresh, the first one some minutes after the last request).
 */
export type CacheWarming = "on" | "lapse" | "none" | "off" | "unknown";
export type CacheWarmingWhy = "cost" | "limit" | "reset" | "small" | "omp";

export interface LiveCacheWarming {
	state: CacheWarming;
	why?: CacheWarmingWhy;
	/** The refreshes still to make until the reset, this one included. */
	pings?: number;
	/** Dollars: all the refreshes until the reset. */
	warmCost?: number;
	/** Dollars: what one rebuild of the cache costs over reading it. */
	rebuildCost?: number;
	/** How many refreshes omp has made since the conversation was held, and what they cost in dollars (what omp billed). */
	refreshes?: number;
	spent?: number;
}

/** What `LiveInfo.quotaHold` says of a conversation that has reached its provider's floor. */
export interface LiveQuotaHold {
	state: QuotaHoldState;
	provider: string;
	/** The provider's floor: percent of a window that is left. */
	floor: number;
	/** The share left, 0–1: the account with the most left, in the window that is nearest to being used up. */
	remaining: number;
	/** omp's label for that window (`5 hour`, `7 day`…), when it gives one. */
	window?: string;
	/** When the window frees up (epoch ms); absent when omp does not say. */
	resetsAt?: number;
	/** When the floor was reached (server clock). */
	since: number;
	warming: LiveCacheWarming;
	reason?: QuotaHoldReason;
}
